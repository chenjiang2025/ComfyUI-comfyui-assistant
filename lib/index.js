/**
 * comfyui-assistant — host half.
 *
 * Registers the ComfyUI tool family and a short system-prompt section, plus a
 * settings card (the exported `Config` schema is the plugin's own config page
 * under the Plugins manager). Everything talks to ComfyUI over plain HTTP;
 * there is no browser half and no build step.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import {
  CancelledError,
  ComfyUIClient,
  ComfyUIError,
  TimeoutError,
  formatBytes,
  normalizeBaseUrl,
} from './comfyui.js'
import { DEFAULT_GUIDE_TOPIC, GUIDE_TOPICS, guideFor } from './guide.js'
import { TEMPLATES, templateWorkflow } from './templates.js'

/** Stable cordis plugin name (matches cordis.patch.yml insert id). */
export const name = 'comfyui-assistant'

/** Services that must exist before the tools and prompt section can mount. */
export const inject = ['tools', 'systemPrompt']

/** Position of the guidance section inside the tool-guidance band. */
const SECTION_ORDER = 2550

/** Folder (inside the session workspace) that receives downloaded outputs. */
const DEFAULT_OUTPUT_FOLDER = 'comfyui-output'

/** Model folders summarized when the caller does not name one. */
const CORE_MODEL_FOLDERS = [
  'checkpoints',
  'diffusion_models',
  'unet',
  'text_encoders',
  'clip',
  'vae',
  'loras',
  'controlnet',
  'upscale_models',
  'embeddings',
  'clip_vision',
  'style_models',
]

const ConfigFields = {
  announceToAgent: z
    .boolean()
    .default(true)
    .description('在系统提示中加入本插件说明。关闭后模型不会再被告知这些工具，但工具本身仍可用。'),
  baseUrl: z
    .string()
    .default('http://127.0.0.1:8188')
    .description('ComfyUI 服务地址，例如 http://127.0.0.1:8188；远程服务改成对应 IP/端口。'),
  requestTimeoutMs: z
    .number()
    .min(1000)
    .max(600000)
    .default(30000)
    .description('普通请求（状态、模型列表、节点查询、上传）的超时，单位毫秒。'),
  runTimeoutMs: z
    .number()
    .min(5000)
    .max(86400000)
    .default(600000)
    .description('等待一次生成完成的最长时间，单位毫秒。超时后返回 prompt_id，任务仍可能继续执行。'),
  saveOutputs: z
    .boolean()
    .default(true)
    .description('把生成的图片下载到会话工作区，便于在对话里直接预览。'),
  outputFolder: z
    .string()
    .default(DEFAULT_OUTPUT_FOLDER)
    .description('工作区内的输出子目录（相对路径；留空表示工作区根目录）。'),
  inlineImages: z
    .boolean()
    .default(true)
    .description('把生成的图片同时作为附件发到对话里（DSH 0.2.x 的附件服务），仍然会保存到工作区。'),
}

/** Plugin config = the settings card rendered by the Plugins manager. */
export const Config = z.object({
  announceToAgent: ConfigFields.announceToAgent.volatile(),
  baseUrl: ConfigFields.baseUrl.volatile(),
  requestTimeoutMs: ConfigFields.requestTimeoutMs.volatile(),
  runTimeoutMs: ConfigFields.runTimeoutMs.volatile(),
  saveOutputs: ConfigFields.saveOutputs.volatile(),
  outputFolder: ConfigFields.outputFolder.volatile(),
  inlineImages: ConfigFields.inlineImages.volatile(),
})

/** Model-facing announcement: what this plugin is and how to collaborate. */
const GUIDANCE = [
  '## ComfyUI 助手（comfyui-assistant 插件）',
  '本机已安装 comfyui-assistant：把本地/远程 ComfyUI 接到 DSH 里，默认服务地址 http://127.0.0.1:8188（可在「插件管理页 → comfyui-assistant」配置卡片里改 baseUrl、超时、输出目录）。',
  '可用工具：',
  '- comfyui_status：连通性、ComfyUI 版本、显卡/显存、队列长度。',
  '- comfyui_list_models：列模型文件（checkpoints / diffusion_models / text_encoders / vae / loras …），可带 query 过滤。',
  '- comfyui_search_nodes / comfyui_node_schema：按关键词找节点类名，查某节点的输入名、类型、默认值、可选值。',
  '- comfyui_validate_workflow：不跑图，先静态预检工作流（class_type 是否存在、必填输入、连线、模型文件名、枚举取值、残留占位符）。',
  '- comfyui_run_workflow：提交 **API 格式** 工作流（template 内置模板 / workflow 文件或 JSON / substitutions / overrides / input_image），等待完成并把图片存到工作区，同时作为附件内联显示。',
  '- comfyui_queue：status / history / interrupt / clear / delete / free。',
  '- comfyui_upload_image：把工作区图片上传到 ComfyUI input 目录（图生图、编辑工作流）。',
  '- comfyui_workflows：list / get / save / delete 自建工作流（~/.dsh/comfyui-assistant/workflows）。',
  '- comfyui_guide：内置手册（overview / api / workflow / nodes / templates / debug / models / prompting / performance）。',
  '协作铁律：',
  '1. 写工作流前先查：模型文件名用 comfyui_list_models 核对，节点输入用 comfyui_node_schema 核对；提交前先 comfyui_validate_workflow 预检，不要凭记忆编造 class_type 或输入名。',
  '2. 只接受 API 格式工作流；优先从内置模板改参数（comfyui_guide topic=templates），而不是从零手写。',
  '3. 生成可能很慢（低显存机器几十秒到数分钟）：默认同步等待；超时会返回 prompt_id，此时不要重复提交，用 comfyui_queue 查状态。',
  '4. 出图后会同时保存到工作区并作为附件内联显示；回报实际使用的 seed 便于复现。',
  '5. 用户提到 ComfyUI / 出图 / 工作流 / 节点 / 模型 / 显存 时，默认走这些工具，而不是猜 API 或让用户手动操作。',
].join('\n')

/** Read the volatile config refs into a plain options object. */
function readConfig(config) {
  const read = (field, fallback) => {
    const ref = config?.[field]
    const value = ref !== undefined && typeof ref.get === 'function' ? ref.get() : ref
    return value === undefined || value === null ? fallback : value
  }
  return {
    announceToAgent: read('announceToAgent', true) !== false,
    baseUrl: normalizeBaseUrl(read('baseUrl', 'http://127.0.0.1:8188')),
    requestTimeoutMs: Number(read('requestTimeoutMs', 30000)) || 30000,
    runTimeoutMs: Number(read('runTimeoutMs', 600000)) || 600000,
    saveOutputs: read('saveOutputs', true) !== false,
    outputFolder: String(read('outputFolder', DEFAULT_OUTPUT_FOLDER)),
    inlineImages: read('inlineImages', true) !== false,
  }
}

/** Resolve the session working directory (falls back to the host process cwd). */
async function workspaceRoot(ctx, exec) {
  const workingDirectory = ctx.get?.('workingDirectory')
  if (workingDirectory !== undefined && exec?.agent !== undefined && typeof workingDirectory.ensure === 'function') {
    try {
      const dir = await workingDirectory.ensure(exec.agent)
      if (typeof dir === 'string' && dir !== '') return dir
    } catch {
      // A vanished project directory is not fatal for output saving.
    }
  }
  const fromEnv = process.env.DSH_WORKSPACE
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return process.cwd()
}

/** Resolve a user-supplied path against the workspace. */
function resolveUserPath(cwd, input) {
  const value = String(input ?? '').trim()
  if (value === '') throw new Error('路径不能为空')
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value)
}

/** Reject output folders that would escape the workspace. */
function safeOutputFolder(folder) {
  const value = String(folder ?? '').trim().replace(/\\/gu, '/')
  if (value === '') return ''
  if (isAbsolute(value)) throw new Error('outputFolder 必须是工作区内的相对子目录')
  const segments = value.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.some((segment) => segment === '..')) throw new Error('outputFolder 不允许包含 ".."')
  return segments.join('/')
}

