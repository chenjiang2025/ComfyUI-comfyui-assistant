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
import { readFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { apply } from '../lib/index.js'
import { templateWorkflow } from '../lib/templates.js'

const skipRun = process.argv.includes('--no-run')

/** Wrap a value as a volatile config ref (same shape cordis hands to apply). */
const ref = (value) => ({ get: () => value })

const registered = []
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
  get: () => undefined,
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
}

apply(fakeCtx, config)

const tool = (name) => {
  const definition = registered.find((entry) => entry.name === name)
  assert.ok(definition, `tool ${name} was not registered`)
  return definition
}

const exec = { signal: new AbortController().signal }

/** Render a tool result to plain text the way the model would see it. */
const renderText = (definition, value) =>
  definition.output
    .render({}, value)
    .map((block) => (block.type === 'text' ? block.text : JSON.stringify(block)))
    .join('\n')

console.log('\nregistered tools:', registered.map((entry) => entry.name).join(', '))
assert.equal(registered.length, 9)

// 1. status
const status = await tool('comfyui_status').execute({}, exec)
console.log('\n--- comfyui_status ---\n' + renderText(tool('comfyui_status'), status))
assert.equal(status.ok, true, 'ComfyUI should be reachable for this smoke test')

// 2. model overview + one folder
const models = await tool('comfyui_list_models').execute({}, exec)
console.log('\n--- comfyui_list_models (overview) ---\n' + renderText(tool('comfyui_list_models'), models))
assert.equal(models.ok, true)
const ckpt = await tool('comfyui_list_models').execute({ folder: 'checkpoints' }, exec)
console.log('\n--- comfyui_list_models (checkpoints) ---\n' + renderText(tool('comfyui_list_models'), ckpt))
assert.equal(ckpt.ok, true)
assert.ok(ckpt.files.length > 0, 'expected at least one checkpoint')

// 3. node search + schema
const search = await tool('comfyui_search_nodes').execute({ query: 'ksampler', limit: 5 }, exec)
console.log('\n--- comfyui_search_nodes ---\n' + renderText(tool('comfyui_search_nodes'), search))
assert.ok(search.nodes.some((node) => node.name === 'KSampler'))

const schema = await tool('comfyui_node_schema').execute({ node: 'KSampler' }, exec)
console.log('\n--- comfyui_node_schema ---\n' + renderText(tool('comfyui_node_schema'), schema))
assert.equal(schema.ok, true)
assert.ok(schema.required.seed)

// 4. guide
const guide = await tool('comfyui_guide').execute({ topic: 'templates' }, exec)
assert.equal(guide.ok, true)
assert.ok(guide.text.includes('zimage-t2i'))

// 5. workflows library round-trip
const saved = await tool('comfyui_workflows').execute(
  { action: 'save', name: 'smoke-test', workflow: JSON.stringify(templateWorkflow('sdxl-t2i')) },
  exec,
)
assert.equal(saved.ok, true)
const listed = await tool('comfyui_workflows').execute({ action: 'list' }, exec)
assert.ok(listed.workflows.some((entry) => entry.name === 'smoke-test'))
await tool('comfyui_workflows').execute({ action: 'delete', name: 'smoke-test' }, exec)

// 6. real generation through a built-in template
if (skipRun) {
  console.log('\n--no-run: skipping generation test')
} else {
  const run = await tool('comfyui_run_workflow').execute({
    template: 'zimage-t2i',
    prompt: 'a red apple on a wooden table, soft window light, product photo',
    seed: 20261017,
    width: 768,
    height: 768,
    steps: 8,
  }, exec)
  console.log('\n--- comfyui_run_workflow ---\n' + renderText(tool('comfyui_run_workflow'), run))
  assert.equal(run.ok, true, `generation failed: ${run.error ?? ''} ${JSON.stringify(run.node_errors ?? '')}`)
  assert.ok(run.images.length > 0, 'expected at least one image')
  const image = run.images[0]
  assert.ok(image.savedPath, 'expected the image to be saved into the workspace')
  await access(image.savedPath)
  const bytes = await readFile(image.savedPath)
  assert.ok(bytes.byteLength > 1000, 'expected a non-trivial PNG')
  console.log(`\nsaved image: ${resolve(image.savedPath)} (${bytes.byteLength} bytes)`)
}

console.log('\n✅ smoke test passed')
