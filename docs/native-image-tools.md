# 内置生图工具

这是 DSH 宿主层的默认原生 Tool，不是生图 Agent，也不是 MCP。标准会话无需新建 Agent、无需勾选便可继承 `image_generate` / `image_generate_status` / `image_generate_cancel`。主会话可以使用任何模型。

普通生图/编辑请求优先使用内置工具；仅本地工具未安装、明确提交前不可用，或用户明确指定已授权 MCP 时考虑 MCP。超时、取消、执行不明、已提交失败不能作为补发 MCP 的理由。这个优先级写入工具说明与宿主上下文，不改变用户原有 MCP 授权。

受限自定义 Agent 仍遵守原有工具围栏，可在「工具与权限 → 本机」选择这项宿主工具并设置后端覆盖，不会绕过显式排除。测试用的 `native-image-acceptance` 不是能力实现或使用前提。

Agent 配置包含默认后端、允许后端、是否允许任务覆盖、提交前未就绪时是否允许切换，以及每会话请求上限（默认 12，最大 100）。配置资产导出/导入保留这份策略，不携带登录、OAuth、账号池密钥、生成回执或图片。

## 宿主条件

- Codex：同机安装并登录的 `dsh-codex-claude-cli` provider，启用原生 image generation，以及 DSH attachment store。通过宿主的 `codexImageProvider` / `codexImageModel` 选择独立生图路线，不继承主会话模型。
- Gemini：优先使用已认证账号池的 `/images/v1/generate`，旧池兼容原生 `/gemini/v1beta/...:generateContent`，图片模型默认 `gemini-3.1-flash-image`。不是 `/v1/chat/completions`。宿主可设置本机 `geminiImagePoolDir` / `geminiImageModel`，或下文的远程通道；凭据来自宿主私有文件、DSH credential service 或环境变量，禁止 Agent 传 URL、文件路径或密钥。
- 每台机器需独立验收；勾选或模型目录存在不等于当前登录/额度有效。Gemini 池应使用精确图片模型路由补丁，禁止图片请求落入文字模型的 fallback pool。

## 调用

1. `image_generate({prompt,requestId,backend?,referenceAttachmentIds?})` 受理后立即返回 `jobId`。同一请求复用 `requestId`；提示词/参考图改变则使用新 ID。
2. `image_generate_status({jobId,waitMs?})` 默认有界等待 15 秒，成功返回真实图片资产元数据，不向会话模型返回图片块。用户在本会话 Images 页查看/下载图片。`running` 不是成功。
3. `image_generate_cancel({jobId})` 取消自己的任务。只取消查询等待不会取消后台生成；取消不保证上游没有消耗额度。

参考图最多四张，只接受当前会话消息中已有的结构化图片附件 ID，或宿主记录属于当前会话的已识别/已生成资产；不解析文本里的假附件，不接受任意路径或远端图片 URL。

## 固定识图与模型无关的回执

识图和生图是同一现有仓库中的宿主能力，不是新的 Agent、MCP 或独立仓库。

- `read_image` 保留原生工具的参数、权限、文件解析、格式/大小验证及附件存储。在执行扩展中只给原生读图的图片准入检查提供独立视觉路线，真实会话模型选择不变；固定视觉模型单次读取附件，结果以文字/JSON 返回。
- `visionProvider` 默认 `qwen-bailian`，`visionModel` 默认 `qwen3.7-plus`，可在 Task 插件或独立 native-image-host 的宿主配置中修改。模型必须真实支持图片且该机器认证可用；不自动切换备用模型。读取图片会调用专用视觉后端，可能计费；识别报告不是主模型直接看到原图，不能保证像素级判断。
- 三项 `image_generate*` 全部返回文本 JSON，包括 completed 重放与取消已完成任务。生成后端选择继续使用已有 Codex/Gemini 策略，与聊天模型无关。
- Images 会话页通过现有受保护 Remote API 查询属于指定会话的任务，再读取该任务已完成的资产；不新增公开图片 HTTP 路由，不将图片块塞回聊天历史。资产 API 不接受任意附件 ID 或文件路径。
- 新源文件 `src/fixed-vision.ts` 位于 `dsh-task-console`；不直接修改第三方宿主包。独立宿主挂载入口保持 `dsh-task-console/native-image-host`，原工具围栏保持有效。

