# ComfyUI 助手 · comfyui-assistant

仓库：<https://github.com/chenjiang2025/ComfyUI-comfyui-assistant>

> **AI 生成说明**：本仓库的代码、文档、内置手册与示例图均由 AI（在 DeepSeek Harness 中运行的 coding agent）生成；人工只提供需求、运行环境与验收。使用前请自行审阅代码。

把本地（或远程）**ComfyUI** 接进 DeepSeek Harness 的插件：让 Agent 能看服务器、查模型、查节点、写 API 格式工作流、**先预检再跑图**，并把产物直接存回会话工作区、同时作为附件内联显示。

对标 ChatGPT 上的 "ComfyUI Assistant"：不是替你点界面，而是把 ComfyUI 的 HTTP API 变成 Agent 手里的工具 + 一本随叫随到的手册。

![AI 生成的示例图：雾中山谷里的小木屋（Z-Image Turbo）](docs/sample-zimage.png)

## 兼容性

| 依赖 | 版本 |
| --- | --- |
| DeepSeek Harness | `0.2.1-alpha.3`、`0.2.1-rc.2`（用到的 `ctx.tools` / `ctx.systemPrompt` / `Config.volatile()` / `ctx.attachments` 在两者上均可用） |
| ComfyUI | `0.34.x`（依赖 `/models`、`/object_info`、`/prompt`、`/history`、`/upload/image`） |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| 构建 | 无。纯 ESM + JSDoc，`lib/*.js` 就是运行时产物 |

## 能力

| 工具 | 作用 |
| --- | --- |
| `comfyui_status` | 连通性、ComfyUI 版本、显卡/显存、队列长度、启动参数 |
| `comfyui_list_models` | 按目录列模型文件（checkpoints / diffusion_models / text_encoders / vae / loras …），支持子串过滤 |
| `comfyui_search_nodes` | 按关键词搜节点类名 |
| `comfyui_node_schema` | 查单个节点的输入/输出定义（类型、默认值、范围、枚举值） |
| `comfyui_validate_workflow` | **提交前静态预检**：节点类是否存在、必填输入、连线槽位与类型、模型文件名、枚举取值、残留占位符 |
| `comfyui_run_workflow` | 提交 API 格式工作流，等待完成，图片存到工作区并**作为附件内联显示** |
| `comfyui_queue` | 队列/历史查看、打断、清空、删除、释放显存 |
| `comfyui_upload_image` | 把工作区图片上传到 ComfyUI input 目录（图生图/编辑场景） |
| `comfyui_workflows` | 自建工作流库：list / get / save / delete（`~/.dsh/comfyui-assistant/workflows`） |
| `comfyui_guide` | 内置手册：api / workflow / nodes / templates / debug / models / prompting / performance |

另外会在系统提示里加一段简短说明，用户提到 ComfyUI、出图、工作流、节点、显存时，Agent 会优先走这些工具而不是瞎猜。

## 安装

从 GitHub 直接装：

```powershell
dsh plugin --profile web add https://github.com/chenjiang2025/ComfyUI-comfyui-assistant
```

本地开发可以 link 安装（改完在插件管理页关一次再开一次即热加载）：

```powershell
dsh plugin --profile web add "C:\path\to\comfyui-assistant"
```

卸载：

```powershell
dsh plugin --profile web remove comfyui-assistant
```

> 修改代码后，在「插件管理页」把本插件关一次再开一次即可热加载（entryId：`include:comfyui-assistant`）。

## 配置

插件管理页 → `comfyui-assistant` → 配置卡片：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `announceToAgent` | `true` | 是否把插件说明写进系统提示 |
| `baseUrl` | `http://127.0.0.1:8188` | ComfyUI 地址；远程机器改成 `http://<ip>:8188` |
| `requestTimeoutMs` | `30000` | 普通请求超时 |
| `runTimeoutMs` | `600000` | 等一次生成完成的最长时间；超时会返回 prompt_id，任务不中断 |
| `saveOutputs` | `true` | 是否把产物下载到会话工作区 |
| `outputFolder` | `comfyui-output` | 工作区内的输出子目录（相对路径，禁止 `..`） |
| `inlineImages` | `true` | 是否把图片作为附件内联显示（依赖 `ctx.attachments`，没有该服务时自动跳过） |

## 用起来是什么样

对话里直接说就行，例如：

- 「看下 ComfyUI 状态，显存还剩多少」
- 「列出 diffusion_models 里有什么」
- 「用 Z-Image 出一张 864x1536 的竖图：雾中山谷里的小木屋，暖光窗户，电影感」
- 「把刚才那张图当输入，做个 img2img，denoise 0.5」
- 「KSampler 的 sampler_name 有哪些可选值？」
- 「刚才那次为什么报错？」

Agent 会自己走：`comfyui_status` → `comfyui_list_models` → `comfyui_node_schema` → `comfyui_validate_workflow` → `comfyui_run_workflow`，出错时读 `node_errors` 修。

### 内置模板

`comfyui_run_workflow` / `comfyui_validate_workflow` 可以直接用模板名，不必手写 JSON：

| 模板 | 说明 | 默认 |
| --- | --- | --- |
| `zimage-t2i` | Z-Image Turbo 文生图（UNET + CLIP + AE） | 864×1536，8 步，CFG 1 |
| `sdxl-t2i` | SDXL 文生图（CheckpointLoaderSimple） | 1024×1024，25 步，CFG 7 |
| `sdxl-img2img` | SDXL 图生图（LoadImage → ImageScale → VAEEncode → KSampler） | 1024×1024，25 步，CFG 7，denoise 0.6 |

