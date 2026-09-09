# 后续优化

- [ ] [TASK-CREATOR-REVIEW-004] 0.28.1：结构化设计/独立审查/幂等放行已上线；两次实跑揭示 Cookie 误判及明细与汇总矛盾，旧完成声明均不算验收通过。增加显式 browser-patrol-v1 宿主闸门，按当前 Session 的真实 MCP inventory/inspect 事件计算结果，未知不能绿色交卷。新计划 P-chat-302a4f7a5135763e960b 已实际配置闸门并进入最终复测；旧计划/Task 全部保留。173 项回归、公网桌面/390px审查与导航通过。见 `dev-log/2026-09-09-task-creator-review.md`。

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
