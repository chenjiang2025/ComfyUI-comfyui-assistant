/**
 * The assistant's built-in knowledge base.
 *
 * These texts are returned verbatim by the comfyui_guide tool, so the model can
 * pull only the topic it needs instead of carrying the whole manual in its
 * system prompt. Keep every statement verifiable: when in doubt, the answer is
 * "ask the server" (comfyui_node_schema / comfyui_list_models).
 */

/** Default topic when the caller does not name one. */
export const DEFAULT_GUIDE_TOPIC = 'overview'

/** Ordered topic registry: id → { title, text }. */
export const GUIDE_TOPICS = {
  overview: {
    title: '概览与推荐流程',
    text: `# ComfyUI 助手 · 概览

本插件把本机 ComfyUI（默认 http://127.0.0.1:8188）接到 DSH 里，用工具完成「看服务器 → 查模型 → 查节点 → 写工作流 → 跑图 → 收产出」的闭环。

## 工具一览
- comfyui_status：连通性、版本、显卡与显存、队列长度。
- comfyui_list_models：按目录列模型文件（checkpoints / diffusion_models / text_encoders / vae / loras …）。
- comfyui_search_nodes：按关键词搜节点类名。
- comfyui_node_schema：查单个节点的输入/输出定义（类型、默认值、取值域）。
- comfyui_run_workflow：提交 API 格式工作流，等待完成，把输出图片下载到工作区。
- comfyui_queue：看队列/历史、打断、清空、释放显存。
- comfyui_upload_image：把工作区图片传到 ComfyUI 的 input 目录（图生图/编辑工作流用）。
- comfyui_workflows：保存/读取/删除自建工作流（存到 ~/.dsh/comfyui-assistant/workflows）。
- comfyui_guide：当前这些知识点。

## 推荐工作流
1. comfyui_status 确认服务在跑、显存够。
2. comfyui_list_models 确认要用的模型文件真实存在（文件名必须一字不差）。
3. 第一次用某类节点时，用 comfyui_search_nodes + comfyui_node_schema 核对输入名与取值域，别凭记忆写。
4. 以内置模板（comfyui_guide topic=templates）或已保存的工作流为起点，只改必要的字段。
5. comfyui_run_workflow 提交；出错时读 node_errors，按 debug 主题修。
6. 完成后把返回的图片路径用 Markdown 图片语法展示给用户。

## 注意
- 只支持 API 格式工作流（UI 里“导出 (API)”得到的那种），不是前端保存的普通工作流 JSON。
- 生成可能很久（低显存机器几十秒到几分钟）。默认同步等待，超时就返回 prompt_id，可再用 comfyui_queue 查。
- 修改插件设置：插件管理页里本插件的配置卡片（baseUrl、超时、输出目录等）。`,
  },

  api: {
    title: 'ComfyUI HTTP API 速查',
    text: `# ComfyUI HTTP API 速查

所有接口都在同一个根地址下（默认 http://127.0.0.1:8188），返回 JSON。

- GET /system_stats → { system: { comfyui_version, python_version, ram_total, ram_free }, devices: [{ name, type, vram_total, vram_free }] }
- GET /queue → { queue_running: [...], queue_pending: [...] }，每项是 [number, prompt_id, prompt, extra_data, outputs_to_execute]
- POST /prompt body {"prompt": {API 工作流}, "client_id": "任意字符串"}
  → 成功 {"prompt_id": "...", "number": n, "node_errors": {}}
  → 失败 400 {"error": {...}, "node_errors": {"节点id": {"errors": [{"message","details","extra_info"}]}}}
- GET /history/{prompt_id} → { "<prompt_id>": { prompt: [...], outputs: { "<节点id>": { images: [{filename,subfolder,type}], gifs: [...] } }, status: { status_str, completed, messages: [ ["execution_start", {...}], ["execution_error", {...}] ] } } }
- GET /history?max_items=5 → 最近若干条，结构同上
- POST /interrupt → 打断当前正在执行的提示
- POST /queue {"clear": true} 清空待执行；{"delete": ["prompt_id"]} 删除指定待执行项
- POST /free {"unload_models": true, "free_memory": true} 释放模型与显存
- GET /object_info → 全部节点定义（很大，几 MB）；GET /object_info/{NodeClass} 只取一个
- GET /models → 模型目录名数组；GET /models/{folder} → 该目录下文件名数组
- POST /upload/image（multipart：image、overwrite、可选 subfolder）→ { name, subfolder, type }
- GET /view?filename=&subfolder=&type=output → 图片字节

## 状态判定
history 里 status.completed === true 表示结束；status.status_str 为 "success" 或 "error"。
执行出错时 messages 里有一条 ["execution_error", { node_id, node_type, exception_message, exception_type, traceback }]。
注意：有些错误在提交阶段就返回（/prompt 的 node_errors），不会进 history。`,
  },

  workflow: {
    title: 'API 格式工作流规范',
    text: `# API 格式工作流规范

## 结构
一个 JSON 对象，键是节点 id（字符串，如 "3"、"27"），值是节点：

{
  "3": {
    "class_type": "KSampler",
    "inputs": {
      "model": ["28", 0],
      "positive": ["27", 0],
      "latent_image": ["13", 0],
      "seed": 12345,
      "steps": 8
    },
    "_meta": { "title": "KSampler" }
  }
}

- class_type：节点类名，必须与 /object_info 里的键完全一致（大小写敏感）。
- inputs：输入名必须与节点定义一致；连线写法是 ["源节点id", 输出槽序号]，槽号从 0 开始。
- 普通值直接写（数字就是数字，"steps": 8 不要写成 "8"）。
- _meta 可有可无，只用于前端显示标题。

## 与 UI 格式的区别（最常见的坑）
ComfyUI 前端“保存”出来的是 UI 格式：有 nodes 数组、links 数组、widgets_values。
API 格式完全不同：扁平对象 + inputs + 连线数组。**必须在前端用「导出 (API)」**，或者手工按上面的结构重写。
典型错误：
- 直接把 UI 格式的 JSON 提交 → /prompt 报 "Required input is missing" 或 "Cannot execute because node ... does not exist"。
- 把连线写成一个对象 {node_id, output} → 必须是二元数组 ["27", 0]。
- 用数字键但写成数字类型 → 键统一写字符串（JSON 里本来就带引号）。

## 最小可用工作流骨架（文生图）
至少需要：模型加载 → 文本编码（正向/负向）→ 空 latent → KSampler → VAEDecode → SaveImage。
少一个 SaveImage 就不会有输出；少 VAEDecode 就没有图。

## 常用节点名
CheckpointLoaderSimple、UNETLoader、CLIPLoader、VAELoader、CLIPTextEncode、ConditioningZeroOut、
EmptyLatentImage、EmptySD3LatentImage、KSampler、KSamplerAdvanced、VAEDecode、SaveImage、LoadImage、
ImageScale、LoraLoader、ControlNetLoader、ControlNetApplyAdvanced、ModelSamplingAuraFlow。

## 占位符
本插件的模板与运行器支持 {{prompt}}、{{negative_prompt}}、{{seed}}、{{width}}、{{height}}、{{steps}}、{{cfg}}、{{batch_size}}。
也可以自己发明占位符，再用 comfyui_run_workflow 的 substitutions 传值。`,
  },

  nodes: {
    title: '节点与模型加载方式',
    text: `# 节点与模型加载方式

不要凭记忆写节点输入：先用 comfyui_search_nodes 找类名，再用 comfyui_node_schema 看输入名、类型、默认值、可选值。

## 两类加载方式
1. 一体化 checkpoint
   CheckpointLoaderSimple { ckpt_name } → 输出 MODEL(0)、CLIP(1)、VAE(2)
   适用于 SD1.5 / SDXL / 打包好的模型（如 sd_xl_base_1.0.safetensors）。
2. 分离式（diffusion model + text encoder + VAE）
   UNETLoader { unet_name, weight_dtype } → MODEL
   CLIPLoader { clip_name, type, device } → CLIP（type 常见：stable_diffusion、sdxl、sd3、flux、lumina2、qwen_image）
   VAELoader { vae_name } → VAE
   适用于 Z-Image、Flux、Qwen-Image、LTXV、MiniMax 等新架构。

## 采样器要点
- KSampler 输入：model / positive / negative / latent_image / seed / steps / cfg / sampler_name / scheduler / denoise。
- cfg 必须与模型匹配：蒸馏/加速模型通常 cfg=1.0、steps 4~8、denoise=1.0；SDXL 常用 cfg 6~8、steps 20~30。
- sampler_name/scheduler 只能是节点定义里的枚举值（comfyui_node_schema 会列出）。
- 加速模型配高 cfg 会糊或过曝，配低 steps 会结构崩。

## 负向提示
- 常规模型：第二个 CLIPTextEncode 接 negative。
- 无负向的蒸馏模型（如 Z-Image Turbo）：用 ConditioningZeroOut 把正向条件清零当负向，或直接接空条件。

## 常见附肢
- LoraLoader { model, clip, lora_name, strength_model, strength_clip }，串在加载器与 KSampler 之间，同时改 model 与 clip 两条线。
- 放大：ImageScale（像素插值）或 UpscaleModelLoader + ImageUpscaleWithModel（模型放大），放在 VAEDecode 之后、SaveImage 之前。
- 图生图：LoadImage → VAEEncode → KSampler 的 latent_image，denoise 取 0.4~0.8。`,
  },

  templates: {
    title: '内置工作流模板',
    text: `# 内置工作流模板

用 comfyui_run_workflow 时传 template 名称即可，不要手写整份 JSON；也可以用 comfyui_workflows 把常用工作流存起来复用。

## zimage-t2i
- 用途：Z-Image Turbo 文生图（低显存友好，8 步）。
- 模型：diffusion_models/z_image_turbo_int8_convrot.safetensors、text_encoders/qwen_3_4b.safetensors、vae/ae.safetensors
- 默认：width=864 height=1536 steps=8 cfg=1 batch_size=1
- 提示：如果是横图，传 width=1536 height=864；步数超过 12 收益很小。

## sdxl-t2i
- 用途：SDXL 常规文生图。
- 模型：checkpoints/sd_xl_base_1.0.safetensors
- 默认：width=1024 height=1024 steps=25 cfg=7 batch_size=1
- 提示：SDXL 支持 1024x1024、896x1152、832x1216 等；非训练分辨率容易出重复肢体。

## 用法
comfyui_run_workflow({ template: "zimage-t2i", prompt: "一只橘猫坐在窗台，黄昏光线，胶片质感", seed: 42, width: 864, height: 1536 })

## 覆盖细节
- substitutions：替换模板里的任意 {{token}}，例如 { "filename_prefix": "my_run" }（需要模板里存在该 token）。
- overrides：直接改某节点的输入，例如 { "3": { "denoise": 0.6 } }；会先校验节点是否存在。
- workflow：传路径（.json 文件）或 JSON 文本，与 template 二选一。`,
  },

  debug: {
    title: '排错手册',
    text: `# 排错手册

## 错误发生在提交阶段（/prompt 返回 400）
响应里有 node_errors，形如：
{ "节点id": { "errors": [ { "message": "Required input is missing: clip", "details": "clip", "extra_info": {} } ] } }

按类型处理：
- "Required input is missing: X" → 该节点 inputs 少了 X，补上或检查拼写。
- "Cannot execute because node X does not exist" / "class_type not found" → 节点类名写错，或该自定义节点没装。用 comfyui_search_nodes 找正确名字。
- "Value not in list: ckpt_name: 'xxx' not in [...]" → 模型文件名不对或没装。用 comfyui_list_models 取准确文件名（含扩展名、大小写、子目录路径）。
- "Invalid input type" → 值类型不对，常见是把数字写成字符串、把连线写成了值。
- "Return type mismatch" → 连线接错槽位（比如把 MODEL 接到 CLIP）。

## 错误发生在执行阶段（history.status.status_str === 'error'）
读 messages 里的 execution_error：node_id / node_type / exception_message。
- CUDA/XPU out of memory → 降分辨率或 batch，关掉别的模型（comfyui_queue action=free），必要时换更小的量化模型。
- "Sizes of tensors must match" → 图生图里输入图与 latent 尺寸不匹配，加 ImageScale 对齐。
- 模型加载失败 → 文件损坏或权重格式不匹配（int8/bf16/fp8 要与加载器匹配）。

## 一直没有结果
- comfyui_status 看队列是否在动；queue_running 为空且 history 无记录 → 提示可能根本没提交成功。
- 超时返回 prompt_id 后，可用 comfyui_queue action=history 再查；不要盲目重复提交，否则会排队多张。
- 显存不足时 ComfyUI 会长时间换页，先 free 或换小模型。

## 常见环境问题
- 连不上：确认 ComfyUI 在跑（浏览器打开根地址），确认插件 baseUrl（默认 http://127.0.0.1:8188）。
- 端口被占/监听 0.0.0.0 时，本机仍用 127.0.0.1 访问。
- 服务在另一台机器：把 baseUrl 改成 http://<ip>:8188，确保防火墙放行。`,
  },

  models: {
    title: '模型目录语义',
    text: `# 模型目录语义

ComfyUI 的模型目录名直接对应加载器的取值域，写错目录等于“模型不存在”。

- checkpoints/ → CheckpointLoaderSimple.ckpt_name（一体化模型）
- diffusion_models/（旧名 unet/）→ UNETLoader.unet_name（仅扩散主干）
- text_encoders/（旧名 clip/）→ CLIPLoader.clip_name（文本编码器）
- vae/ → VAELoader.vae_name
- loras/ → LoraLoader.lora_name
- controlnet/ → ControlNetLoader.control_net_name
- upscale_models/ → UpscaleModelLoader.model_name
- embeddings/ → 通过 CLIPTextEncode 的 embedding:名字 引用
- clip_vision/ → CLIPVisionLoader.clip_name
- style_models/、photomaker/、gligen/、audio_encoders/ 等按对应节点用

## 命名规律（以本机常见文件为例）
- z_image_turbo_int8_convrot.safetensors → diffusion_models，配 text_encoders/qwen_3_4b.safetensors（type=lumina2）与 vae/ae.safetensors。
- sd_xl_base_1.0.safetensors → checkpoints。
- qwen_image_edit_* → diffusion_models，配 vae/qwen_image_vae.safetensors 与 text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors（type=qwen_image）。
- ltxv-*.safetensors → checkpoints/（视频模型，配 LTXV 专用节点）。

## 量化说明
文件名里的 int8 / fp8 / nvfp4 / bf16 是权重量化格式：加载器不一定有 dtype 选项（如 UNETLoader 的 weight_dtype 通常保持 default），不要为了“对齐名字”而乱改类型；
真正要保证的是：目录对、文件名对、文本编码器 type 对、VAE 对。`,
  },

  prompting: {
    title: '提示词与画幅建议',
    text: `# 提示词与画幅建议

## 通用写法
顺序建议：主体（谁/什么）→ 外观细节 → 动作/姿态 → 环境与背景 → 光线 → 镜头/构图 → 风格/画质。
用英文短语通常更稳（尤其 SDXL），中文在 Qwen 系与 Z-Image 上也可用；同一张图里不要中英混杂描述同一细节。

## 负向提示
常规模型常用：lowres, bad anatomy, bad hands, extra fingers, watermark, text, jpeg artifacts, blurry。
蒸馏/加速模型（cfg≈1）负向基本无效，不要指望它修手。

## 画幅
- SDXL：1024x1024、896x1152、832x1216、1216x832。
- Z-Image Turbo：864x1536（竖）、1536x864（横）、896x1216、1216x896 均已验证可用。
- 尽量保持宽高都是 64 的倍数；极端长宽比容易崩。

## 迭代策略
1. 先低步数/小图确认构图与工作流正确。
2. 固定 seed 微调提示词，比较差异。
3. 满意后再提步数/放大；换 seed 做变体。
4. 每次把 seed 回报给用户，方便复现。`,
  },

  performance: {
    title: '性能与显存（Intel Arc 等低显存机器）',
    text: `# 性能与显存

## 常见加速手段
- 用蒸馏/加速模型：Z-Image Turbo 8 步、Lightning/Turbo LoRA 4~8 步。
- 降低分辨率与 batch_size；先出小图确认，再放大。
- 及时释放：comfyui_queue action=free（unload_models + free_memory）在切换大模型前调用。
- 不要同时排队多张：先看 comfyui_status 的队列长度。

## ComfyUI 启动参数（服务端，需用户自己改）
- --reserve-vram 2：给系统留 2GB，避免 XPU/CUDA 抢占。
- --enable-dynamic-vram：按需换入换出（比强制 lowvram 快）。
- --preview-method none：低显存机器关掉预览可省显存。
- --bf16-vae / --fp16-vae 视 VAE 精度而定。

## 本机参考
Intel Arc B580（约 12GB 显存）+ Z-Image Turbo int8：864x1536、8 步约 15~25 秒；SDXL 1024x1024、25 步约 30~60 秒。
这些数字会随驱动与负载浮动，不要写死进代码，用 comfyui_run_workflow 返回的 duration_ms 记录真实耗时。`,
  },
}

/** Resolve one topic, falling back to the overview. */
export function guideFor(topic) {
  const entry = GUIDE_TOPICS[topic ?? DEFAULT_GUIDE_TOPIC] ?? GUIDE_TOPICS[DEFAULT_GUIDE_TOPIC]
  return entry
}
