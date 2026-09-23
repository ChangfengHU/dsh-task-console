/** Prompt shortcuts, deliberately separate from the Agent's executable spec. */
export interface ActionParameter {
  key: string
  label: string
  type: 'text' | 'number' | 'boolean'
  required: boolean
  default?: string | number | boolean
  acceptDefaultOnEnter?: boolean
  choices?: string[]
  source?: 'fleet.nodes' | 'fleet.gemini-accounts' | 'vault.ssh-nodes'
  dependsOn?: string[]
  visibleWhen?: { key: string; equals: string | number | boolean }
  inactiveValue?: string
  min?: number
  integer?: boolean
  binding?: 'target-ip' | 'ssh-user' | 'ssh-password' | 'gemini-account'
}
export interface AgentAction {
  id: string
  name: string
  description: string
  template: string
  parameters: ActionParameter[]
  enabled?: boolean
  isDefault?: boolean
}
export interface ActionCatalog {
  agentId: string | null
  name: string
  revision: string
  actions: AgentAction[]
  writable: boolean
  taskId?: string
}
const ID = /^[a-z][a-z0-9-]{0,63}$/
const KEY = /^[a-z][a-z0-9_]{0,39}$/
function text(value: unknown, label: string, max: number, optional = false): string {
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) throw new Error(`${label}无效（最多 ${max} 字符）`)
  return value
}
export function validateActions(raw: unknown): AgentAction[] {
  if (!Array.isArray(raw) || raw.length > 20) throw new Error('最多保存 20 个 Action')
  const ids = new Set<string>()
  return raw.map(a => {
    if (!a || typeof a !== 'object' || !ID.test(a.id) || ids.has(a.id)) throw new Error('Action id 必须唯一，使用小写字母、数字、连字符')
    ids.add(a.id)
    if (!Array.isArray(a.parameters) || a.parameters.length > 12) throw new Error('每个 Action 最多 12 个参数')
    const keys = new Set<string>()
    const parameters = a.parameters.map((p: any): ActionParameter => {
      if (!p || !KEY.test(p.key) || keys.has(p.key) || ['constructor', 'prototype', '__proto__'].includes(p.key)) throw new Error('参数 key 必须唯一，使用小写字母、数字、下划线')
      keys.add(p.key)
      if (!['text', 'number', 'boolean'].includes(p.type) || typeof p.required !== 'boolean') throw new Error('参数类型或必填设置无效')
      const field: ActionParameter = { key: p.key, label: text(p.label, '参数名称', 80), type: p.type, required: p.required }
      if (p.binding !== undefined) {
        if (p.type !== 'text' || !['target-ip', 'ssh-user', 'ssh-password', 'gemini-account'].includes(p.binding)) throw Error('参数用途无效')
        if (p.binding === 'ssh-password' && (p.default !== undefined || p.source || p.choices)) throw Error('密码只能本次输入，不允许保存默认值或候选')
        field.binding = p.binding
      }
      for (const flag of ['acceptDefaultOnEnter', 'integer'] as const) if (p[flag] !== undefined) {
        if (typeof p[flag] !== 'boolean' || flag === 'integer' && p.type !== 'number') throw new Error('参数开关无效')
        field[flag] = p[flag]
      }
      if (p.min !== undefined) {
        if (p.type !== 'number' || typeof p.min !== 'number' || !Number.isFinite(p.min)) throw new Error('数字下限无效')
        field.min = p.min
      }
      if (p.choices !== undefined) {
        if (p.type !== 'text' || !Array.isArray(p.choices) || !p.choices.length || p.choices.length > 30 || new Set(p.choices).size !== p.choices.length) throw new Error('固定选项无效（1–30 个不重复文本）')
        field.choices = p.choices.map((v: unknown) => text(v, '选项', 120))
      }
      if (p.source !== undefined) {
        if (p.type !== 'text' || !['fleet.nodes', 'fleet.gemini-accounts', 'vault.ssh-nodes'].includes(p.source) || p.choices) throw new Error('候选来源无效')
        field.source = p.source
      }
      if (p.dependsOn !== undefined) {
        if (!Array.isArray(p.dependsOn) || p.dependsOn.length > 12 || new Set(p.dependsOn).size !== p.dependsOn.length || p.dependsOn.some((k: string) => !keys.has(k) || k === p.key)) throw new Error('依赖必须是之前的参数，不允许循环')
        field.dependsOn = [...p.dependsOn]
      }
      if (p.visibleWhen !== undefined) {
        if (!p.visibleWhen || !keys.has(p.visibleWhen.key) || p.visibleWhen.key === p.key || !['string', 'number', 'boolean'].includes(typeof p.visibleWhen.equals)) throw new Error('显示条件必须引用之前的参数')
        if (typeof p.visibleWhen.equals === 'number' && !Number.isFinite(p.visibleWhen.equals) || typeof p.visibleWhen.equals === 'string' && p.visibleWhen.equals.length > 4000) throw new Error('显示条件值无效')
        field.visibleWhen = { key: p.visibleWhen.key, equals: p.visibleWhen.equals }
        field.inactiveValue = text(p.inactiveValue ?? '无需指定', '未启用时文本', 120, true)
      }
      if (p.default !== undefined) { validateValue(field, p.default); field.default = p.default }
      if (field.source === 'fleet.gemini-accounts' && (!field.dependsOn?.length || field.default !== undefined)) throw new Error('账号来源需要目标参数依赖，不能配置默认账号')
      return field
    })
    const template = text(a.template, '提示词模板', 8000)
    if (new Set(parameters.map((p: ActionParameter) => p.label)).size !== parameters.length) throw new Error('参数名称必须唯一，避免占位符歧义')
    const used = [...template.matchAll(/\{\{([^{}]*)\}\}/g)].map(m => m[1])
    if (template.replace(/\{\{[^{}]*\}\}/g, '').match(/\{\{|\}\}/) || used.some(k => !keys.has(k))) throw new Error('模板包含未定义或格式错误的 {{参数}}')
    if (parameters.some((p: ActionParameter) => !used.includes(p.key))) throw new Error('每个参数都必须在模板中使用')
    for (const p of parameters) {
      const parents = [...(p.dependsOn ?? []), ...(p.visibleWhen ? [p.visibleWhen.key] : [])]
      if (parents.some(k => used.indexOf(k) >= used.indexOf(p.key))) throw new Error('模板中依赖参数必须出现在联动参数之前')
      if (parents.length && [p.key, ...parents].some(k => used.filter(v => v === k).length !== 1)) throw new Error('联动参数及其依赖在模板中只能出现一次')
    }
    for (const flag of ['enabled', 'isDefault']) if (a[flag] !== undefined && typeof a[flag] !== 'boolean') throw Error('Action 开关无效')
    return { id: a.id, name: text(a.name, 'Action 名称', 80), description: text(a.description ?? '', '说明', 300, true), template, parameters,
      ...(a.enabled !== undefined ? { enabled: a.enabled } : {}), ...(a.isDefault !== undefined ? { isDefault: a.isDefault } : {}) }
  })
}
export function validateValue(p: ActionParameter, v: unknown): void {
  if (p.type === 'text' ? typeof v !== 'string' || v.length > 4000 : p.type === 'number' ? typeof v !== 'number' || !Number.isFinite(v) : typeof v !== 'boolean') throw new Error(`${p.label}：${p.type === 'number' ? '请填写有效数字' : '参数格式不正确'}`)
  if (p.required && typeof v === 'string' && !v.trim()) throw new Error(`请填写${p.label}`)
  if (p.choices && !p.choices.includes(String(v))) throw new Error(`${p.label}：请选择配置的选项`)
  if (p.type === 'number' && (p.integer && !Number.isInteger(v) || p.min !== undefined && Number(v) < p.min)) throw new Error(`${p.label}：需要${p.integer ? '整数' : '数字'}${p.min === undefined ? '' : `，最小 ${p.min}`}`)
}
export function parameterVisible(p: ActionParameter, values: Record<string, unknown>): boolean {
  return !p.visibleWhen || String(values[p.visibleWhen.key]) === String(p.visibleWhen.equals)
}
export function actionDefaults(action: AgentAction): Record<string, string | number | boolean> {
  return Object.fromEntries(action.parameters.map(p => [p.key, p.default ?? (p.type === 'boolean' ? false : '')]))
}
export function renderAction(action: AgentAction, raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Action 参数无效')
  const values = raw as Record<string, unknown>
  if (Object.keys(values).some(k => !action.parameters.some(p => p.key === k))) throw new Error('包含未定义参数')
  const resolved: Record<string, string> = Object.create(null)
  const typed: Record<string, unknown> = Object.create(null)
  for (const p of action.parameters) {
    if (!parameterVisible(p, typed)) { resolved[p.key] = p.inactiveValue ?? ''; continue }
    const v = values[p.key] ?? (p.acceptDefaultOnEnter === false ? undefined : p.default)
    if (v === undefined || v === '') { if (p.required) throw new Error(`请填写${p.label}`); resolved[p.key] = ''; continue }
    validateValue(p, v)
    typed[p.key] = v
    resolved[p.key] = typeof v === 'boolean' ? (v ? '是' : '否') : String(v)
  }
  // One-pass substitution: user values are never evaluated or expanded as templates.
  return `[Action: ${action.name} · ${action.id}]\n${action.template.replace(/\{\{([^{}]*)\}\}/g, (_, key) => resolved[key])}`
}
export function actionCandidates(catalog: ActionCatalog | null, query: string) {
  const q = query.trim().toLowerCase()
  return (catalog?.actions ?? []).filter(a => a.enabled !== false && (!q || `${a.name} ${a.id} ${a.description}`.toLowerCase().includes(q))).sort((a,b) => Number(b.isDefault === true) - Number(a.isDefault === true)).map(a => ({ name: a.name, description: a.description, hint: '填写参数 · 当前会话', value: `action:${a.id}`, section: `Actions · ${catalog!.name}` }))
}
