/** Prompt shortcuts, deliberately separate from the Agent's executable spec. */
export interface ActionParameter {
  key: string
  label: string
  type: 'text' | 'number' | 'boolean'
  required: boolean
  default?: string | number | boolean
}
export interface AgentAction {
  id: string
  name: string
  description: string
  template: string
  parameters: ActionParameter[]
}
export interface ActionCatalog {
  agentId: string | null
  name: string
  revision: string
  actions: AgentAction[]
  writable: boolean
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
      if (p.default !== undefined) { validateValue(field, p.default); field.default = p.default }
      return field
    })
    const template = text(a.template, '提示词模板', 8000)
    const used = [...template.matchAll(/\{\{([^{}]*)\}\}/g)].map(m => m[1])
    if (template.replace(/\{\{[^{}]*\}\}/g, '').match(/\{\{|\}\}/) || used.some(k => !keys.has(k))) throw new Error('模板包含未定义或格式错误的 {{参数}}')
    if (parameters.some((p: ActionParameter) => !used.includes(p.key))) throw new Error('每个参数都必须在模板中使用')
    return { id: a.id, name: text(a.name, 'Action 名称', 80), description: text(a.description ?? '', '说明', 300, true), template, parameters }
  })
}
function validateValue(p: ActionParameter, v: unknown): void {
  if (p.type === 'text' ? typeof v !== 'string' || v.length > 4000 : p.type === 'number' ? typeof v !== 'number' || !Number.isFinite(v) : typeof v !== 'boolean') throw new Error(`${p.label}：${p.type === 'number' ? '请填写有效数字' : '参数格式不正确'}`)
  if (p.required && typeof v === 'string' && !v.trim()) throw new Error(`请填写${p.label}`)
}
export function actionDefaults(action: AgentAction): Record<string, string | number | boolean> {
  return Object.fromEntries(action.parameters.map(p => [p.key, p.default ?? (p.type === 'boolean' ? false : '')]))
}
export function renderAction(action: AgentAction, raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Action 参数无效')
  const values = raw as Record<string, unknown>
  if (Object.keys(values).some(k => !action.parameters.some(p => p.key === k))) throw new Error('包含未定义参数')
  const resolved: Record<string, string> = Object.create(null)
  for (const p of action.parameters) {
    const v = values[p.key] ?? p.default
    if (v === undefined || v === '') { if (p.required) throw new Error(`请填写${p.label}`); resolved[p.key] = ''; continue }
    validateValue(p, v)
    resolved[p.key] = typeof v === 'boolean' ? (v ? '是' : '否') : String(v)
  }
  // One-pass substitution: user values are never evaluated or expanded as templates.
  return `[Action: ${action.name} · ${action.id}]\n${action.template.replace(/\{\{([^{}]*)\}\}/g, (_, key) => resolved[key])}`
}
export function actionCandidates(catalog: ActionCatalog | null, query: string) {
  const q = query.trim().toLowerCase()
  return (catalog?.actions ?? []).filter(a => !q || `${a.name} ${a.id} ${a.description}`.toLowerCase().includes(q)).map(a => ({ name: a.name, description: a.description, hint: '填写参数 · 当前会话', value: `action:${a.id}`, section: `Actions · ${catalog!.name}` }))
}
