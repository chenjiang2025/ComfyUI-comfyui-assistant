/**
 * Standalone smoke test for the comfyui-assistant plugin.
 *
 * Runs the real plugin entry point against a fake cordis context and talks to
 * the live ComfyUI server (default http://127.0.0.1:8188). The local
 * node_modules/@deepseek-ai junction makes the harness packages resolvable
 * outside DSH, so no build step is involved.
 *
 * Usage: node test/smoke.mjs [--no-run]   (--no-run skips the GPU generation)
 */

import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { apply } from '../lib/index.js'
import { templateWorkflow } from '../lib/templates.js'

const skipRun = process.argv.includes('--no-run')

/** Wrap a value as a volatile config ref (same shape cordis hands to apply). */
const ref = (value) => ({ get: () => value })

const registered = []
const attachments = []
const fakeAttachments = {
  async saveImage({ data, mediaType, name }) {
    const stored = {
      attachmentId: `sha256:${'a'.repeat(64)}`,
      mediaType,
      bytes: data.byteLength,
      width: 512,
      height: 512,
      name,
    }
    attachments.push(stored)
    return stored
  },
}

const fakeCtx = {
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
  systemPrompt: {
    section(section) {
      assert.equal(section.name, 'plugin:comfyui-assistant')
      return () => {}
    },
  },
  get(name) {
    return name === 'attachments' ? fakeAttachments : undefined
  },
  effect(register) {
    return register()
  },
  logger: { info: (...args) => console.log('[logger]', ...args) },
}

const config = {
  announceToAgent: ref(true),
  baseUrl: ref(process.env.COMFYUI_BASE_URL ?? 'http://127.0.0.1:8188'),
  requestTimeoutMs: ref(30000),
  runTimeoutMs: ref(600000),
  saveOutputs: ref(true),
  outputFolder: ref('comfyui-output'),
  inlineImages: ref(true),
}

apply(fakeCtx, config)

const tool = (name) => {
  const definition = registered.find((entry) => entry.name === name)
  assert.ok(definition, `tool ${name} was not registered`)
  return definition
}

const exec = { signal: new AbortController().signal }

/** Flatten a render projection to text plus the image blocks it carried. */
const renderView = (definition, value) => {
  const blocks = definition.output.render({}, value)
  assert.ok(Array.isArray(blocks), 'render must return content blocks')
  return {
    text: blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n'),
    images: blocks.filter((block) => block.type === 'image'),
  }
}

console.log('\nregistered tools:', registered.map((entry) => entry.name).join(', '))
assert.equal(registered.length, 10)

// 1. status
const status = await tool('comfyui_status').execute({}, exec)
console.log('\n--- comfyui_status ---\n' + renderView(tool('comfyui_status'), status).text)
assert.equal(status.ok, true, 'ComfyUI should be reachable for this smoke test')
assert.ok(status.comfyui_version)

// 2. model overview + one folder
const models = await tool('comfyui_list_models').execute({}, exec)
assert.equal(models.ok, true)
const ckpt = await tool('comfyui_list_models').execute({ folder: 'checkpoints' }, exec)
assert.equal(ckpt.ok, true)
assert.ok(ckpt.files.length > 0, 'expected at least one checkpoint')

// 3. node search + schema
const search = await tool('comfyui_search_nodes').execute({ query: 'ksampler', limit: 5 }, exec)
assert.ok(search.nodes.some((node) => node.name === 'KSampler'))
const schema = await tool('comfyui_node_schema').execute({ node: 'KSampler' }, exec)
assert.equal(schema.ok, true)
assert.ok(schema.required.seed)

// 4. guide lists the new template
const guide = await tool('comfyui_guide').execute({ topic: 'templates' }, exec)
assert.equal(guide.ok, true)
assert.ok(guide.text.includes('sdxl-img2img'))

// 5. preflight: a valid template passes
const valid = await tool('comfyui_validate_workflow').execute(
  { template: 'zimage-t2i', prompt: 'a cat', seed: 1, width: 512, height: 512, steps: 6 },
  exec,
)
console.log('\n--- comfyui_validate_workflow (ok) ---\n' + renderView(tool('comfyui_validate_workflow'), valid).text)
assert.equal(valid.ok, true)
assert.equal(valid.valid, true, `expected valid workflow, errors: ${JSON.stringify(valid.errors)}`)
assert.equal(valid.errors.length, 0)
assert.ok(!valid.warnings.some((warning) => warning.type === 'placeholder'))

