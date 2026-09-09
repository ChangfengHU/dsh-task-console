export const name = 'task-console-task-create-tools'
export const inject = ['tools', 'taskConsole']

export async function apply(ctx: any): Promise<void> {
  const defineTool = process.env.NODE_ENV === 'test' ? (x: any) => x : (await import('@deepseek-ai/dsh-tools')).defineTool
  const specs = [
    { name: 'task_create_context', description: '读取真实 Agent 能力名册和可复用工作流。创建前必须读取，不能凭空编造角色。', parameters: {},
      execute: () => ctx.get('taskConsole').creator.context() },
    { name: 'task_create_submit', description: '只生成并保存待审查计划，不启动 Task。plan 是 JSON，必须含 design:{scope,branches:[{id,when,action,evidence}],coordination,failurePolicy:{isolateItems,maxAttempts,stopConditions:[]},acceptance:[]}。不能把标题与角色清单当完整设计。匹配受管配方时提交 decision=create,reason,recipe,design，不同时传 title/brief/participants/graphMode。无匹配配方时 create 需 title,brief,participants:[{agentId,brief}],graphMode,design；reuse 需 taskId,reason,design 且设计与原流程相同。每次先读 context 真实名册，不能编造能力、增加权限或包含凭据。返回审查入口后等待独立放行；创建 Agent 没有批准工具。',
      parameters: { plan: { type: 'string', required: true } },
      execute: (args: any, exec: any) => ctx.get('taskConsole').creator.prepare(JSON.parse(args.plan), exec, exec.agent.session.header?.cwd) },
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