占位符：`{{prompt}}` `{{negative_prompt}}` `{{seed}}` `{{width}}` `{{height}}` `{{steps}}` `{{cfg}}` `{{batch_size}}` `{{denoise}}` `{{input_image}}`。
也可以用 `substitutions` 自定义占位符，用 `overrides` 按节点 id 直接覆盖输入：

```json
{
  "template": "zimage-t2i",
  "prompt": "a red apple on a wooden table",
  "seed": 42,
  "overrides": { "3": { "denoise": 0.8 } }
}
```

图生图：`input_image` 传工作区图片路径会自动上传并填入 `LoadImage`：

```json
{
  "template": "sdxl-img2img",
  "input_image": "comfyui-output/xxx.png",
  "prompt": "oil painting style",
  "denoise": 0.5,
  "seed": 7
}
```

### 工作流必须是 API 格式

ComfyUI 前端「保存」出来的是 UI 格式（`nodes` / `links` 数组），本插件只吃 **API 格式**：

```json
{
  "3": {
    "class_type": "KSampler",
    "inputs": {
      "model": ["28", 0],
      "positive": ["27", 0],
      "seed": 12345,
      "steps": 8
    }
  }
}
```

在 ComfyUI 里用「导出 (API)」得到，或让 Agent 按 `comfyui_guide topic=workflow` 的规范生成。

### 为什么先预检

`comfyui_validate_workflow` 拿 `/object_info` 当对照，能在**不占 GPU**的情况下抓出：

- `class_type` 不存在（拼错 / 自定义节点没装）；
- 必填输入缺失、输入名拼错；
- 连线写错节点、槽位越界、类型不匹配（MODEL 接到 CLIP 之类）；
- 模型文件名不在枚举里（会给出相似项）；
- 数值越界、残留 `{{...}}` 占位符、没有输出节点。

比提交后等 400 再排查快得多——低配机器上尤其值。

## 目录结构

```
comfyui-assistant/
├─ package.json          # dsh.bundle.patch + dshWorkshop 元数据
├─ cordis.patch.yml      # 插入 loader 行
├─ lib/
│  ├─ index.js           # 插件入口：Config、系统提示、10 个工具
│  ├─ comfyui.js         # ComfyUI HTTP 客户端（仅 node 内置 fetch）
│  ├─ templates.js       # 内置工作流模板（含 img2img）
│  └─ guide.js           # 内置手册正文
├─ docs/sample-zimage.png
└─ test/smoke.mjs        # 独立冒烟测试（可脱离 DSH 运行）
```

## 开发 / 测试

```powershell
cd "C:\Users\辰\Documents\deepseek-harness\默认工作区\comfyui-assistant"
node test/smoke.mjs            # 全量（含 t2i + img2img 两次真实出图）
node test/smoke.mjs --no-run   # 跳过 GPU 生成，只跑预检/查询
```

`test/smoke.mjs` 用假的 cordis context 调真正的 `apply()`，并直连 `http://127.0.0.1:8188` 验证：

1. 10 个工具注册成功、schema 合法；
2. 状态 / 模型 / 搜索节点 / 节点 schema / 手册 / 工作流库往返；
3. 预检：合法模板通过、坏 class_type 报错、错模型名给出候选、残留占位符给提示；
4. 用 `zimage-t2i` 真跑一张图，确认落盘字节正常且 render 产出 image block；
5. 用 `sdxl-img2img` 跑图生图，确认工作区图片被自动上传。

> 本地测试依赖 `node_modules/@deepseek-ai` 这个 junction（指向 DSH 安装目录的 `@deepseek-ai`），
> 用来在 DSH 之外解析 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`。
> 安装到 DSH 后运行时不需要它（由 DSH 的 profile 解析负责）。

## 排错

- **连不上**：`comfyui_status` 会给出具体原因；确认 ComfyUI 在跑、端口对、`baseUrl` 对。
- **HTTP 400 / node_errors**：先用 `comfyui_validate_workflow` 预检；它查不出的问题再看 `node_errors`。
- **执行阶段报错**：`comfyui_queue action=history` 里能看到 `execution_error`；显存不足先 `action=free`。
- **超时**：返回 `prompt_id` 说明任务还在排队/执行，别重复提交；用 `action=history` 再查。
- **改了代码没生效**：插件管理页关一次再开一次（热加载），或重启 DSH。

## 已知限制

- 只有 Host 半边，没有独立的浏览器面板：配置与开关在「插件管理页」的配置卡片里，产出在对话与工作区里。
- 同步等待生成；超时只返回 `prompt_id`，不会自动取消（除非调用方取消当前工具执行，此时会 `POST /interrupt`）。
- 预检是静态的：它不跑图，抓不到显存不足、模型损坏这类运行时问题。
- 只读 ComfyUI 的公开 HTTP API，不依赖前端扩展/自定义节点源码；节点信息来自 `/object_info`，自定义节点装了就能查到。
- 输出图片按 `prompt_id` 前 8 位 + 原文件名落盘，同一工作流重跑不会覆盖旧图。

## 变更记录

见 [CHANGELOG.md](CHANGELOG.md)。
