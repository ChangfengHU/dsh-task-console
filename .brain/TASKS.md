# 后续优化

- [ ] [TASK-PATROL-OBSERVATION-016] 0.30.11：修复仅刷新旧回执消耗返工轮次、最后评估提前交接、nextCheckAt随轮询漂移；补齐MCP回执解析/代理同轮范围报错。249测试/构建通过，零活跃后部署；保持新鲜未登录授权、持久预算、20分钟4样本、全部历史。原Task新Batch b-chat-4c400a667d4b4abcbac7中，真实浏览器管理员已对84/b1执行一次provision且09:47 UTC验证通过；6代理独立通过，84/b1及187/b2、188/b2稳定性采样仍待完成，定时关闭。一次可见代理纠正消息及同规划卡解除阻塞均保留，不宣称无人干预全程通过。旧Batch b-chat-843489163446c3f00418已未通过收口；详见既有Creator dev-log末尾。

- [ ] [TASK-PATROL-RECOVERY-015] 0.30.10：加入独立审查的recover、排除节点和completed-patrol定时启用策略；仅新鲜原生CDP失败允许冻结受限恢复，保留20分钟4独立样本/持久预算/通知送达，206真实不可达单独保留；执行UI区分已结束未通过与未结束。244测试/构建、公网1440/390px通过。原Creator修订P-chat-b44a2477ac7d83039a88已审查，仍复用原巡查Task，新Batch b-chat-843489163446c3f00418正在运行；宿主只增187/b2 recover权限，无开发者目标机器操作，定时仍关闭，不能称恢复或验收完成。见既有Creator dev-log末尾。

- [ ] [TASK-PROXY-WORKFLOW-014] 0.30.9：代理MCP已接入原巡查Task；241测试/构建、公网桌面/390px验收通过，冷启动未优化。真实DSH Agent已修复84 line-100，五路径63.124.160.54；两浏览器由browser-manager各复制一次不同授权账号，独立4样本分别跨22m02s/21m46s通过，末次只读代理复验亦通过。原Task Batch b-chat-505cc3698915b4635bb1已收口：17卡完成、6通知sent，业务unresolved/failed（10/11浏览器通过，187/b2 cdp-unavailable、206未覆盖），不是执行协议失败。原Task与所有失败历史保留；两业务角色仅切至已验证Codex模型，其余配置哈希不变，经Creator新计划独立审查；定时仍关闭、无活跃操作。不宣称全机群已达标；187/206是剩余覆盖问题。完整回执、采样与浏览器证据见既有Creator dev-log末尾。

- [ ] [TASK-PROXY-MCP-013] 0.30.8：已开发可独立启动的vyibc-proxy stdio MCP（inspect/verify/repair/status），SDK真实客户端握手/隔离调用、233全量测试及17远端模拟故障测试通过。复用Controller事务预检/替换/启用/回滚，受限恢复既有Controller；独立五路径出口证据、同机自修拦截、逐节点授权、幂等/持久锁/不确定结果保护、无凭据回显。回执查询失败不能解除旧操作锁，必须精确匹配终态回执。未写生产策略或MCP加载连接、未改Agent权限/Task历史/定时，未SSH目标机，不能称84已修复。待审查工具授权及Task执行支线/网络闸门接入；配置和限制见docs/proxy-mcp.md，证据见既有Creator dev-log最新段。

- [ ] [TASK-PATROL-PROXY-012] 0.30.7：用户要求通过原巡查 Task 尝试协调 Clash 与登录，不直接操作机器。真实 Creator 会话 agent-task-create-agent-mtwlf6hg 已核对名册并指出编排缺口；修正 task_create_status 将受阻执行泛称 running 的反馈，新增原暂停 cron Task 的 revise 待审查/CAS更新、前后定义展示、历史冻结保护和重新手动验收门槛。222测试、构建、公网桌面/手机审查交互通过；草案P-chat-d8ad16b93f2514100edf因未实现网络闸门、规划者无状态查询工具和固化本轮资源/状态而退回，未批准或执行。未增加代理执行支线/跨Task互斥/网络证据闸门，不得将此基础改进当作84恢复。原巡查Task定义与2Batch在部署前后逐行哈希一致，cron仍关闭，无目标机器操作或权限变更。详细证据及后续能力缺口见既有 Creator dev-log 最新段。