// 6. preflight: unknown node class is reported, not thrown
const unknown = await tool('comfyui_validate_workflow').execute(
  { workflow: JSON.stringify({ '3': { class_type: 'NoSuchNode', inputs: {} } }) },
  exec,
)
assert.equal(unknown.ok, true)
assert.equal(unknown.valid, false)
assert.equal(unknown.errors[0].type, 'unknown_node')

// 7. preflight: a wrong model file name is caught with suggestions
const badModel = await tool('comfyui_validate_workflow').execute(
  {
    template: 'sdxl-t2i',
    prompt: 'x',
    seed: 1,
    width: 512,
    height: 512,
    steps: 4,
    overrides: { '4': { ckpt_name: 'no_such_model.safetensors' } },
  },
  exec,
)
assert.equal(badModel.ok, true)
assert.equal(badModel.valid, false)
const modelError = badModel.errors.find((error) => error.type === 'not_in_list')
assert.ok(modelError, `expected not_in_list, got ${JSON.stringify(badModel.errors)}`)

// 8. preflight: leftover placeholders become warnings
const leftover = await tool('comfyui_validate_workflow').execute(
  { workflow: JSON.stringify({ '3': { class_type: 'KSampler', inputs: { seed: '{{seed}}' } } }) },
  exec,
)
assert.equal(leftover.ok, true)
assert.ok(leftover.warnings.some((warning) => warning.type === 'placeholder'))

// 9. workflows library round-trip
const saved = await tool('comfyui_workflows').execute(
  { action: 'save', name: 'smoke-test', workflow: JSON.stringify(templateWorkflow('sdxl-t2i')) },
  exec,
)
assert.equal(saved.ok, true)
const listed = await tool('comfyui_workflows').execute({ action: 'list' }, exec)
assert.ok(listed.workflows.some((entry) => entry.name === 'smoke-test'))
await tool('comfyui_workflows').execute({ action: 'delete', name: 'smoke-test' }, exec)

// 10. real generation through a built-in template (with inline attachment)
if (skipRun) {
  console.log('\n--no-run: skipping generation tests')
} else {
  const run = await tool('comfyui_run_workflow').execute(
    {
      template: 'zimage-t2i',
      prompt: 'a red apple on a wooden table, soft window light, product photo',
      seed: 20261017,
      width: 768,
      height: 768,
      steps: 8,
    },
    exec,
  )
  const view = renderView(tool('comfyui_run_workflow'), run)
  console.log('\n--- comfyui_run_workflow (t2i) ---\n' + view.text)
  assert.equal(run.ok, true, `generation failed: ${run.error ?? ''} ${JSON.stringify(run.node_errors ?? '')}`)
  assert.ok(run.images.length > 0, 'expected at least one image')
  assert.ok(run.images[0].attachment, 'expected an inline attachment')
  assert.equal(view.images.length, run.images.filter((image) => image.attachment).length)
  assert.ok(view.images[0].attachment.attachmentId.startsWith('sha256:'))
  await access(run.images[0].savedPath)
  const bytes = await readFile(run.images[0].savedPath)
  assert.ok(bytes.byteLength > 1000, 'expected a non-trivial PNG')
  console.log(`\nsaved image: ${resolve(run.images[0].savedPath)} (${bytes.byteLength} bytes)`)

  // 11. image-to-image: the workspace image is uploaded automatically
  const i2i = await tool('comfyui_run_workflow').execute(
    {
      template: 'sdxl-img2img',
      input_image: 'docs/sample-zimage.png',
      prompt: 'oil painting of a cabin in the mountains, thick brush strokes',
      negative_prompt: 'blurry',
      seed: 11,
      width: 512,
      height: 512,
      steps: 8,
      denoise: 0.55,
    },
    exec,
  )
  const i2iView = renderView(tool('comfyui_run_workflow'), i2i)
  console.log('\n--- comfyui_run_workflow (img2img) ---\n' + i2iView.text)
  assert.equal(i2i.ok, true, `img2img failed: ${i2i.error ?? ''} ${JSON.stringify(i2i.node_errors ?? '')}`)
  assert.equal(i2i.input_image.uploaded, true)
  assert.ok(i2i.images.length > 0)
  await access(i2i.images[0].savedPath)
}

console.log('\n✅ smoke test passed')
