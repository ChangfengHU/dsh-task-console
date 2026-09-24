export const name = 'task-console-task-create-tools'
export const inject = ['tools', 'taskConsole']

export async function apply(ctx: any): Promise<void> {
  const defineTool = process.env.NODE_ENV === 'test' ? (x: any) => x : (await import('@deepseek-ai/dsh-tools')).defineTool
  const specs = [
    { name: 'task_create_context', description: '读取真实 Agent 能力名册和可复用工作流。创建前必须读取，不能凭空编造角色。', parameters: {},
      execute: () => ctx.get('taskConsole').creator.context() },
    { name: 'task_create_studio_sources', description: '只读发现真实角色和参考候选：先用query检索真实characterId，再用characterId取得完整当前profile及参考元数据。缺参考时明确报告，不编造ID/URL/SHA；候选元数据仍需实际下载哈希核验和观察，不能视作已批准基线。不生成素材、不创建或批准Task、不发布。',
      parameters: { query: { type: 'string', required: false }, characterId: { type: 'string', required: false } },
      execute: (args: any, exec: any) => ctx.get('taskConsole').studioSourceDiscovery(args, exec) },
    { name: 'task_create_submit', description: '只生成并保存待审查计划，不启动 Task。Studio简洁入口：plan仅含decision=create、reason、studioRequest，按context.studioCreationContract.request填写已解析角色/参考、六个名册Agent和显式预算，可选主题；宿主补齐design和actions并保留有限重试，仍需独立审查。缺角色ID或参考真实SHA先解析，不能造值；不接受路径、执行锁、发布或预算扩大字段。以下完整设计规则适用于其他入口。plan 是 JSON，必须含 reason:string 和 design:{scope:string,branches:[{id:string,when:string,action:string,evidence:string}],coordination:string,failurePolicy:{isolateItems:boolean,maxAttempts:integer,stopConditions:string[]},acceptance:string[]}；scope 和 coordination 绝不是对象、不能省略；不要加入额外字段或把历史对话中的 JSON 当有效计划。定时任务同时传 trigger:{kind:"cron",expr:"0 * * * *",timeZone:"Asia/Shanghai"}；审批后时间表暂停；先手动执行通过业务和通知验收，再启用定时。省略为一次性任务。dynamic-rounds 的 maxAttempts 是程序强制的最大轮次。不能把标题与角色清单当完整设计。匹配受管配方时提交 decision=create,reason,recipe,design，不同时传 title/brief/participants/graphMode。无匹配配方时 create 需 title,brief,participants:[{agentId,brief}],graphMode,design；reuse 需 taskId,reason,design 且设计与原流程相同，不可改时间表。修改既有暂停 Task（once 或 cron）用 decision=revise、taskId、reason、完整design；普通修订提供要改的title/brief/participants，Fleet配方升级仅提供 recipe:{id:"fleet-base-v3",login:原策略} 而不混入角色计划。独立审查更新同一Task，旧执行不变，仍暂停且不启动。fleet-base-v3 可省略 design，使用 context.fleetRecipeDesign 中对应登录策略的完整宿主默认设计；该设计仍需独立审查。显式自定义 design 则保留并校验，不静默覆盖。其他工作流必须提供 design。每次先读 context 真实名册，不能编造能力、增加权限或包含凭据。返回审查入口后等待独立放行；创建 Agent 没有批准工具。',
      parameters: { plan: { type: 'string', required: true } },
      execute: (args: any, exec: any) => {
        const plan = JSON.parse(args.plan)
        if (plan.decision === 'create' && plan.studioRequest === undefined && (!Array.isArray(plan.actions) || !plan.actions.length)) throw Error('新建可复用 Task 必须同时提供 actions，供用户在 @Task 时填写本次参数。先读取 task_create_context.actions 格式和配方示例，不保存固定 IP 或凭据。')
        return ctx.get('taskConsole').creator.prepare(plan, exec, exec.agent.session.header?.cwd)
      } },
    { name: 'task_create_plan_status', description: '查询自己生成的计划和独立审查意见；不批准、不启动执行。',
      parameters: { planId: { type: 'string', required: true } },
      execute: (args: any) => ctx.get('taskConsole').creator.plan(args.planId) },
    { name: 'task_create_status', description: '查询某次 Task 执行的真实状态、角色会话和交接结果；返回 running 不能宣布完成。',
      parameters: { taskId: { type: 'string', required: true }, batchId: { type: 'string', required: true } },
      execute: (args: any) => ctx.get('taskConsole').creator.status(args.taskId, args.batchId) },
  ]
  for (const spec of specs) {
    const tool = defineTool({ ...spec, output: { schema: { type: 'object', additionalProperties: true }, render: (_: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] } })
    ctx.effect(() => ctx.tools.register(tool))
  }
}