- [x] [TASK-PATROL-EVIDENCE-011] 0.30.6：巡查本轮独立验收与实时回执新鲜度分开；有效检查不因交接耗时到期变成未登录。后续未知/掉线/换号、验证操作拒绝/中断、新的修复操作仍使旧证据失效；修复后的完整稳定性窗口及新鲜未登录才可复制的约束保留。页面按回放快照区分检查事实、待刷新、明确未登录、证据不足、稳定性待验与未覆盖，支持待关注筛选和证据详情；旧 accepted/outcome/通知不改写。219测试、构建、公网旧执行/回放/手机/暗色及浏览器内新状态夹具通过；32Task/63Batch和8张证据相关表逐行哈希未变，未创建真实执行、未操作机器、未发企微，巡查定时保持关闭。详见 dev-log/2026-09-09-task-creator-review.md 最新段；这是插件验收，不是新的真实巡查通过。

- [x] [TASK-EXECUTION-UX-010] 0.30.5：执行选择改为单行日期/状态与更多菜单，归档筛选按需展开；新增任务中心/卡片/选择器可达的执行历史页与十条SQL分页，支持任务/状态/编号/归档查询。暂停cron不再隐藏@入口，手动复用仍核对已审查输入/角色指纹并保持定时关闭；未归档/幂等/重叠/失败试跑门槛不放宽。210测试及公网桌面/手机/暗色、历史切换、筛选、受拦截@提交和浏览器内分页交互通过；未创建真实执行、未操作机器，巡查仍待业务验收。证据见 dev-log/2026-09-08-execution-labels.md 最新段。

- [x] [TASK-WORKFLOW-REEXECUTE-009] 0.30.4：仅归档旧Batch b-chat-b4c6fcb369f0c20a9739，32Task及全部历史保留。首个新Batch b-chat-53c7651dd3a78824d506 虽通过业务20分钟验收，但Qwen未正式交卷而failed，历史保持不变；工具确实暴露、非token截断，已补同会话异步终态续接及默认prepare参数提示，208测试/构建通过，零运行后部署并推送145d2152。第二新Batch b-chat-dda870d91626c9e0a9e6于2026-09-10 10:23:52–10:53:36 UTC真实完成：装机十阶段通过，Runner八项签名检查通过；浏览器prepare changed=[]/未重启/资料保留、两登录reused=true，操作2fd4b727b7fde3d9210d17a05b0a20f5的双实例22/23样本分别覆盖1259718/1319737ms，stable=true，Qwen实际task_complete且宿主验收成功，三角色均done。此次模型主动轮询至终态，新增宿主唤醒分支仅单测覆盖，不声称实跑覆盖。公网浏览器确认3完成/0未完成、执行报告、Trace和原会话跳转，无页面异常/横向溢出。首失败Batch/旧归档/巡查Task不删不改，定时仍关闭；窗口通过不等于未来永不掉线。详见既有工作流dev-log最新段。

- [x] [TASK-BOARD-ARCHIVE-008] 0.30.1：用户要求页面只显示仍需使用的任务；已精确归档30个旧Task，保留装机 T-chat-b4c6fcb369f0c20a9739 与巡查 T-chat-bbb714b2ba8439b69178。旧任务停用并从主列表/搜索/执行候选隐藏，全部历史执行、通知、计划及494个会话不删；两个主Task定义/状态不变，巡查仍关闭定时。201测试、构建、公网1600/390px两卡、旧任务搜索隐藏及历史链接禁执行验收通过。详见既有dev-log本日归档段。

- [ ] [TASK-PATROL-SCHEDULE-007] 0.30.2：用户恢复模型后，同 Task 第二手动 Batch b-mtv9vz6v19v 于2026-09-10 08:35:57–09:03:30 UTC完成两轮真实只读巡查，最终 unresolved/failed。首轮11实例均取得独立 verified；187/b1读取竞态由linux-clash修复后真实复验通过。收口时6项证据过期；次轮95/b3因正在处理其他工作拒绝验证，保留206不可达/无读取授权覆盖缺口，无复制/重启/删除。六条独立企微阶段通知均sent；超预算返工通知曾先于计划拒绝发出，历史不改写。已补“已知覆盖缺口+未改动独立证据过期可如实未通过收口”及超预算返工通知护栏；204测试/构建通过，运行全部结束后部署，不将补丁测试算作新的业务验收。Qwen实际执行浏览器/通知员，Codex恢复后执行规划/评估；未实现自动模型fallback、未变更已审查角色。定时仍关闭，两个主Task与30个归档Task/全部历史保留。63新完整装机尚未启动；已询问是否保留原合同双浏览器20分钟验收，待答，不擅自减弱合同。详见既有dev-log最新段。