/** Make a file name safe for the workspace copy. */
function safeFileName(name) {
  return String(name).replace(/[^\w.\-]+/gu, '_').slice(0, 160)
}

/** POSIX-style path relative to the workspace, for markdown display. */
function displayPath(cwd, absolutePath) {
  const rel = relative(cwd, absolutePath)
  if (rel === '') return basename(absolutePath)
  return rel.split(sep).join('/')
}

/** Format a millisecond duration. */
function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '未知'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** Directory that holds user-saved workflows. */
function workflowDir() {
  return join(homedir(), '.dsh', 'comfyui-assistant', 'workflows')
}

/** Parse possibly-inline workflow JSON; anything else is treated as a path/name. */
function looksLikeJson(text) {
  const trimmed = text.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

/**
 * Validate that a parsed value is an API-format workflow.
 * @returns {string | undefined} an actionable problem, or undefined when valid.
 */
function validateWorkflow(workflow) {
  if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)) {
    return '工作流必须是 JSON 对象：键是节点 id（字符串），值是 { class_type, inputs }。这看起来不是 API 格式。'
  }
  if (Array.isArray(workflow.nodes) || Array.isArray(workflow.links)) {
    return '这是 ComfyUI 前端的 UI 格式（nodes/links 数组）；请在 ComfyUI 里用「导出 (API)」得到 API 格式后再提交。'
  }
  const entries = Object.entries(workflow)
  if (entries.length === 0) return '工作流是空对象。'
  for (const [nodeId, node] of entries) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return `节点 ${nodeId} 不是对象。`
    if (typeof node.class_type !== 'string' || node.class_type.trim() === '') {
      return `节点 ${nodeId} 缺少 class_type（节点类名）。`
    }
    if (node.inputs !== undefined && (node.inputs === null || typeof node.inputs !== 'object' || Array.isArray(node.inputs))) {
      return `节点 ${nodeId} 的 inputs 必须是对象。`
    }
  }
  return undefined
}

/**
 * Resolve the target of comfyui_run_workflow / comfyui_validate_workflow:
 * a built-in template, inline JSON, a .json path, or a saved workflow name.
 * @returns {Promise<{workflow?: object, templateName?: string, error?: string, tried?: string[]}>}
 */
async function resolveWorkflowInput(args, cwd) {
  const templateName = typeof args.template === 'string' ? args.template.trim() : ''
  if (templateName !== '') {
    const workflow = templateWorkflow(templateName)
    if (workflow === undefined) {
      return { error: `未知模板：${templateName}`, tried: Object.keys(TEMPLATES) }
    }
    return { workflow, templateName }
  }
  const text = typeof args.workflow === 'string' ? args.workflow.trim() : ''
  if (text === '') return { error: '必须提供 template 或 workflow 之一', tried: Object.keys(TEMPLATES) }
  if (looksLikeJson(text)) {
    try {
      return { workflow: JSON.parse(text) }
    } catch (error) {
      return { error: `工作流 JSON 解析失败：${error?.message ?? error}` }
    }
  }
  const candidates = []
  if (isAbsolute(text)) candidates.push(text)
  candidates.push(resolve(cwd, text))
  candidates.push(resolve(workflowDir(), text.endsWith('.json') ? text : `${text}.json`))
  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, 'utf8')
      try {
        return { workflow: JSON.parse(raw) }
      } catch (error) {
        return { error: `工作流文件不是合法 JSON（${candidate}）：${error?.message ?? error}` }
      }
    } catch {
      // try the next candidate
    }
  }
  return { error: `找不到工作流文件：${text}`, tried: candidates }
}

/** Deep substitution of {{token}} placeholders; numeric tokens stay numbers. */
function substitute(value, values) {
  if (Array.isArray(value)) return value.map((item) => substitute(item, values))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = substitute(item, values)
    return out
  }
  if (typeof value !== 'string') return value
  const exact = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/u.exec(value)
  if (exact !== null) {
    const key = exact[1]
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : value
  }
  return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/gu, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  )
}

/** Apply per-node input overrides, validating node ids up front. */
function applyOverrides(workflow, overrides) {
  if (overrides === undefined || overrides === null) return []
  if (typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('overrides 必须是「节点id → {输入名: 值}」对象')
  const applied = []
  for (const [nodeId, inputs] of Object.entries(overrides)) {
    const node = workflow[nodeId]
    if (node === undefined) throw new Error(`overrides 指向不存在的节点 ${nodeId}`)
    if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
      throw new Error(`overrides[${nodeId}] 必须是输入对象`)
    }
    node.inputs = { ...(node.inputs ?? {}), ...inputs }
    applied.push(nodeId)
  }
  return applied
}

/** Extract one execution_error payload from history status messages. */
function executionErrorOf(status) {
  const messages = status?.messages
  if (!Array.isArray(messages)) return undefined
  for (const entry of messages) {
    if (Array.isArray(entry) && entry[0] === 'execution_error' && entry[1] !== undefined) return entry[1]
  }
  return undefined
}

/** Collect every file-like output of a finished prompt. */
function outputFilesOf(outputs) {
  const files = []
  if (outputs === null || typeof outputs !== 'object') return files
  for (const [nodeId, nodeOutputs] of Object.entries(outputs)) {
    if (nodeOutputs === null || typeof nodeOutputs !== 'object') continue
    for (const [kind, list] of Object.entries(nodeOutputs)) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (item === null || typeof item !== 'object' || typeof item.filename !== 'string') continue
        files.push({
          nodeId,
          kind,
          filename: item.filename,
          subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
          type: typeof item.type === 'string' ? item.type : 'output',
        })
      }
    }
  }
  return files
}

/** True for output files the GUI can render inline. */
function isImageFile(filename) {
  return /\.(png|jpe?g|webp|gif|bmp)$/iu.test(filename)
}

/** Extension → attachment media type (undefined for formats DSH cannot decode). */
function imageMediaTypeOf(filename, contentType) {
  if (typeof contentType === 'string') {
    const normalized = contentType.split(';')[0].trim().toLowerCase()
    if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(normalized)) return normalized
  }
  const extension = /\.([a-z0-9]+)$/iu.exec(filename)?.[1]?.toLowerCase()
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  return undefined
}

/** The attachment store when this deployment mounts one (DSH 0.2.x). */
function attachmentsOf(ctx) {
  try {
    return ctx.get?.('attachments')
  } catch {
    return undefined
  }
}

/**
 * Download the prompt's output files into the workspace.
 * @returns {Promise<{files: object[], warnings: string[]}>} saved files plus non-fatal problems.
 */
async function saveOutputs({ client, cwd, folder, promptId, files, signal, attachments }) {
  const warnings = []
  const targetDir = folder === '' ? cwd : join(cwd, folder)
  await mkdir(targetDir, { recursive: true })
  const saved = []
  for (const file of files) {
    const url = client.viewUrl(file)
    if (!isImageFile(file.filename)) {
      saved.push({ ...file, url, savedPath: null })
      continue
    }
    try {
      const { data, mediaType } = await client.fetchOutput(file, signal)
      const target = join(targetDir, `${String(promptId).slice(0, 8)}-${safeFileName(file.filename)}`)
      await writeFile(target, data)
      const entry = {
        ...file,
        url,
        savedPath: target,
        displayPath: displayPath(cwd, target),
        bytes: data.byteLength,
      }
      const declared = imageMediaTypeOf(file.filename, mediaType)
      if (attachments !== undefined && declared !== undefined) {
        try {
          // The attachment store normalizes the raster and hands back a durable
          // reference; the renderer turns it into an inline image block.
          entry.attachment = await attachments.saveImage({ data, mediaType: declared, name: file.filename })
        } catch (error) {
          warnings.push(`附件化 ${file.filename} 失败：${error?.message ?? error}`)
        }
      }
      saved.push(entry)
    } catch (error) {
      warnings.push(`下载 ${file.filename} 失败：${error?.message ?? error}`)
      saved.push({ ...file, url, savedPath: null })
    }
  }
  return { files: saved, warnings }
}

