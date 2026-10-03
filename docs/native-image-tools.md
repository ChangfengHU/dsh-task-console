# 内置生图工具

Agent → 工具与权限 → 图像 → 勾选 `image_generate · Codex / Gemini`。
这是原生 Tool，不是 MCP；主会话可以使用任何模型。未勾选的 Agent 不获得工具，已有 Agent 不会被自动启用。

Agent 配置包含默认后端、允许后端、是否允许任务覆盖、提交前未就绪时是否允许切换，以及每会话请求上限（默认 12，最大 100）。配置资产导出/导入保留这份策略，不携带登录、OAuth、账号池密钥、生成回执或图片。

## 宿主条件

- Codex：同机安装并登录的 `dsh-codex-claude-cli` provider，启用原生 image generation，以及 DSH attachment store。通过 Task 插件的 `codexImageProvider` / `codexImageModel` 选择独立生图路线，不继承主会话模型。
- Gemini：同机 AG Account Pool 的原生 `/gemini/v1beta/...:generateContent`，图片模型默认 `gemini-3.1-flash-image`。不是 `/v1/chat/completions`。宿主可设置 `geminiImagePoolDir` / `geminiImageModel`；仅从该机器已有私有文件读取凭据，禁止 Agent 传 URL、文件路径或密钥。
- 每台机器需独立验收；勾选或模型目录存在不等于当前登录/额度有效。Gemini 池应使用精确图片模型路由补丁，禁止图片请求落入文字模型的 fallback pool。

## 调用

1. `image_generate({prompt,requestId,backend?,referenceAttachmentIds?})` 受理后立即返回 `jobId`。同一请求复用 `requestId`；提示词/参考图改变则使用新 ID。
2. `image_generate_status({jobId,waitMs?})` 默认有界等待 15 秒，成功返回真实图片 attachment blocks。`running` 不是成功。
3. `image_generate_cancel({jobId})` 取消自己的任务。只取消查询等待不会取消后台生成；取消不保证上游没有消耗额度。

参考图最多四张，只接受当前会话消息中已有的结构化图片附件 ID；不解析文本里的假附件，不接受任意路径或远端图片 URL。

宿主全局最多两项并发。请求先记录到 `dsh_native_image_jobs`（本机 Task SQLite），再调用上游。完成 Task 前若图片仍在生成则拒绝提前交卷。超时、宿主重启及已提交失败不自动重发、不切换后端；仅明确的提交前未就绪且 Agent 授权时允许切换一次。会话请求上限不是价格额度，也不替代视频工作室独立的业务预算/质检闸门。

`scripts/verify-native-images.mjs` 是显式、消耗额度的验收，不属于单元测试。需传同机 Codex 插件文件、可执行文件、后端和输出目录，使用现有认证，不导出凭据。

## 2026-10-03 本地验收与发布边界

- 实际调用：Codex 返回 1254×1254 PNG；Gemini 原生通道返回 1408×768 JPEG。回执和图片保存在本机验收目录，不入仓库。
- 浏览器：独立 3081 环境新建测试 Agent，保存 Gemini 默认、双后端授权、允许覆盖、3 次上限，刷新后配置仍正确。原 3080 环境未替换。
- 专项回归：13 项通过，包括真实 ToolRuntime、严格 JSON、幂等、取消、未知结果不重放、配置包往返和附件归属。
- 全套回归：380 项中 379 项通过，剩余是既有 sidebar bridge 对宿主构建的 `undiscoverableSessionIds` 假设；当前本机宿主备份不包含该变量。尚不能宣称全套通过。
- 尚未发布 GitHub 或正式环境。当前本地 Studio 工作区存在未提交功能；线上 feature 分支引用未提交模块，不能独立构建。统一 main 前须确定是完整整理 Studio，还是仅发布生图并保留实验部署，不能以较小 main 替换实验环境而静默丢失能力。
- 远端 Gemini 还需同机账号池与精确图片模型路由验收；本地出图成功不证明远端认证、配额或部署已经就绪。