- [x] [TASK-CREATOR-REVIEW-004] 0.28.1：结构化设计/独立审查/幂等放行/分页审查上线。两次错误完成报告保留；增强 MCP 登录证据分类及显式 browser-patrol-v1 宿主闸门。最终真实 Task T-chat-40a78cfa15b039ba4589 于 2026-09-09 07:10:56 UTC 自主 task_block、nudges=0；宿主从真实工具事件计算 11 实例=3 verified/6 unknown/2 skipped，未伪造绿色完成。173 项回归、公网桌面/390px审查与导航通过。见 `dev-log/2026-09-09-task-creator-review.md`。
- [ ] [TASK-BROWSER-PATROL-COVERAGE-005] 0.28.2：Fleet 自动业务隔离已移除；真实巡查 Task T-chat-e5d640c5595bedcf83eb 第三 Run 已完成，登录复制均由 browser-manager 经 MCP 执行。188/browser-3 展示遗漏另经独立审查修复（见下一项）。全部已观测实例的回执保留，但不可达206无浏览器观测不等于不存在或验收通过；不宣称未观测范围全量达标，不重复63的20分钟验收。
- [x] [TASK-BROWSER-OBSERVATION-006] 188/browser-3：Creator 生成并经独立审查的 P-chat-17143dab0c6d2d5c4b5e → Task T-chat-8c09e935a94ae56de699。Run2 仅修旧 HTTP 登录观察循环，保留三个PID/CDP/生图配置和登录；Run3 于09:14:12UTC 自行 task_complete，引用真实verify和独立fleetDisplay。公网Chrome60秒三次加载均显示三个Gemini账号；原两次blocked保留。MCP修复及78 Node/27 Python验收属于linux-clash仓库，本插件未改业务代码或重启。见现有dev-log。

- [x] [TASK-BROWSER-LOGIN-002] Task T-chat-61d84a0199aabbe795dc 首次准备与 browser-1 单次复制完成，browser-2 复用。0.27.4 修复宿主提前结束后，第二 Batch b-chat-619ec90823195dd9e78b 于 2026-09-09 03:22:42 UTC 完成20分钟只读验收、各21样本、stable=true，浏览器管理员自行调用 task_complete。原失败 Run 和回执保留；不代表未来永不失效或完整装机已稳定。
- [x] [TASK-BROWSER-POOL-003] 账号池规则在 linux-clash/browser-manager 实现，宿主策略明确排除指定账号、其余四个批准账号仍须实时验证；本插件不另造账号库。新 generation 会话 agent-browser-manager-mttkrxrj 仅调用两次 candidates，展示五账号、排除/未验证原因并保留两实例有效登录。75 项相关 Node 测试通过；没有为分散账号再次改动健康目标，未以只读查询冒充多账号实际复制验收。开发者只完善工具/角色，目标操作与任务收口由真实 DSH Agent 负责；20分钟自主收口证据见上一项。

- [x] [TASK-CREATE-JSON-001] 0.27.3：修复自定义工作流目录中 undefined 导致的 lossless JSON 拒绝；162 项回归/构建通过。原 Creator 会话重试成功创建下述真实 Task，原始失败和旧计划均保留。

- [ ] [TASK-BROWSER-REBUILD-001] Task T-chat-9fd1c8bfa45d890b9ce4 由浏览器管理员实际完成 63 browser-2 无备份删除、原槽位重建和一次授权登录复制；旧资料约 582 MiB 永久删除。双浏览器20分钟验收因 browser-1 signed_out 失败，Task/Run 均 blocked。browser-1 未被删除、重启或作为复制目标，但掉线原因未定；browser-2 仅短期已验证，不能宣称稳定。停止重试，不擅自修复 browser-1；本行取代下方旧计划的下一步指引，历史不改写。见现有 dev-log 最新段落。