/**
 * Resolve one `input_image` argument for an image-to-image workflow: upload a
 * workspace file, or pass through a name that already lives in ComfyUI input.
 * @returns {Promise<{value: string, uploaded: boolean, bytes?: number}>}
 */
async function prepareInputImage({ client, cwd, input, signal }) {
  const candidate = isAbsolute(input) ? input : resolve(cwd, input)
  let data
  try {
    data = await readFile(candidate)
  } catch {
    data = undefined
  }
  if (data === undefined) {
    // Not a workspace file: assume the caller passed a ComfyUI input name.
    return { value: input, uploaded: false }
  }
  const uploaded = await client.uploadImage({
    data,
    filename: basename(candidate),
    overwrite: true,
    signal,
  })
  return {
    value: uploaded.subfolder === '' ? uploaded.name : `${uploaded.subfolder}/${uploaded.name}`,
    uploaded: true,
    bytes: data.byteLength,
    subfolder: uploaded.subfolder,
    type: uploaded.type,
  }
}

/** Collect every still-unsubstituted `{{token}}` in a workflow. */
function findPlaceholders(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) findPlaceholders(item, found)
    return [...found]
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) findPlaceholders(item, found)
    return [...found]
  }
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/gu)) found.add(match[0])
  }
  return [...found]
}

/** True when an input value is an API-format link `[sourceNode, outputSlot]`. */
function isLinkValue(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1])
}

/**
 * Static preflight of one API-format workflow against /object_info.
 * @returns {{errors: object[], warnings: object[]}} actionable problems in node order.
 */
function checkWorkflow(workflow, info) {
  const errors = []
  const warnings = []
  for (const [nodeId, node] of Object.entries(workflow)) {
    const nodeInfo = info[node.class_type]
    if (nodeInfo === undefined) {
      errors.push({
        node: nodeId,
        class_type: node.class_type,
        type: 'unknown_node',
        message: `节点类不存在：${node.class_type}（可能拼错，或对应自定义节点未安装）`,
      })
      continue
    }
    const required = nodeInfo.input?.required ?? {}
    const optional = nodeInfo.input?.optional ?? {}
    const inputs = node.inputs ?? {}

    for (const inputName of Object.keys(required)) {
      const value = inputs[inputName]
      if (value === undefined) {
        const expected = Array.isArray(required[inputName]?.[0]) ? 'ENUM' : String(required[inputName]?.[0] ?? '?')
        errors.push({
          node: nodeId,
          class_type: node.class_type,
          type: 'missing_input',
          message: `缺少必填输入 ${inputName}（${expected}）`,
        })
      }
    }

    for (const [inputName, value] of Object.entries(inputs)) {
      const spec = required[inputName] ?? optional[inputName]
      if (spec === undefined) {
        warnings.push({ node: nodeId, type: 'unknown_input', message: `未知输入 ${inputName}（${node.class_type}）` })
        continue
      }
      const expected = Array.isArray(spec) ? spec[0] : undefined

      if (isLinkValue(value)) {
        const [sourceId, slot] = value
        const source = workflow[sourceId]
        if (source === undefined) {
          errors.push({
            node: nodeId,
            class_type: node.class_type,
            type: 'dangling_link',
            message: `${inputName} 连到不存在的节点 ${sourceId}`,
          })
          continue
        }
        if (Array.isArray(expected)) {
          errors.push({
            node: nodeId,
            type: 'link_to_enum',
            message: `${inputName} 需要枚举值，不能连线`,
          })
          continue
        }
        const sourceInfo = info[source.class_type]
        if (sourceInfo === undefined) continue
        const outputs = Array.isArray(sourceInfo.output) ? sourceInfo.output : []
        if (slot < 0 || slot >= outputs.length) {
          errors.push({
            node: nodeId,
            type: 'bad_slot',
            message: `${inputName} 连到 ${source.class_type} 的第 ${slot} 个输出，但该节点只有 ${outputs.length} 个输出`,
          })
          continue
        }
        if (typeof expected === 'string' && expected !== '*' && outputs[slot] !== expected) {
          warnings.push({
            node: nodeId,
            type: 'type_mismatch',
            message: `${inputName} 期望 ${expected}，但连到的是 ${source.class_type} 的 ${outputs[slot]} 输出`,
          })
        }
        continue
      }

      if (Array.isArray(expected)) {
        if (typeof value === 'string' && !expected.includes(value)) {
          const needle = value.toLowerCase().slice(0, 6)
          const suggestions = expected.filter((choice) => String(choice).toLowerCase().includes(needle)).slice(0, 3)
          errors.push({
            node: nodeId,
            class_type: node.class_type,
            type: 'not_in_list',
            message: `${inputName} 的取值不在可选列表中：${value}（共 ${expected.length} 个可选值）`,
            suggestions,
          })
        }
        continue
      }

      if (expected === 'INT' || expected === 'FLOAT') {
        if (typeof value === 'string' && !/^\{\{/u.test(value) && Number.isNaN(Number(value))) {
          warnings.push({
            node: nodeId,
            type: 'bad_number',
            message: `${inputName} 期望 ${expected}，但值是字符串 ${JSON.stringify(value)}`,
          })
        }
        const meta = Array.isArray(spec) ? spec[1] : undefined
        if (typeof value === 'number' && meta !== null && typeof meta === 'object') {
          if (typeof meta.min === 'number' && value < meta.min) {
            warnings.push({ node: nodeId, type: 'out_of_range', message: `${inputName}=${value} 小于下限 ${meta.min}` })
          }
          if (typeof meta.max === 'number' && value > meta.max) {
            warnings.push({ node: nodeId, type: 'out_of_range', message: `${inputName}=${value} 大于上限 ${meta.max}` })
          }
        }
      }
    }
  }
  return { errors, warnings }
}

/** Render a compact node input spec. */
function compactInput(spec, choicesLimit) {
  if (!Array.isArray(spec)) return { type: 'unknown' }
  const [type, meta] = spec
  if (Array.isArray(type)) {
    const limit = Math.max(1, Math.min(Number(choicesLimit) || 25, 200))
    return {
      type: 'ENUM',
      choices: type.slice(0, limit),
      total_choices: type.length,
      ...(type.length > limit ? { note: `仅显示前 ${limit} 个可选值` } : {}),
    }
  }
  const out = { type: typeof type === 'string' ? type : 'unknown' }
  if (meta !== null && typeof meta === 'object') {
    for (const key of ['default', 'min', 'max', 'step', 'multiline', 'dynamic', 'tooltip']) {
      if (meta[key] !== undefined) out[key] = meta[key]
    }
  }
  return out
}

/** Build one JSON-output tool definition. */
function jsonTool({ name: toolName, description, parameters = {}, timeoutMs, concurrencySafe, render, execute }) {
  return defineTool({
    name: toolName,
    description,
    parameters,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(concurrencySafe === undefined ? {} : { isConcurrencySafe: concurrencySafe }),
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const projected = render(value)
        return Array.isArray(projected) ? projected : [{ type: 'text', text: projected }]
      },
    },
    async execute(args, exec) {
      const value = await execute(args, exec)
      // The registry enforces a lossless-JSON canonical value; a round-trip
      // drops `undefined` fields and any non-JSON transient the body produced.
      if (value === undefined) return {}
      try {
        return JSON.parse(JSON.stringify(value))
      } catch {
        return { ok: false, error: '工具返回值无法序列化为 JSON' }
      }
    },
  })
}

/** Clamp render output so one tool result cannot flood the conversation. */
function clip(text, max = 24000) {
  return text.length > max ? `${text.slice(0, max)}\n…（输出已截断，共 ${text.length} 字符）` : text
}