宿主全局并发默认 10，可由宿主配置调整。请求先记录到独立 `$DSH_HOME/native-images/jobs.sqlite`，不依赖 Task 数据库或 Agent preset，再调用上游。Task 插件通过宿主服务读取未结束的图片任务，拒绝提前交卷。超时、宿主重启及已提交失败不自动重发、不切换后端；仅明确的提交前未就绪且授权时允许切换一次。会话请求上限不是价格额度，也不替代视频工作室独立的业务预算/质检闸门。

可独立挂载 `dsh-task-console/native-image-host`，只依赖 `tools`、`llm`、`attachments` 三项 DSH 宿主服务，无需挂载 Task。Task 主入口也会在未安装时挂载一次；勿重复安装。宿主未显式配置时优先 Gemini/agy-pool；没有可用池时仅在提交前允许回落到 Codex。受限 Agent 既有默认/允许后端策略不改写；调用明确指定 backend 时不跨后端降级。

## 账号池优先级与并发（2026-10-06）

`imageConcurrency` 为宿主总并发，默认 10，可设置 1–100。多个会话共享上限；达到上限仍直接拒绝而非持久排队，拒绝发生于提交上游前。同一 requestId 重放仍只返回原任务。10 不是上游配额保证。

Gemini 先预检本机账号池凭据及指定图片模型，再预检宿主已认证通道，最后使用 CF 服务；本机缺失、认证拒绝、目录不可用时远程也可独立工作。显式通道配置为 `{id,origin,apiKeyEnv}`；密钥引用每次操作通过 DSH credential service 解析，只有未安装 credential service 时才读取宿主环境变量，存在 credential service 但引用缺失时不会用陈旧环境变量绕过。Agent 不能提供地址或密钥。origin 仅允许 HTTPS 根地址或私有 loopback SSH 转发；不能把原生 relay 密钥暴露到公网。现有池管理域名/OpenAI 文字 API 不等于可用的图片 API。现有原生网关校验 Host，SSH 转发必须保留网关端口；端口被本地占用时需独立受保护适配，不通过伪造 Host 或删除校验绕过。

## 2026-10-07 宿主认证自动发现（源码优化，发布状态另行验收）

- Models 页面保存的远程账号池配置位于宿主 `llm-pi-ai.providers[ag-pool*]` 的 `baseURL` / `apiKeyEnv`。内置工具读取同一个已解析 Settings namespace，并从 credential service 按引用获得当前 service API key；不复制 Google OAuth、不读取 Agent 配置、不迁移密钥。
- 顺序为：标准本机账号池私有凭据 → 显式 loopback 通道 → 宿主发现的 loopback 通道 → 显式远程通道 → 宿主发现的远程通道 → CF。各组顺序稳定；同名显式通道优先于发现通道。loopback 只说明传输地址，不代表隧道对端一定是物理本机。
- 自动发现只接受活动的 `ag-pool` 系列 provider（宿主未提供 LLM directory 时仍可读取其 Settings）；仅接受 API key 引用与根地址或已知 `/v1`、`/anthropic`、`/gemini/v1beta` 前缀。带内嵌凭据、查询/片段、明文公网 HTTP、未知前缀、inline key、无引用或无图片模型的来源不会被调用。
- 新操作重新读取 Settings 和 credential 引用，撤销/换钥在下一次提交前生效。只在预检阶段选路；已经提交后的失败、超时和未知状态仍不跨后端重发。
- 单元/后端集成测试验证自动发现、目录认证、优先级、撤销、参考图片保存和提交失败不补发；这些测试不等于 3080 或远程生产已经部署，也不替代真实远程并发验收。

本机/远程账号池预检每通道最多等待 5 秒；最后的 CF 服务预检最多 30 秒（需查询共享账号目录）。默认 CF 地址为 https://image-api.vyibc.com，凭据仅使用宿主 DSH_IMAGE_SERVICE_TOKEN；未提供 scoped 凭据时不开放匿名调用。图片请求提交后失败/取消/超时不换通道重发。成功回执附 `route` 和 `routeReason`，不包含 origin 或密钥。显式选择 Gemini 不自动改成 Codex。该次本机实测 10 个工具调用均成功，总耗时约 13.7 秒，实际图片模型 gemini-3.1-flash-image；不代表远程或长期满负载已经验收。

