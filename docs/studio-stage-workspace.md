# Studio Task 阶段工作台

Studio Task 执行详情右上角的“阶段产物与继续”进入独立路由：`#/tc/tasks/<taskId>/stages/<batchId>`。页面保留 Task 与 Batch 标识，返回按钮回到该 Batch 的协作图；当前 Batch 之外的历史仍通过原执行选择器切换。

页面数据来自同一批次内的阶段回执表和真实 Task/Run 状态。它展示阶段摘要、登记文件的相对路径、SHA-256、媒体探测信息、Run/Session、问题和失败原因。阶段回执只表示文件已按交接协议登记，不代表审美、事实、许可或成片验收通过。8 MiB 以下的图片、音频和 JSON/TXT 可按需预览；文件内容接口要求路径、阶段、轮次和 SHA 同时命中当前回执，并再次校验工作区边界、文件长度与 SHA。大文件只展示元数据。

继续操作按 Run 状态区分：

- `ask_user_question` 形成的非终止 blocked Run：打开原 Session，由用户在原会话回答，继续同一个 Run。
- `task_block` 等终止阻塞：使用现有 `unblockCard` 建立新的 Run；定时等待未到期时禁用。
- Studio 终止失败：使用现有 operator-only `recoverStudioCard`，要求批次失败、节点/运行状态未变化、同批次 quiescent 与媒体/额度账本可恢复。理由和恢复 ID 由操作写入既有审计记录，旧 Run 保留。
- 终止阻塞的合成执行节点：仅在同轮前期阶段已交接时，可选择从剧本、视觉或声音阶段返修。后端会再次检查目标阶段真实状态、Batch 静止状态、受影响的 DAG 节点和账本；页面显示“新 Run”语义。其它任务类型不开放这些 Studio 恢复按钮。
- 正常交接后，下游仍由既有依赖调度器自动启动；页面不会对已完成阶段重复生成或伪造“继续全部”按钮。

本次新增只读远程方法 `studioTaskWorkspace` 和 `studioStageArtifactContent`，以及 UI 对既有 `unblockCard` / `recoverStudioCard` 的调用。没有新增 Agent/MCP 工具，也没有修改 Task 编排状态机。

本地验证：`npm run build`；`NODE_ENV=test npx tsx --test test/studio-task-workspace.test.ts`。完整测试套件在当前工作树另有 Fleet Onboard `contract-file-unsafe` 失败，需见交付报告；这与阶段工作台测试分开处理。