/** Build every tool against the live config. */
function createTools(ctx, getConfig) {
  const makeClient = () => {
    const config = getConfig()
    return new ComfyUIClient(config.baseUrl, { timeoutMs: config.requestTimeoutMs })
  }

  /** Turn a thrown error into a canonical failure value. */
  const failure = (error, extra = {}) => {
    if (error instanceof CancelledError) {
      return { ok: false, cancelled: true, error: '已取消', ...extra }
    }
    if (error instanceof TimeoutError) {
      return { ok: false, timeout: true, error: error.message, ...extra }
    }
    const body = error instanceof ComfyUIError ? error.body : undefined
    return {
      ok: false,
      error: error?.message ?? String(error),
      ...(body === undefined ? {} : { body }),
      ...extra,
    }
  }

  const tools = []

  tools.push(
    jsonTool({
      name: 'comfyui_status',
      description:
        'Check the ComfyUI server: reachability, version, Python, devices and VRAM, queue lengths, and the configured base URL. Call this first before running anything.',
      parameters: {},
      concurrencySafe: () => true,
      async execute(_args, exec) {
        const config = getConfig()
        const client = makeClient()
        try {
          const [stats, queue] = await Promise.all([client.systemStats(exec.signal), client.queue(exec.signal)])
          const devices = Array.isArray(stats?.devices) ? stats.devices : []
          return {
            ok: true,
            reachable: true,
            baseUrl: config.baseUrl,
            comfyui_version: stats?.system?.comfyui_version,
            python_version: stats?.system?.python_version,
            deploy_environment: stats?.system?.deploy_environment,
            embedded_python: stats?.system?.embedded_python,
            launch_argv: Array.isArray(stats?.system?.argv) ? stats.system.argv : undefined,
            ram_total: stats?.system?.ram_total,
            ram_free: stats?.system?.ram_free,
            devices: devices.map((device) => ({
              name: device.name,
              type: device.type,
              vram_total: device.vram_total,
              vram_free: device.vram_free,
            })),
            queue: {
              running: Array.isArray(queue?.queue_running) ? queue.queue_running.length : 0,
              pending: Array.isArray(queue?.queue_pending) ? queue.queue_pending.length : 0,
            },
          }
        } catch (error) {
          return failure(error, { reachable: false, baseUrl: config.baseUrl })
        }
      },
      render(value) {
        if (value.ok !== true) {
          return clip(`❌ 连不上 ComfyUI\n地址：${value.baseUrl}\n原因：${value.error}\n提示：确认 ComfyUI 已启动；如换过端口，在插件配置里改 baseUrl。`)
        }
        const devices = value.devices
          .map((device) => {
            const vram = device.vram_total === undefined
              ? ''
              : ` · 显存 ${formatBytes(device.vram_free)} / ${formatBytes(device.vram_total)} 可用`
            return `  - ${device.name}${vram}`
          })
          .join('\n')
        const ram = value.ram_total === undefined ? '' : `\n- 内存：${formatBytes(value.ram_free)} / ${formatBytes(value.ram_total)} 可用`
        const argv = Array.isArray(value.launch_argv) && value.launch_argv.length > 0
          ? `\n- 启动参数：${value.launch_argv.slice(1).join(' ')}`
          : ''
        return clip(
          [
            `✅ ComfyUI 在线：${value.baseUrl}`,
            `- 版本：${value.comfyui_version ?? '未知'} · Python ${value.python_version ?? '未知'}${value.deploy_environment ? ` · ${value.deploy_environment}` : ''}`,
            `- 队列：运行中 ${value.queue.running} · 等待 ${value.queue.pending}`,
            ram,
            devices === '' ? '- 设备：未报告' : `- 设备：\n${devices}`,
          ].join('\n') + argv,
        )
      },
    }),
  )

  tools.push(
    jsonTool({
      name: 'comfyui_list_models',
      description:
        'List model files installed in ComfyUI. Omit folder for a per-folder overview (checkpoints, diffusion_models, text_encoders, vae, loras, ...); pass folder to list its files; pass query to filter by substring. Use this to get exact file names before writing a workflow.',
      parameters: {
        folder: { type: 'string', description: '模型目录名，例如 checkpoints / diffusion_models / text_encoders / vae / loras。省略则给各目录概览。' },
        query: { type: 'string', description: '文件名子串过滤，不区分大小写。' },
        limit: { type: 'integer', description: '最多返回多少个文件名（默认 200）。' },
      },
      concurrencySafe: () => true,
      async execute(args, exec) {
        const client = makeClient()
        const limit = Math.max(1, Math.min(Number(args.limit) || 200, 2000))
        const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
        try {
          const folders = await client.modelFolders(exec.signal)
          if (typeof args.folder === 'string' && args.folder.trim() !== '') {
            const requested = args.folder.trim()
            const match = folders.find((item) => item.toLowerCase() === requested.toLowerCase())
            if (match === undefined) {
              return { ok: false, error: `未知的模型目录：${requested}`, folders }
            }
            const files = await client.modelFolder(match, exec.signal)
            const filtered = query === '' ? files : files.filter((file) => String(file).toLowerCase().includes(query))
            return {
              ok: true,
              folder: match,
              total: files.length,
              matched: filtered.length,
              files: filtered.slice(0, limit),
              truncated: filtered.length > limit,
            }
          }
          const wanted = CORE_MODEL_FOLDERS.filter((folder) => folders.some((item) => item.toLowerCase() === folder))
          const results = await Promise.all(
            wanted.map(async (folder) => {
              try {
                const files = await client.modelFolder(folder, exec.signal)
                const filtered = query === '' ? files : files.filter((file) => String(file).toLowerCase().includes(query))
                return { folder, total: files.length, matched: filtered.length, sample: filtered.slice(0, 8) }
              } catch (error) {
                return { folder, error: error?.message ?? String(error) }
              }
            }),
          )
          return { ok: true, folders, overview: results }
        } catch (error) {
          return failure(error)
        }
      },
      render(value) {
        if (value.ok !== true) return clip(`❌ 读取模型列表失败：${value.error}`)
        if (Array.isArray(value.files)) {
          const head = `📦 ${value.folder}：共 ${value.total} 个文件，匹配 ${value.matched} 个${value.truncated ? '（已截断）' : ''}`
          return clip([head, ...value.files.map((file) => `- ${file}`)].join('\n'))
        }
        const lines = value.overview.map((entry) => {
          if (entry.error !== undefined) return `- ${entry.folder}：读取失败（${entry.error}）`
          const sample = entry.sample.length > 0 ? `：${entry.sample.join(', ')}${entry.total > entry.sample.length ? ' …' : ''}` : ''
          return `- ${entry.folder}：${entry.total} 个文件${sample}`
        })
        return clip([`📦 模型概览（共 ${value.folders.length} 个目录）`, ...lines, '提示：传 folder 参数可列出某目录的完整文件名。'].join('\n'))
      },
    }),
  )

  tools.push(
    jsonTool({
      name: 'comfyui_search_nodes',
      description:
        'Search ComfyUI node classes by keyword (class name, display name, category). Returns matching class_type names plus categories; use comfyui_node_schema afterwards to read one full schema.',
      parameters: {
        query: { type: 'string', required: true, description: '关键词，例如 sampler / clip / vae / upscale / controlnet / load image。' },
        limit: { type: 'integer', description: '最多返回多少个节点（默认 15，上限 50）。' },
      },
      concurrencySafe: () => true,
      async execute(args, exec) {
        const client = makeClient()
        const query = String(args.query ?? '').trim()
        if (query === '') return { ok: false, error: 'query 不能为空' }
        const limit = Math.max(1, Math.min(Number(args.limit) || 15, 50))
        const needle = query.toLowerCase()
        try {
          const info = await client.objectInfo(exec.signal)
          const scored = []
          for (const [nodeName, node] of Object.entries(info)) {
            const display = typeof node?.display_name === 'string' ? node.display_name : ''
            const category = typeof node?.category === 'string' ? node.category : ''
            const description = typeof node?.description === 'string' ? node.description : ''
            const name = nodeName.toLowerCase()
            let score
            if (nodeName === query) score = 0
            else if (name.startsWith(needle)) score = 1
            else if (name.includes(needle)) score = 2
            else if (display.toLowerCase().includes(needle)) score = 3
            else if (category.toLowerCase().includes(needle)) score = 4
            else if (description.toLowerCase().includes(needle)) score = 5
            else continue
            scored.push({ name: nodeName, display_name: display, category, score })
          }
          scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
          return {
            ok: true,
            query,
            total_matches: scored.length,
            nodes: scored.slice(0, limit).map(({ score: _score, ...rest }) => rest),
            truncated: scored.length > limit,
          }
        } catch (error) {
          return failure(error)
        }
      },
      render(value) {
        if (value.ok !== true) return clip(`❌ 搜索节点失败：${value.error}`)
        if (value.nodes.length === 0) return `没有匹配「${value.query}」的节点。试试更短的关键词，或直接用 comfyui_list_models / comfyui_guide。`
        return clip(
          [
            `🔎 「${value.query}」匹配 ${value.total_matches} 个节点${value.truncated ? `（显示前 ${value.nodes.length} 个）` : ''}`,
            ...value.nodes.map((node) => `- ${node.name}${node.display_name ? `（${node.display_name}）` : ''} · ${node.category}`),
            '提示：用 comfyui_node_schema 查某个节点的完整输入定义。',
          ].join('\n'),
        )
      },
    }),
  )

  tools.push(
    jsonTool({
      name: 'comfyui_node_schema',
      description:
        'Read the schema of one ComfyUI node class: required/optional inputs (type, default, range or enum choices), output slot types and order. Always check this before writing a node into an API-format workflow.',
      parameters: {
        node: { type: 'string', required: true, description: '节点类名（class_type），例如 KSampler、CLIPLoader、UNETLoader。' },
        choices_limit: { type: 'integer', description: '枚举输入最多显示多少个可选值（默认 25）。' },
      },
      concurrencySafe: () => true,
      async execute(args, exec) {
        const client = makeClient()
        const nodeName = String(args.node ?? '').trim()
        if (nodeName === '') return { ok: false, error: 'node 不能为空' }
        try {
          const node = await client.nodeInfo(nodeName, exec.signal)
          if (node === undefined) {
            return { ok: false, error: `节点 ${nodeName} 不存在（该自定义节点可能未安装）`, hint: '用 comfyui_search_nodes 找正确类名。' }
          }
          const choicesLimit = Number(args.choices_limit) || 25
          const inputs = node.input ?? {}
          const required = {}
          const optional = {}
          for (const [inputName, spec] of Object.entries(inputs.required ?? {})) required[inputName] = compactInput(spec, choicesLimit)
          for (const [inputName, spec] of Object.entries(inputs.optional ?? {})) optional[inputName] = compactInput(spec, choicesLimit)
          const outputNames = Array.isArray(node.output_name) ? node.output_name : []
          const outputTypes = Array.isArray(node.output) ? node.output : []
          return {
            ok: true,
            node: nodeName,
            display_name: node.display_name,
            category: node.category,
            description: node.description,
            input_order: node.input_order,
            required,
            optional,
            outputs: outputTypes.map((type, index) => ({ slot: index, type, name: outputNames[index] })),
            output_node: node.output_node === true,
          }
        } catch (error) {
          return failure(error)
        }
      },
      render(value) {
        if (value.ok !== true) return clip(`❌ 查询节点失败：${value.error}${value.hint ? `\n${value.hint}` : ''}`)
        const lines = [`🧩 ${value.node}${value.display_name ? `（${value.display_name}）` : ''} · ${value.category ?? '未分类'}`]
        if (value.description) lines.push(value.description)
        const describe = (entries) =>
          Object.entries(entries)
            .map(([inputName, spec]) => {
              const bits = [spec.type]
              if (spec.default !== undefined) bits.push(`默认 ${JSON.stringify(spec.default)}`)
              if (spec.min !== undefined || spec.max !== undefined) bits.push(`范围 ${spec.min ?? '?'}..${spec.max ?? '?'}`)
              if (Array.isArray(spec.choices)) {
                const more = spec.total_choices > spec.choices.length ? ` …共 ${spec.total_choices}` : ''
                bits.push(`可选：${spec.choices.join(' / ')}${more}`)
              }
              return `- ${inputName}：${bits.join('，')}`
            })
            .join('\n')
        if (Object.keys(value.required).length > 0) lines.push('必填输入：', describe(value.required))
        if (Object.keys(value.optional).length > 0) lines.push('可选输入：', describe(value.optional))
        if (value.outputs.length > 0) {
          lines.push('输出：', ...value.outputs.map((output) => `- [${output.slot}] ${output.type}${output.name ? `（${output.name}）` : ''}`))
        }
        return clip(lines.join('\n'))
      },
    }),
  )

  tools.push(
    jsonTool({
      name: 'comfyui_validate_workflow',
      description:
        'Preflight one API-format workflow WITHOUT running it: verifies every class_type exists on the server, required inputs are present, link targets and slots are valid, enum values (model file names, sampler names, ...) are in range, and reports leftover {{placeholders}}. Much faster than discovering the same problem in a failed run.',
      parameters: {
        template: { type: 'string', description: `内置模板名（${Object.keys(TEMPLATES).join(' / ')}）。与 workflow 二选一。` },
        workflow: { type: 'string', description: 'API 格式工作流：JSON 文本、.json 路径（工作区内相对或绝对），或 comfyui_workflows 保存的名字。' },
        prompt: { type: 'string', description: '替换 {{prompt}} 占位符后再校验。' },
        negative_prompt: { type: 'string', description: '替换 {{negative_prompt}} 占位符。' },
        seed: { type: 'integer', description: '替换 {{seed}}。' },
        width: { type: 'integer', description: '替换 {{width}}。' },
        height: { type: 'integer', description: '替换 {{height}}。' },
        steps: { type: 'integer', description: '替换 {{steps}}。' },
        cfg: { type: 'number', description: '替换 {{cfg}}。' },
        batch_size: { type: 'integer', description: '替换 {{batch_size}}。' },
        denoise: { type: 'number', description: '替换 {{denoise}}。' },
        substitutions: {
          type: 'object',
          additionalProperties: true,
          description: '自定义占位符替换表。',
        },
        overrides: { type: 'object', additionalProperties: true, description: '按节点覆盖输入，例如 {"3": {"denoise": 0.6}}。' },
      },
      concurrencySafe: () => true,
      async execute(args, exec) {
        const client = makeClient()
        const cwd = await workspaceRoot(ctx, exec)
        const resolved = await resolveWorkflowInput(args, cwd)
        if (resolved.error !== undefined) {
          return {
            ok: false,
            stage: 'prepare',
            error: resolved.error,
            ...(resolved.tried === undefined ? {} : { tried: resolved.tried }),
          }
        }
        let workflow = resolved.workflow
        const invalid = validateWorkflow(workflow)
        if (invalid !== undefined) return { ok: false, stage: 'prepare', error: invalid }

        try {
          const templateDefaults = resolved.templateName !== undefined ? TEMPLATES[resolved.templateName].defaults : {}
          const values = { ...templateDefaults }
          const explicit = {
            prompt: args.prompt,
            negative_prompt: args.negative_prompt,
            seed: args.seed,
            width: args.width,
            height: args.height,
            steps: args.steps,
            cfg: args.cfg,
            batch_size: args.batch_size,
            denoise: args.denoise,
          }
          for (const [key, value] of Object.entries(explicit)) {
            if (value !== undefined && value !== null) values[key] = value
          }
          Object.assign(values, args.substitutions ?? {})
          workflow = substitute(workflow, values)
          const overridden = applyOverrides(workflow, args.overrides)

          const info = await client.objectInfo(exec.signal)
          const result = checkWorkflow(workflow, info)
          const leftovers = findPlaceholders(workflow)
          for (const token of leftovers) {
            result.warnings.push({
              type: 'placeholder',
              message: `仍有未替换的占位符 ${token}（运行前必须提供真实值，否则 ComfyUI 会报类型错误）`,
            })
          }
          const outputNodes = Object.entries(workflow).filter(([, node]) => info[node.class_type]?.output_node === true)
          if (outputNodes.length === 0) {
            result.warnings.push({
              type: 'no_output_node',
              message: '工作流里没有输出节点（SaveImage / PreviewImage 等），执行后不会产生文件。',
            })
          }
          return {
            ok: true,
            valid: result.errors.length === 0,
            template: resolved.templateName,
            overridden_nodes: overridden,
            nodes: Object.keys(workflow).length,
            errors: result.errors,
            warnings: result.warnings,
            output_nodes: outputNodes.map(([nodeId, node]) => ({ node: nodeId, class_type: node.class_type })),
          }
        } catch (error) {
          return failure(error)
        }
      },
      render(value) {
        if (value.ok !== true) return clip(`❌ 预检失败：${value.error}${value.tried ? `\n尝试过：${value.tried.join(' / ')}` : ''}`)
        const lines = [
          value.valid
            ? `✅ 预检通过：${value.nodes} 个节点${value.template ? `（模板 ${value.template}）` : ''}`
            : `❌ 预检发现 ${value.errors.length} 个错误（${value.nodes} 个节点）`,
        ]
        for (const error of value.errors.slice(0, 40)) {
          lines.push(`- 节点 ${error.node}${error.class_type ? `（${error.class_type}）` : ''}：${error.message}`)
          if (error.suggestions?.length > 0) lines.push(`  · 相似可选值：${error.suggestions.join(' / ')}`)
        }
        if (value.errors.length > 40) lines.push(`- …另有 ${value.errors.length - 40} 个错误`)
        for (const warning of value.warnings.slice(0, 20)) lines.push(`- ⚠️ ${warning.message}`)
        if (value.warnings.length > 20) lines.push(`- …另有 ${value.warnings.length - 20} 条提示`)
        if (value.output_nodes?.length > 0) lines.push(`- 输出节点：${value.output_nodes.map((node) => `${node.node}(${node.class_type})`).join(', ')}`)
        return clip(lines.join('\n'))
      },
    }),
  )

  tools.push(
    jsonTool({
      name: 'comfyui_run_workflow',
      description:
        'Submit one API-format ComfyUI workflow and (by default) wait for it to finish, then download its output images into the session workspace. Accepts a built-in template name, workflow JSON text, or a path to a .json file / saved workflow name. Supports {{prompt}}/{{seed}}/{{width}}/... substitution plus per-node overrides.',
      parameters: {
        template: { type: 'string', description: `内置模板名（${Object.keys(TEMPLATES).join(' / ')}）。与 workflow 二选一。` },
        workflow: { type: 'string', description: 'API 格式工作流：JSON 文本、.json 路径（工作区内相对或绝对），或 comfyui_workflows 保存的名字。' },
        prompt: { type: 'string', description: '替换 {{prompt}} 占位符的正向提示词。' },
        negative_prompt: { type: 'string', description: '替换 {{negative_prompt}} 占位符的负向提示词。' },
        seed: { type: 'integer', description: '随机种子；省略或为负数则随机生成。' },
        width: { type: 'integer', description: '替换 {{width}} 占位符的宽度。' },
        height: { type: 'integer', description: '替换 {{height}} 占位符的高度。' },
        steps: { type: 'integer', description: '替换 {{steps}} 占位符的采样步数。' },
        cfg: { type: 'number', description: '替换 {{cfg}} 占位符的 CFG。' },
        batch_size: { type: 'integer', description: '替换 {{batch_size}} 占位符的批量大小。' },
        denoise: { type: 'number', description: '替换 {{denoise}} 占位符的重绘幅度（图生图常用 0.4~0.8）。' },
        input_image: {
          type: 'string',
          description: '替换 {{input_image}} 占位符：工作区图片路径（会自动上传到 ComfyUI input），或已存在的 ComfyUI input 文件名。',
        },
        substitutions: {
          type: 'object',
          additionalProperties: true,
          description: '自定义占位符替换表，例如 {"filename_prefix": "my_run"}。',
        },
        overrides: {
          type: 'object',
          additionalProperties: true,
          description: '按节点覆盖输入，例如 {"3": {"denoise": 0.6}}；会先校验节点存在。',
        },
        wait: { type: 'boolean', description: '是否等待生成完成（默认 true）。false 时只提交并返回 prompt_id。' },
        timeout_seconds: { type: 'integer', description: '等待超时秒数（默认取插件配置的 runTimeoutMs）。' },
      },
      timeoutMs: 3600000,
      concurrencySafe: () => false,
      async execute(args, exec) {
        const config = getConfig()
        const client = makeClient()
        const cwd = await workspaceRoot(ctx, exec)
        const clientId = randomUUID()
        const resolved = await resolveWorkflowInput(args, cwd)
        if (resolved.error !== undefined) {
          return {
            ok: false,
            stage: 'prepare',
            error: resolved.error,
            ...(resolved.tried === undefined ? {} : { tried: resolved.tried }),
          }
        }
        let workflow = resolved.workflow
        const templateName = resolved.templateName

        const invalid = validateWorkflow(workflow)
        if (invalid !== undefined) return { ok: false, stage: 'prepare', error: invalid }

        const templateDefaults = templateName !== undefined ? TEMPLATES[templateName].defaults : {}
        const seed = Number.isFinite(args.seed) && args.seed >= 0 ? Math.floor(args.seed) : Math.floor(Math.random() * 2 ** 32)
        // Template defaults first, then explicit arguments (only when defined),
        // then the caller's own substitution table.
        const values = { ...templateDefaults, seed }
        const explicit = {
          prompt: args.prompt,
          negative_prompt: args.negative_prompt,
          width: args.width,
          height: args.height,
          steps: args.steps,
          cfg: args.cfg,
          batch_size: args.batch_size,
          denoise: args.denoise,
        }
        for (const [key, value] of Object.entries(explicit)) {
          if (value !== undefined && value !== null) values[key] = value
        }
        Object.assign(values, args.substitutions ?? {})

        let inputImage
        if (typeof args.input_image === 'string' && args.input_image.trim() !== '') {
          try {
            inputImage = await prepareInputImage({
              client,
              cwd,
              input: args.input_image.trim(),
              signal: exec.signal,
            })
            values.input_image = inputImage.value
          } catch (error) {
            return { ok: false, stage: 'prepare', error: `准备输入图片失败：${error?.message ?? error}` }
          }
        }

        try {
          workflow = substitute(workflow, values)
          const overridden = applyOverrides(workflow, args.overrides)
          const startedAt = Date.now()
          let submission
          try {
            submission = await client.submit(workflow, { clientId, signal: exec.signal, timeoutMs: 60000 })
          } catch (error) {
            if (error instanceof ComfyUIError && error.status === 400) {
              const body = error.body
              return {
                ok: false,
                stage: 'submit',
                error: error.message,
                node_errors: body?.node_errors,
                hint: '读 node_errors 定位问题：通常是 class_type 拼错、输入名缺失、模型文件名不存在或类型不匹配。用 comfyui_node_schema / comfyui_list_models 核对。',
              }
            }
            throw error
          }
          const promptId = submission?.prompt_id
          if (typeof promptId !== 'string' || promptId === '') {
            return {
              ok: false,
              stage: 'submit',
              error: 'ComfyUI 未返回 prompt_id',
              node_errors: submission?.node_errors,
              raw: submission,
            }
          }

          if (args.wait === false) {
            return {
              ok: true,
              submitted: true,
              prompt_id: promptId,
              queue_number: submission?.number,
              node_errors: submission?.node_errors,
              hint: '已提交但未等待。用 comfyui_queue action=history 或 comfyui_status 查看进度。',
            }
          }

          const timeoutMs = Number.isFinite(args.timeout_seconds) && args.timeout_seconds > 0
            ? Math.min(args.timeout_seconds * 1000, 86400000)
            : config.runTimeoutMs
          let entry
          try {
            entry = await client.waitFor(promptId, { timeoutMs, signal: exec.signal, pollMs: 1000 })
          } catch (error) {
            if (error instanceof TimeoutError) {
              return {
                ok: false,
                timeout: true,
                prompt_id: promptId,
                duration_ms: Date.now() - startedAt,
                error: error.message,
                hint: '任务可能仍在执行：用 comfyui_queue action=history 查；不要重复提交，否则会重复排队。',
              }
            }
            if (error instanceof CancelledError) {
              try {
                await client.interrupt()
              } catch {
                // best effort: the caller already cancelled
              }
              return {
                ok: false,
                cancelled: true,
                prompt_id: promptId,
                duration_ms: Date.now() - startedAt,
                error: '已取消，并请求 ComfyUI 打断当前任务',
              }
            }
            throw error
          }

          const durationMs = Date.now() - startedAt
          const status = entry?.status ?? {}
          const errorPayload = executionErrorOf(status)
          if (status.status_str === 'error' || errorPayload !== undefined) {
            return {
              ok: false,
              stage: 'execute',
              prompt_id: promptId,
              duration_ms: durationMs,
              error: errorPayload?.exception_message ?? '执行阶段失败',
              node: errorPayload === undefined ? undefined : {
                node_id: errorPayload.node_id,
                node_type: errorPayload.node_type,
                exception_type: errorPayload.exception_type,
              },
              traceback: Array.isArray(errorPayload?.traceback) ? errorPayload.traceback.slice(-12) : undefined,
              hint: '执行阶段错误多半是显存不足、模型不匹配或尺寸问题；可用 comfyui_queue action=free 释放显存后重试。',
            }
          }

          const files = outputFilesOf(entry?.outputs)
          let saved = files.map((file) => ({ ...file, url: client.viewUrl(file), savedPath: null }))
          let warnings = []
          if (config.saveOutputs && files.length > 0) {
            try {
              const result = await saveOutputs({
                client,
                cwd,
                folder: safeOutputFolder(config.outputFolder),
                promptId,
                files,
                signal: exec.signal,
                attachments: config.inlineImages ? attachmentsOf(ctx) : undefined,
              })
              saved = result.files
              warnings = result.warnings
            } catch (error) {
              warnings = [`保存输出到工作区失败：${error?.message ?? error}`]
            }
          }
          if (files.length === 0) {
            warnings.push('工作流没有产生输出文件：确认存在 SaveImage / SaveVideo 之类的输出节点。')
          }
          return {
            ok: true,
            prompt_id: promptId,
            completed: true,
            duration_ms: durationMs,
            seed,
            template: templateName,
            overridden_nodes: overridden,
            cwd,
            input_image: inputImage,
            images: saved.filter((file) => isImageFile(file.filename)),
            other_outputs: saved.filter((file) => !isImageFile(file.filename)),
            warnings,
          }
        } catch (error) {
          return failure(error)
        }
      },
      render(value) {
        if (value.ok !== true) {
          const lines = [`❌ 工作流未完成${value.stage ? `（${value.stage}）` : ''}`]
          if (value.prompt_id) lines.push(`- prompt_id：${value.prompt_id}`)
          if (value.duration_ms !== undefined) lines.push(`- 已用时：${formatDuration(value.duration_ms)}`)
          if (value.error) lines.push(`- 原因：${value.error}`)
          if (value.node) lines.push(`- 出错节点：${value.node.node_type ?? '?'}（id ${value.node.node_id ?? '?'}）${value.node.exception_type ? ` · ${value.node.exception_type}` : ''}`)
          if (value.node_errors) lines.push(`- node_errors：${JSON.stringify(value.node_errors).slice(0, 4000)}`)
          if (value.hint) lines.push(`- 建议：${value.hint}`)
          return clip(lines.join('\n'))
        }
        if (value.submitted === true) {
          return clip(`📤 已提交：prompt_id ${value.prompt_id}（队列号 ${value.queue_number ?? '?'}）\n${value.hint ?? ''}`)
        }
        const lines = [`✅ 生成完成 · ${formatDuration(value.duration_ms)} · seed ${value.seed}`]
        if (value.template) lines.push(`- 模板：${value.template}`)
        if (value.overridden_nodes?.length > 0) lines.push(`- 覆盖节点：${value.overridden_nodes.join(', ')}`)
        if (value.input_image?.uploaded === true) lines.push(`- 输入图片：已上传（${value.input_image.value}）`)
        for (const image of value.images) {
          if (image.displayPath !== undefined) {
            lines.push(`- 图片：${image.displayPath}${image.bytes ? `（${formatBytes(image.bytes)}）` : ''}`)
            lines.push(`  ![${image.filename}](${image.displayPath})`)
          } else {
            lines.push(`- 图片（未落盘）：${image.filename} · ${image.url}`)
          }
        }
        for (const other of value.other_outputs) lines.push(`- 其他输出：${other.filename} · ${other.url}`)
        for (const warning of value.warnings ?? []) lines.push(`- ⚠️ ${warning}`)
        const blocks = [{ type: 'text', text: clip(lines.join('\n')) }]
        for (const image of value.images) {
          if (typeof image.attachment?.attachmentId === 'string') {
            blocks.push({ type: 'image', attachment: image.attachment })
          }
        }
        return blocks
      },
    }),
  )

  tools.push(
    jsonTool({
      name: 'comfyui_queue',
      description:
        'Inspect or control the ComfyUI queue: status (running/pending plus VRAM), history (recent finished prompts and their output files), interrupt, clear (drop pending), delete (drop named pending prompts), free (unload models / free memory).',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['status', 'history', 'interrupt', 'clear', 'delete', 'free'],
          description: '要执行的动作。',
        },
        prompt_id: { type: 'string', description: 'action=delete 时要删除的 prompt_id。' },
        limit: { type: 'integer', description: 'action=history 时返回最近多少条（默认 5，上限 20）。' },
      },
      concurrencySafe: () => true,
      async execute(args, exec) {
        const client = makeClient()
        const action = String(args.action ?? '')
        try {
          if (action === 'status') {
            const [queue, stats] = await Promise.all([client.queue(exec.signal), client.systemStats(exec.signal)])
            return {
              ok: true,
              action,
              running: (queue?.queue_running ?? []).map((item) => ({ prompt_id: item?.[1], number: item?.[0] })),
              pending: (queue?.queue_pending ?? []).map((item) => ({ prompt_id: item?.[1], number: item?.[0] })),
              devices: (stats?.devices ?? []).map((device) => ({
                name: device.name,
                vram_total: device.vram_total,
                vram_free: device.vram_free,
              })),
            }
          }
          if (action === 'history') {
            const limit = Math.max(1, Math.min(Number(args.limit) || 5, 20))
            const recent = await client.recentHistory(limit, exec.signal)
            const entries = Object.entries(recent)
              .map(([promptId, entry]) => {
                const status = entry?.status ?? {}
                const errorPayload = executionErrorOf(status)
                return {
                  prompt_id: promptId,
                  status: status.status_str ?? (status.completed === true ? 'success' : 'unknown'),
                  error: errorPayload?.exception_message,
                  outputs: outputFilesOf(entry?.outputs).map((file) => ({
                    ...file,
                    url: client.viewUrl(file),
                  })),
                }
              })
              .slice(-limit)
              .reverse()
            return { ok: true, action, entries }
          }
          if (action === 'interrupt') {
            await client.interrupt(exec.signal)
            return { ok: true, action, message: '已请求打断当前执行' }
          }
          if (action === 'clear') {
            await client.clearQueue(exec.signal)
            return { ok: true, action, message: '已清空待执行队列' }
          }
          if (action === 'delete') {
            const promptId = String(args.prompt_id ?? '').trim()
            if (promptId === '') return { ok: false, action, error: 'action=delete 需要 prompt_id' }
            await client.deleteQueue([promptId], exec.signal)
            return { ok: true, action, message: `已请求删除 ${promptId}` }
          }
          if (action === 'free') {
            await client.free({ unloadModels: true, freeMemory: true }, exec.signal)
            return { ok: true, action, message: '已请求卸载模型并释放显存' }
          }
          return { ok: false, error: `未知 action：${action}` }
        } catch (error) {
          return failure(error)
        }
      },
      render(value) {
        if (value.ok !== true) return clip(`❌ 队列操作失败：${value.error}`)
        if (value.action === 'status') {
          const lines = [
            `📊 队列：运行中 ${value.running.length} · 等待 ${value.pending.length}`,
            ...value.running.map((item) => `- 运行：${item.prompt_id}`),
            ...value.pending.map((item, index) => `- 等待 ${index + 1}：${item.prompt_id}`),
          ]
          for (const device of value.devices) {
            if (device.vram_total !== undefined) lines.push(`- 显存：${formatBytes(device.vram_free)} / ${formatBytes(device.vram_total)} 可用（${device.name}）`)
          }
          return clip(lines.join('\n'))
        }
        if (value.action === 'history') {
          if (value.entries.length === 0) return '历史记录为空。'
          const lines = [`🕘 最近 ${value.entries.length} 次任务`]
          for (const entry of value.entries) {
            lines.push(`- ${entry.prompt_id} · ${entry.status}${entry.error ? ` · ${entry.error}` : ''}`)
            for (const file of entry.outputs) lines.push(`  · ${file.filename}（${file.url}）`)
          }
          return clip(lines.join('\n'))
        }
        return clip(`✅ ${value.message ?? value.action}`)
      },
    }),
  )

  tools.push(
    jsonTool({
      name: 'comfyui_upload_image',
      description:
        'Upload an image from the session workspace into ComfyUI input storage (POST /upload/image). Returns the { name, subfolder, type } value to put into a LoadImage node for image-to-image / edit workflows.',
      parameters: {
        path: { type: 'string', required: true, description: '图片路径（工作区内相对路径或绝对路径）。' },
        name: { type: 'string', description: '上传后的文件名；默认沿用原文件名。' },
        subfolder: { type: 'string', description: 'ComfyUI input 目录下的子目录（可选）。' },
        overwrite: { type: 'boolean', description: '同名时是否覆盖（默认 true）。' },
      },
      concurrencySafe: () => true,
      async execute(args, exec) {
        const client = makeClient()
        const cwd = await workspaceRoot(ctx, exec)
        try {
          const absolute = resolveUserPath(cwd, args.path)
          const data = await readFile(absolute)
          const uploadName = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : basename(absolute)
          const uploaded = await client.uploadImage({
            data,
            filename: uploadName,
            subfolder: typeof args.subfolder === 'string' ? args.subfolder : '',
            overwrite: args.overwrite !== false,
            signal: exec.signal,
          })
          return {
            ok: true,
            ...uploaded,
            bytes: data.byteLength,
            load_image_value: uploaded.subfolder === '' ? uploaded.name : `${uploaded.subfolder}/${uploaded.name}`,
            hint: '在 LoadImage 节点的 image 输入里填 load_image_value；子目录要一起写。',
          }
        } catch (error) {
          return failure(error)
        }
      },
      render(value) {
        if (value.ok !== true) return clip(`❌ 上传失败：${value.error}`)
        return clip(
          `📤 已上传 ${value.name}（${formatBytes(value.bytes)}）\n- LoadImage 用：${value.load_image_value}\n- type=${value.type}${value.subfolder ? ` · subfolder=${value.subfolder}` : ''}`,
        )
      },
    }),
  )

  tools.push(
    jsonTool({
      name: 'comfyui_workflows',
      description:
        'Manage saved API-format workflows under ~/.dsh/comfyui-assistant/workflows: list saved names, get one workflow JSON, save a new one (from JSON text or a .json file), or delete one. Saved names can be passed to comfyui_run_workflow as `workflow`.',
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'get', 'save', 'delete'], description: '动作。' },
        name: { type: 'string', description: '工作流名字（不含 .json）；save/get/delete 需要。' },
        workflow: { type: 'string', description: 'action=save 时的工作流：JSON 文本或 .json 文件路径。' },
      },
      concurrencySafe: () => true,
      async execute(args, exec) {
        const cwd = await workspaceRoot(ctx, exec)
        const action = String(args.action ?? '')
        const dir = workflowDir()
        try {
          if (action === 'list') {
            await mkdir(dir, { recursive: true })
            const names = (await readdir(dir)).filter((entry) => entry.endsWith('.json'))
            const items = []
            for (const entry of names) {
              const info = await stat(join(dir, entry))
              items.push({ name: entry.slice(0, -5), bytes: info.size, modified: info.mtime.toISOString() })
            }
            items.sort((a, b) => (a.name < b.name ? -1 : 1))
            return { ok: true, action, dir, workflows: items }
          }
          if (action === 'delete') {
            const workflowName = String(args.name ?? '').trim()
            if (workflowName === '') return { ok: false, action, error: 'name 不能为空' }
            await rm(join(dir, `${safeFileName(workflowName)}.json`), { force: true })
            return { ok: true, action, message: `已删除 ${workflowName}` }
          }
          if (action === 'get') {
            const workflowName = String(args.name ?? '').trim()
            if (workflowName === '') return { ok: false, action, error: 'name 不能为空' }
            const raw = await readFile(join(dir, `${safeFileName(workflowName)}.json`), 'utf8')
            return { ok: true, action, name: workflowName, workflow: JSON.parse(raw) }
          }
          if (action === 'save') {
            const workflowName = String(args.name ?? '').trim()
            if (workflowName === '') return { ok: false, action, error: 'name 不能为空' }
            if (typeof args.workflow !== 'string' || args.workflow.trim() === '') {
              return { ok: false, action, error: 'workflow 不能为空（JSON 文本或 .json 路径）' }
            }
            const text = args.workflow.trim()
            const workflow = looksLikeJson(text)
              ? JSON.parse(text)
              : JSON.parse(await readFile(resolveUserPath(cwd, text), 'utf8'))
            const invalid = validateWorkflow(workflow)
            if (invalid !== undefined) return { ok: false, action, error: invalid }
            await mkdir(dir, { recursive: true })
            const target = join(dir, `${safeFileName(workflowName)}.json`)
            await writeFile(target, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8')
            return { ok: true, action, message: `已保存 ${workflowName}`, path: target }
          }
          return { ok: false, error: `未知 action：${action}` }
        } catch (error) {
          return failure(error)
        }
      },
      render(value) {
        if (value.ok !== true) return clip(`❌ 工作流库操作失败：${value.error}`)
        if (value.action === 'list') {
          if (value.workflows.length === 0) return `工作流库为空：${value.dir}\n用 action=save 保存第一份。`
          return clip(
            [`🗂 已保存 ${value.workflows.length} 份工作流（${value.dir}）`, ...value.workflows.map((item) => `- ${item.name}（${item.bytes} B）`)].join('\n'),
          )
        }
        if (value.action === 'get') return clip(`📄 ${value.name}\n\n${JSON.stringify(value.workflow, null, 2)}`)
        return clip(`✅ ${value.message}`)
      },
    }),
  )

  tools.push(
    jsonTool({
      name: 'comfyui_guide',
      description:
        'Read this plugin\'s built-in ComfyUI manual: overview, HTTP API cheat sheet, API-format workflow rules, node/model loading, templates, debugging, prompting, performance. Use it instead of guessing ComfyUI facts.',
      parameters: {
        topic: {
          type: 'string',
          enum: [...Object.keys(GUIDE_TOPICS)],
          description: `主题（默认 ${DEFAULT_GUIDE_TOPIC}）。`,
        },
      },
      concurrencySafe: () => true,
      async execute(args) {
        const topic = typeof args.topic === 'string' && args.topic !== '' ? args.topic : DEFAULT_GUIDE_TOPIC
        const entry = guideFor(topic)
        return { ok: true, topic, title: entry.title, text: entry.text, topics: Object.keys(GUIDE_TOPICS) }
      },
      render(value) {
        if (value.ok !== true) return clip(`❌ 读取手册失败：${value.error}`)
        return clip(`${value.text}\n\n可用主题：${value.topics.join(' / ')}`)
      },
    }),
  )

  return tools
}

/**
 * Mount the plugin: register every tool plus the announcement section.
 * @param ctx - host context carrying tools and systemPrompt.
 * @param config - validated volatile config refs (the settings card values).
 */
export function apply(ctx, config) {
  const getConfig = () => readConfig(config)
  const tools = createTools(ctx, getConfig)
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `comfyui-assistant:${tool.name}`)
  }
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'plugin:comfyui-assistant',
      order: SECTION_ORDER,
      text: () => (getConfig().announceToAgent ? GUIDANCE : ''),
    }),
    'comfyui-assistant: guidance',
  )
  try {
    ctx.logger?.info?.(`[comfyui-assistant] ready: ${getConfig().baseUrl} (${tools.length} tools)`)
  } catch {
    // logging must never break mounting
  }
}
