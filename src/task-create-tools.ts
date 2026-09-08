export const name = 'task-console-task-create-tools'
export const inject = ['tools', 'taskConsole']

export async function apply(ctx: any): Promise<void> {
  const defineTool = process.env.NODE_ENV === 'test' ? (x: any) => x : (await import('@deepseek-ai/dsh-tools')).defineTool
  const specs = [
    { name: 'task_create_context', description: '读取真实 Agent 能力名册和可复用工作流。创建前必须读取，不能凭空编造角色。', parameters: {},
      execute: () => ctx.get('taskConsole').creator.context() },
    { name: 'task_create_submit', description: '为最新一条真实用户请求组装工作流并执行。plan 是 JSON：decision create/reuse, reason；create 还需 title, brief(可复用目标，不写 IP/密码), participants:[{agentId,brief}], graphMode static-chain(业务角色顺序)或 dynamic-rounds(严格规划/执行/评估三人)。reuse 需 taskId。不要在 plan 中包含凭据。同一用户消息重复调用不重复创建。',
      parameters: { plan: { type: 'string', required: true } },
      execute: (args: any, exec: any) => ctx.get('taskConsole').creator.submit(JSON.parse(args.plan), exec, exec.agent.session.header?.cwd) },
    { name: 'task_create_status', description: '查询某次 Task 执行的真实状态、角色会话和交接结果；返回 running 不能宣布完成。',
      parameters: { taskId: { type: 'string', required: true }, batchId: { type: 'string', required: true } },
      execute: (args: any) => ctx.get('taskConsole').creator.status(args.taskId, args.batchId) },
  ]
  for (const spec of specs) {
    const tool = defineTool({ ...spec, output: { schema: { type: 'object', additionalProperties: true }, render: (_: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] } })
    ctx.effect(() => ctx.tools.register(tool))
  }
}
