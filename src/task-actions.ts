/** Task-owned shortcuts. Never part of the reviewed workflow or its schedule. */
import { createHash } from 'node:crypto'
import { isIPv4 } from 'node:net'
import { parameterVisible, renderAction, validateActions, type ActionCatalog, type AgentAction } from './agent-actions.ts'
import type { TaskSpec } from './tasks.ts'
import type { TaskRunner } from './runner.ts'

export interface TaskActionInput { taskId: string; actionId: string; revision: string; values: Record<string, unknown>; requestId: string; cwd?: string }
export interface TaskActionSnapshot { id: string; name: string; revision: string; template: string; parameters: AgentAction['parameters']; values: Record<string, string | number | boolean> }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function validateTaskActions(raw: unknown): AgentAction[] {
  if (Array.isArray(raw) && raw.some(a => a && Object.keys(a).some(k => !['id','name','description','template','parameters','enabled','isDefault'].includes(k)))) throw Error('Action 只包含快捷入口配置，不能设置角色、工具、权限或时间表')
  const actions = validateActions(raw)
  if (actions.filter(a => a.isDefault).length > 1 || actions.some(a => a.isDefault && a.enabled === false)) throw Error('只能设置一个已启用的默认 Action')
  for (const a of actions) {
    const bindings = a.parameters.flatMap(p => p.binding ? [p.binding] : [])
    if (new Set(bindings).size !== bindings.length) throw Error('同一 Action 的参数用途不能重复')
    if (bindings.includes('ssh-password') && (!bindings.includes('target-ip') || !bindings.includes('ssh-user'))) throw Error('首次 SSH 凭据需要目标 IP 和用户名参数')
    if (a.parameters.some(p => (a.template.match(new RegExp(`\\{\\{${p.key}\\}\\}`, 'g')) ?? []).length !== 1)) throw Error('Task 参数在模板中只能出现一次')
  }
  return actions
}

/** Narrow an explicit account selection; never grant extra MCP operations. */
export function assertTaskActionLogin(snapshot: TaskActionSnapshot | undefined, raw: string, args: any, resumed?: any) {
  if (!snapshot) return
  const ipKey = snapshot.parameters.find(p => p.binding === 'target-ip')?.key
  if (ipKey && args.ip !== snapshot.values[ipKey]) throw Error('Task Action 登录操作只能针对本次明确目标')
  const key = snapshot.parameters.find(p => p.binding === 'gemini-account')?.key, value = key && snapshot.values[key]
  const accountId = typeof value === 'string' ? value.match(/(?:^|accountId=)(gemini_[a-f0-9]{8,64})(?:$|\s)/)?.[1] : undefined
  if (!accountId) return
  if (raw === 'browser_login_provision' && args.accountId === accountId && args.platform === 'gemini') return
  if (raw === 'browser_login_resume' && resumed?.args?.accountId === accountId && resumed?.args?.ip === args.ip && resumed?.args?.platform === 'gemini') return
  throw Error('本次 Task Action 已指定金库账号；必须使用匹配 accountId 的 Gemini provision/续接，不允许换号或从其他浏览器复制')
}
export class TaskActions {
  constructor(private runner: TaskRunner) {}
  private db() {
    const db = this.runner.store.kernel.db
    db.exec('CREATE TABLE IF NOT EXISTS dsh_task_action_catalog(task_id TEXT PRIMARY KEY,revision TEXT NOT NULL,actions_json TEXT NOT NULL)')
    return db
  }
  task(id: string): TaskSpec {
    const task = this.runner.store.tasks.get(id)
    if (!task || task.archivedAt || task.origin?.source !== 'task-chat') throw Error('仅聊天工作流支持 Task Actions；任务不存在或已归档')
    return task
  }
  read(id: string): ActionCatalog {
    const task = this.task(id), row = this.db().prepare('SELECT * FROM dsh_task_action_catalog WHERE task_id=?').get(id) as any
    return { taskId: id, agentId: null, name: task.title, writable: true, revision: row?.revision ?? '0', actions: row ? JSON.parse(row.actions_json) : [] }
  }
  save(id: string, raw: unknown, revision: string): ActionCatalog {
    const actions = validateTaskActions(raw), db = this.db()
    return db.transaction(() => {
      const before = this.read(id)
      if (before.revision !== revision) throw Error('Actions 已被修改，请重新加载；当前草稿保留')
      const next = hash([revision, actions])
      db.prepare('INSERT INTO dsh_task_action_catalog VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,actions_json=excluded.actions_json').run(id, next, JSON.stringify(actions))
      return this.read(id)
    })()
  }
  resolve(input: TaskActionInput) {
    const catalog = this.read(input.taskId)
    if (catalog.revision !== input.revision) throw Error('Task Action 已更新，请重新选择；草稿保留')
    const action = catalog.actions.find(a => a.id === input.actionId && a.enabled !== false)
    if (!action) throw Error('Task Action 不存在或已停用')
    const values: Record<string, any> = Object.create(null)
    if (!input.values || typeof input.values !== 'object' || Array.isArray(input.values)) throw Error('Action 参数无效')
    if (Object.keys(input.values).some(k => !action.parameters.some(p => p.key === k))) throw Error('包含未定义参数')
    for (const p of action.parameters) {
      if (!parameterVisible(p, values)) continue
      const raw = input.values[p.key] ?? (p.acceptDefaultOnEnter === false ? undefined : p.default)
      values[p.key] = raw === undefined ? '' : raw
    }
    const rendered = renderAction(action, values) // Types, required, enum, min: trusted server validation.
    const bound = (binding: string) => values[action.parameters.find(p => p.binding === binding)?.key ?? ''] as string | undefined
    const ip = bound('target-ip'), username = bound('ssh-user'), password = bound('ssh-password')
    if (ip !== undefined && !isIPv4(ip)) throw Error('请填写一个有效的目标 IPv4 地址')
    if (username && !/^[a-z_][a-z0-9_-]{0,31}$/i.test(username)) throw Error('SSH 用户名格式无效')
    if (password && (!ip || !username)) throw Error('首次凭据必须同时填写目标 IP、SSH 用户名和密码')
    const account = bound('gemini-account')
    const accountId = account?.match(/(?:^|accountId=)(gemini_[a-f0-9]{8,64})(?:$|\s)/)?.[1]
    if (account && !accountId) throw Error('请选择带 accountId 的金库账号，不猜测邮箱对应的凭据')
    const safe = { ...values }
    for (const p of action.parameters) if (p.binding === 'ssh-password' && safe[p.key]) safe[p.key] = '[credential supplied privately]'
    const redact = (text: string) => password ? text.split(password).join('[credential supplied privately]') : text
    const snapshot: TaskActionSnapshot = { id: action.id, name: action.name, revision: catalog.revision, template: action.template, parameters: action.parameters, values: Object.fromEntries(Object.entries(safe).map(([k,v]) => [k, typeof v === 'string' ? redact(v) : v])) }
    return { text: redact(rendered), snapshot, ips: ip ? [ip] : [], accountId,
      credential: password ? { schema: 1, ip: ip!, username: username!, password } : undefined }
  }
}
