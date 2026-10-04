# official-plugin-publisher — 区分模型适配器与官方发布执行器

## 问题

DSH 能调度 Codex 做装机，不代表其普通模型适配器会暴露官方 Plugin
Creator。原适配器主动禁用 Apps；从开发者桌面看见工具也不能证明95
宿主可调用。把 ZIP 生成或 Task 完成当成插件更新，会让 Fleet 状态失真。

## 判定与实现

查 `src/plugin-publisher.ts` 的 `openPluginCreator`：在执行宿主用原生
Codex app-server 的 account/read、app/installed 和工具发现确认账号、
安装与可调用性，再读取精确插件 ID 的源文件。不扩大普通 DSH 模型
适配器权限。

原始 MCP 调用不会处理 `openai/fileParams`：发现到的 schema 虽写本地
路径，连接器实际需要已上传文件对象。必须让原生工具处理器完成上传，
本实现只在上传时执行一次受限 Codex turn，禁用其他 Apps/MCP、shell
及联网搜索，只开放 Plugin Creator 的读取/更新。核对实际调用参数，
独立回读判定结果；模型声称成功不算证据。不要猜测私有上传 HTTP API。
MCP 的 `plugin_creator.update_plugin` 也不等于代码模式里的函数名；
原生回合须从自己的 ALL_TOOLS 解析实际可调用名称。出现“is not a
function”说明尚未调用连接器，不能据此判断账号无权更新。

模型只交给专用工具一个 Fleet release UUID。执行器校验不可变归档摘要、
原 ID/USER/PRIVATE/App/默认提示词，认领持久租约，用原平台 release ID
做并发条件更新，最后回读版本与文本文件。未知上传结果先回读，不另建
包；只有 verified 可完成任务。版本通过仍不等于业务 MCP 调用已通过。
兼容 manifest 由平台重排对象键序，不是只改变空白。对 JSON 使用
isDeepStrictEqual，不能 stringify(parse()) 比较；数组顺序与所有字段值
仍须严格一致。已上传但被此校验误判时，只修校验并回读，不再上传。

用 `test/plugin-publisher.test.ts` 验证这些约束；真实验收必须记录
Fleet release、DSH Task 和平台实际 release 的对应关系，不能用单测替代。
维护及凭据位置见 `docs/plugin-publisher.md`，不在此复制密钥。

## 分诊重试

planner 与 reviewer 的 taskExpertise 都须覆盖执行工具契约，但 reviewer
只拿状态查询工具。声明不足会在发布前 needs_triage，这是配置拦截，
不是需要授予写权限。显式 `?retry=1` 只重试尚无 Task 的同内容 Signal，
将旧 Session/decision 写入审计；普通重复请求和已生成 Task 不重新执行。

全量 Agent 名册可能被模型工具输出截断，导致实际存在的执行器被误判
缺失。检查分诊 Session 的 context 回包；明确工具契约时默认投影满足
工具或领域声明的角色，保留 includeAllAgents 查看全名册，验证仍用全量
上下文。已生成 Task 的终止 Turn 不能 fireTask 重播；生产者在租约过期
且真实 Task 已终止后，为同一 Incident/版本发新 Signal，由分诊复用目标
Task。旧 Signal、Session、轮次和失败证据全部保留。

## 关联与过期点

入口：[[main-integration-index]]。跨仓库规范位于95
`/home/claude/linux-clash-skill/.brain/wiki/fleet-plugin-publishing-boundaries.md`。
2026-10-04，风险中等；原生 app-server/Plugin Creator 协议或认证条款变化时
重新做宿主实测，不把机主私用方案视作多租户商业发布 API。