本次验收范围：直接执行注册的工具执行器、持久任务服务和真实账号池后端，不是 3080 浏览器端到端验收。仅远程模式通过私有 SSH 同端口转发到 host-188，真实返回一张 JPEG，模型 gemini-3.1-flash-image，耗时约 126.6 秒。临时转发和测试凭据在验收后撤除；正式环境的持久隧道/环境变量仍需安全部署，不能声称已经启用远程兜底。图片已抽查，单次成功不证明持续并发容量。专项 32 项回归通过；全量失败仍阻止正式发布。

`scripts/verify-native-images.mjs` 是显式、消耗额度的验收，不属于单元测试。需传同机 Codex 插件文件、可执行文件、后端和输出目录，使用现有认证，不导出凭据。

## 2026-10-07 本轮真实验收与限制

- 3081 测试产物来自当前 main 工作区，标准 Agent、DeepSeek 聊天模型实际调用一次内置 `image_generate`，本机 Gemini 路线返回 1408×768 JPEG，406686 字节，任务耗时 19.273 秒；未使用生图 Agent、MCP、浏览器或 shell 生成。
- CF URL 交付的 10 个独立并发请求 10/10 成功，用到 10 个独立账号；全部 URL 就绪 145.885 秒，全部下载验证 147.086 秒，单张下载 0.802–3.165 秒。不能归因于下载，也不能与较早不同条件的本机 16.5 秒直接当作受控性能对比。
- DSH 当前工作区回归已达到 1370 项通过、零失败和零跳过；此前 dated 记录中的失败数是历史结果。并行的其它功能改动仍需分别确认发布归属，工作区通过不等于正式发布 SHA 已验收。
- 浏览器自动化目前无法连接；本轮仅完成真实原生会话/HTTP 验收，未声称 3081 或 Pages 页面视觉交互通过。3080 和 host-95 未由本轮切换，生产 MCP dispatcher 仍未接入此 API。
- CF 管理台为 https://vyibc-image-console.pages.dev，只需 scoped 生图服务 API Key，不保存到浏览器持久存储。本机图片只上报用量、无 R2 图片上传；精确剩余额度与 live 账号健康仍显示未知。

## 2026-10-03 本地验收与发布边界

- 实际调用：Codex 返回 1254×1254 PNG；Gemini 原生通道返回 1408×768 JPEG。回执和图片保存在本机验收目录，不入仓库。
- 浏览器：独立 3081 环境新建测试 Agent，保存 Gemini 默认、双后端授权、允许覆盖、3 次上限，刷新后配置仍正确。原 3080 环境未替换。
- 专项回归：13 项通过，包括真实 ToolRuntime、严格 JSON、幂等、取消、未知结果不重放、配置包往返和附件归属。
- 全套回归：380 项中 379 项通过，剩余是既有 sidebar bridge 对宿主构建的 `undiscoverableSessionIds` 假设；当前本机宿主备份不包含该变量。尚不能宣称全套通过。
- 尚未发布 GitHub 或正式环境。当前本地 Studio 工作区存在未提交功能；线上 feature 分支引用未提交模块，不能独立构建。统一 main 前须确定是完整整理 Studio，还是仅发布生图并保留实验部署，不能以较小 main 替换实验环境而静默丢失能力。
- 远端 Gemini 还需同机账号池与精确图片模型路由验收；本地出图成功不证明远端认证、配额或部署已经就绪。

## 2026-10-04 接入层纠正

- 改为宿主默认内置工具；Agent 配置只提供受限 preset 的授权与后端覆盖，不再是工具注册的必要条件。
- 专项回归 14 项通过，其中新增无 Task 服务、无生图 Agent 的普通会话工具调用测试，以及优先级上下文在工具被排除时不注入的测试。
- 实际 DSH 3081 标准会话 `native-tool-standard-20261004`：真实 `request/header` 含三项 `image_generate*`，仅调用 `session_capabilities` 并正常结束，正确说明内置优先和指定 MCP 例外。未实际生图、未调用 MCP、未委派。
- 当时 3080 仍有活动会话，本次未中断它或替换其 Studio 部署；远端仍未发布。
