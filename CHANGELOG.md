# Changelog

## 0.2.0 — 2026-10-17

适配 DeepSeek Harness `0.2.1-rc.2`（ComfyUI 0.34），并补上「先预检再跑图」和「图生图」两条主线。

### 新增

- **`comfyui_validate_workflow`**：不跑图的静态预检。用 `/object_info` 对照检查
  `class_type` 是否存在、必填输入是否齐全、连线节点与输出槽是否合法、连线类型是否匹配、
  枚举取值（模型文件名 / sampler / scheduler / crop …）是否有效并给出相似项、数值越界、
  残留 `{{...}}` 占位符、是否缺少输出节点。
- **内联图片附件**：生成的图片除了存进工作区，还会通过 `ctx.attachments.saveImage()`
  变成 image content block，直接显示在对话里（新增配置 `inlineImages`，默认开；
  部署没有附件服务时自动跳过）。
- **`sdxl-img2img` 模板**：LoadImage → ImageScale → VAEEncode → KSampler(denoise) → SaveImage。
- **`input_image` / `denoise` 参数**：`input_image` 传工作区路径会自动上传并填入 `LoadImage`，
  也可以直接传已存在的 ComfyUI input 文件名。
- `comfyui_status` 增加启动参数（`argv`）、部署环境与 embedded python 信息，方便诊断。
- `package.json` 增加 `dshWorkshop` 元数据（安装方式、生命周期、权限、兼容的 DSH 版本）。

### 变更

- 工作流解析（模板 / JSON / 文件 / 已保存名字）抽成一个共用函数，`run` 与 `validate` 行为一致。
- `comfyui_guide` 手册更新：预检章节、img2img 用法、工具清单、推荐流程。
- 版本号 `0.1.0` → `0.2.0`。

### 验证

`node test/smoke.mjs`（真实 ComfyUI）覆盖：10 个工具注册、状态/模型/节点/手册/工作流库、
4 组预检用例、Z-Image 文生图、SDXL 图生图、附件渲染。

## 0.1.0 — 2026-10-17

首个版本：9 个工具（status / list_models / search_nodes / node_schema / run_workflow /
queue / upload_image / workflows / guide）、两个内置模板、工作区落盘、插件配置卡片、独立冒烟测试。
