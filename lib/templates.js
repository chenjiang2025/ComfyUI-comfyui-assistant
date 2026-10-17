/**
 * Built-in API-format workflow templates.
 *
 * Placeholders are ordinary strings inside the workflow JSON:
 * {{prompt}}, {{negative_prompt}}, {{seed}}, {{width}}, {{height}}, {{steps}},
 * {{cfg}}, {{batch_size}}. `comfyui_run_workflow` substitutes them (numeric
 * values stay numbers when the whole string is one placeholder).
 *
 * These are starting points, not a node catalogue: always confirm node names,
 * input names and model file names against the live server with
 * comfyui_node_schema / comfyui_list_models before relying on a template.
 */

/** Z-Image Turbo text-to-image (UNET + CLIP + VAE, 8 steps, CFG 1). */
const ZIMAGE_T2I = {
  '28': {
    class_type: 'UNETLoader',
    inputs: { unet_name: 'z_image_turbo_int8_convrot.safetensors', weight_dtype: 'default' },
  },
  '30': {
    class_type: 'CLIPLoader',
    inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: 'cpu' },
  },
  '29': {
    class_type: 'VAELoader',
    inputs: { vae_name: 'ae.safetensors' },
  },
  '27': {
    class_type: 'CLIPTextEncode',
    inputs: { clip: ['30', 0], text: '{{prompt}}' },
  },
  '33': {
    class_type: 'ConditioningZeroOut',
    inputs: { conditioning: ['27', 0] },
  },
  '11': {
    class_type: 'ModelSamplingAuraFlow',
    inputs: { model: ['28', 0], shift: 3.0 },
  },
  '13': {
    class_type: 'EmptySD3LatentImage',
    inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{batch_size}}' },
  },
  '3': {
    class_type: 'KSampler',
    inputs: {
      model: ['11', 0],
      positive: ['27', 0],
      negative: ['33', 0],
      latent_image: ['13', 0],
      seed: '{{seed}}',
      steps: '{{steps}}',
      cfg: '{{cfg}}',
      sampler_name: 'res_multistep',
      scheduler: 'simple',
      denoise: 1.0,
    },
  },
  '8': {
    class_type: 'VAEDecode',
    inputs: { samples: ['3', 0], vae: ['29', 0] },
  },
  '9': {
    class_type: 'SaveImage',
    inputs: { images: ['8', 0], filename_prefix: 'comfyui_assistant' },
  },
}

/** Classic SDXL text-to-image (single checkpoint, dpmpp_2m/karras). */
const SDXL_T2I = {
  '4': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' },
  },
  '6': {
    class_type: 'CLIPTextEncode',
    inputs: { clip: ['4', 1], text: '{{prompt}}' },
  },
  '7': {
    class_type: 'CLIPTextEncode',
    inputs: { clip: ['4', 1], text: '{{negative_prompt}}' },
  },
  '5': {
    class_type: 'EmptyLatentImage',
    inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{batch_size}}' },
  },
  '3': {
    class_type: 'KSampler',
    inputs: {
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
      seed: '{{seed}}',
      steps: '{{steps}}',
      cfg: '{{cfg}}',
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 1.0,
    },
  },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'comfyui_assistant' } },
}

/** SDXL image-to-image: LoadImage → ImageScale → VAEEncode → KSampler(denoise) → save. */
const SDXL_IMG2IMG = {
  '4': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' },
  },
  '10': {
    class_type: 'LoadImage',
    inputs: { image: '{{input_image}}' },
  },
  '12': {
    class_type: 'ImageScale',
    inputs: {
      image: ['10', 0],
      upscale_method: 'lanczos',
      width: '{{width}}',
      height: '{{height}}',
      crop: 'center',
    },
  },
  '11': {
    class_type: 'VAEEncode',
    inputs: { pixels: ['12', 0], vae: ['4', 2] },
  },
  '6': {
    class_type: 'CLIPTextEncode',
    inputs: { clip: ['4', 1], text: '{{prompt}}' },
  },
  '7': {
    class_type: 'CLIPTextEncode',
    inputs: { clip: ['4', 1], text: '{{negative_prompt}}' },
  },
  '3': {
    class_type: 'KSampler',
    inputs: {
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['11', 0],
      seed: '{{seed}}',
      steps: '{{steps}}',
      cfg: '{{cfg}}',
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: '{{denoise}}',
    },
  },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'comfyui_assistant_i2i' } },
}

/**
 * Template registry. `defaults` seed the placeholder values when the caller
 * omits them; `models` is shown by comfyui_guide topic=templates.
 */
export const TEMPLATES = {
  'zimage-t2i': {
    label: 'Z-Image Turbo 文生图',
    description: 'UNETLoader(CLIPLoader lumina2)+AE，8 步、CFG 1、res_multistep/simple；适合 Intel Arc 等低显存机器',
    models: ['diffusion_models/z_image_turbo_int8_convrot.safetensors', 'text_encoders/qwen_3_4b.safetensors', 'vae/ae.safetensors'],
    defaults: { width: 864, height: 1536, steps: 8, cfg: 1, batch_size: 1 },
    workflow: ZIMAGE_T2I,
  },
  'sdxl-t2i': {
    label: 'SDXL 文生图',
    description: 'CheckpointLoaderSimple + EmptyLatentImage，dpmpp_2m/karras，25 步、CFG 7',
    models: ['checkpoints/sd_xl_base_1.0.safetensors'],
    defaults: { width: 1024, height: 1024, steps: 25, cfg: 7, batch_size: 1 },
    workflow: SDXL_T2I,
  },
  'sdxl-img2img': {
    label: 'SDXL 图生图',
    description: 'LoadImage → ImageScale({{width}}x{{height}}) → VAEEncode → KSampler({{denoise}})，改图/重绘用；需要 input_image',
    models: ['checkpoints/sd_xl_base_1.0.safetensors'],
    defaults: { width: 1024, height: 1024, steps: 25, cfg: 7, denoise: 0.6 },
    workflow: SDXL_IMG2IMG,
  },
}

/** Deep-clone one template workflow (structuredClone keeps callers isolated). */
export function templateWorkflow(name) {
  const template = TEMPLATES[name]
  if (template === undefined) return undefined
  return structuredClone(template.workflow)
}