- [ ] [TASK-WORKFLOW-002] 0.27.2：旧 Task 精确备份删除，21 个其他 Task 和全部会话保留。新 Task T-chat-b4c6fcb369f0c20a9739 的装机/Runner 通过；浏览器五次真实尝试未通过最终验收。最新正常续接成功选中授权账号（嵌套元素已修复），随后 Google 要求交互验证；等待用户在 browser-2 完成，再在同 Task 做双浏览器20分钟验收。不能宣称装机工作流已完成。运行中阻塞保护及终态回执纠正已实现；162 项 DSH 回归/构建、55 Node/19 Python 及公网计划/Creator/历史导航/移动端验收通过。见 `dev-log/2026-09-08-workflow-plan-login.md`。

- [x] [AGENT-HISTORY-001] 0.25.0：新会话 @ Agent 默认最新五条、展开/收起与全名册搜索；Agent 详情支持配置/会话/任务页签、服务端分页、创建者与实际参与者关联、北京时间和原会话跳转。保留草稿及返回页码；不读取完整会话日志、不操作目标机器。140 项测试及真实公网桌面/窄屏交互验收，见 `dev-log/2026-09-08-agent-history.md`。

- [x] [TASK-CREATE-001] 新增通用 task-create-agent、Agent/Workflow @ 入口和幂等提交账本；复用既有 Task/Batch/Run 调度及角色权限。63 已通过三角色自动协作及原 Task 第二次执行；第二轮装机十阶段 reused、changed=0，原始上游交接完整传达。数据库回放、全屏检查器、Trace/原会话跳转和文字报告均经过真实浏览器测试。见 `../dev-log/2026-09-07-task-create-workflow.md`。

- [x] [TASK-HISTORY-ID-001] 修复兼容模型空 tool-call ID 导致的 Chat/Trajectory 重复匹配及冷启动历史校验失败；保留原始日志，按流事件与 sourceEventSeqs 在读取时恢复关联。真实公网会话冷启动、40 次工具详情及 Trace 验收通过，见 `dev-log/2026-09-06-history-mcp-repair.md`。

- [x] [TASK-INTAKE-REPORT-001] 支持单会话汇总接收、提前持久化 Session/入参回执、独立 item 决策与已接收请求去重；保留真实角色与对话，Fleet 第一阶段不等待修复。（0.23.0，生产浏览器验收见对应 dev-log）

- [x] [TASK-PERF-001] 将 `dsh-task-console` 改为轻量启动入口，任务页面、DAG 与 Trace 在用户进入对应界面后再懒加载。（0.17.5）
  - 现状基线：公网冷缓存测试中，HARNESS 完成加载约 71 秒；`dsh-task-console` 客户端传输约 167 KB，单项耗时约 31.6 秒。
  - 约束：保持技术包名、Typert namespace、SQLite 数据与现有任务 URL 兼容。
  - 验收：首屏只加载菜单注册所需的轻量代码；未打开 Board/Trace 时不下载其实现；分别记录冷缓存和热缓存的首屏时间及按需模块加载时间。
  - 实测：本机真实 Chrome 禁用缓存后，轻入口约 1.25 秒注册、传输 6,958 B，未请求 601,209 B 的重模块；点击 Board 后约 1.0 秒呈现任务中心并加载重模块。公网任务详情约 20.1 秒可交互；总 HARNESS 时间仍会受到 Station、Skill/MCP Console 等其他大插件影响。
  - 关联原型：`prototype/task-session-lightweight-v1.html`。

- [x] [TASK-FLEET-001] 为“装机者”增加四个 IP-only 装机工具、固定 Skill 版本、工具级权限隔离、中央账本及 DSH→Cloud Workflow 幂等续跑桥。
  - Stage 2 仅走受限 host-adapter；Stage 5/6/7/8/10 走控制面；Stage 1/3/4/9 为新鲜探测闸门。
  - Cloud 成功后仍须新鲜宿主探测证明健康；运行中操作沿用相同 operation ID 和账本 attempt。
  - 代码和离线回归完成，生产配置、迁移、隔离节点集成验收与部署尚未执行。
