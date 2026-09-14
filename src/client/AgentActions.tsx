import { useEffect, useState } from 'react'
import { validateActions, type ActionCatalog, type ActionParameter, type AgentAction } from '../agent-actions.ts'
import { ACTION_CHANGED } from './action-dispatch.ts'
import type { Api } from './Console.tsx'
import { ACTION_SOURCES } from '../action-options.ts'
import { makeActionSnippet } from '../action-snippet.ts'

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)

export function ActionEditor({ api, agentId, taskId }: { api: Api; agentId?: string; taskId?: string }) {
  const [catalog, setCatalog] = useState<ActionCatalog | null>(null)
  const [actions, setActions] = useState<AgentAction[]>([])
  const [selected, setSelected] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const dirty = !!catalog && JSON.stringify(catalog.actions) !== JSON.stringify(actions)
  const load = async () => { setError(''); try { const value = taskId ? await api.taskActions(taskId) : await api.agentActions({ agentId }); setCatalog(value); setActions(value.actions); setSelected(0) } catch (e) { setError(errorText(e)) } }
  useEffect(() => { void load() }, [agentId, taskId, api])
  const active = actions[selected]
  const update = (patch: Partial<AgentAction>) => { setNotice(''); setActions(rows => rows.map((a, i) => i === selected ? { ...a, ...patch } : a)) }
  const add = (copy?: AgentAction) => {
    let id = copy ? `${copy.id.slice(0, 48)}-copy` : 'new-action'
    for (let i = 2; actions.some(a => a.id === id); i++) id = `${copy ? copy.id.slice(0, 45) : 'new-action'}-${i}`
    const action = copy ? { ...copy, id, name: `${copy.name} 副本`, parameters: copy.parameters.map(p => ({ ...p })) } : { id, name: '新 Action', description: '', template: '请处理 {{target}}。先检查现状，在已有工具权限范围内执行，最后报告结果。', parameters: [{ key: 'target', label: '目标', type: 'text' as const, required: true }] }
    setActions([...actions, action]); setSelected(actions.length); setNotice('')
  }
  const save = async () => {
    if (!catalog) return
    setBusy(true); setError(''); setNotice('')
    try { const validated = validateActions(actions); const value = taskId ? await api.saveTaskActions(taskId, validated, catalog.revision) : await api.saveAgentActions(agentId!, validated, catalog.revision); setCatalog(value); setActions(value.actions); setNotice('Actions 已保存；未改变角色权限、工作流、定时或历史执行。'); window.dispatchEvent(new Event(ACTION_CHANGED)) }
    catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const parameter = (index: number, patch: Partial<ActionParameter>) => update({ parameters: active.parameters.map((p, i) => i === index ? { ...p, ...patch } : p) })
  let preview = ''
  try { if (active) preview = makeActionSnippet(validateActions([active])[0], `@${catalog?.name ?? ''}/${active.name} `).text } catch { preview = '请先修正模板和参数配置' }
  return <section className="dtc-panel dtc-actions-editor" aria-label="Actions 配置"><h3>Actions <span className="dtc-faint">· 保存常用指令，在会话中 @ 调用</span></h3>
    <p className="dtc-faint">{taskId ? `${catalog?.name ?? 'Task'}：在会话中 @ 此任务，再选 Action。填写后只新增本任务的执行记录，并跳转到执行页；不会新建普通会话。` : '选择动作会把提示词填入当前角色的输入框。'}填写占位符，Enter / Tab 跳到下一项；填完后再确认发送。不会授予额外工具权限，不要保存凭据。</p>
    {error ? <div className="dtc-err" role="alert">{error}</div> : null}{notice ? <div role="status">{notice}</div> : null}
    <div className="dtc-action-toolbar"><button className="dtc-btn sm" onClick={() => { if (!dirty || confirm('放弃未保存的 Actions 修改？')) void load() }}>重新加载</button>{catalog?.writable ? <><button className="dtc-btn sm" disabled={busy || actions.length >= 20} onClick={() => add()}>＋ 新增 Action</button><button className="dtc-btn sm pri" onClick={save} disabled={busy || !dirty}>{busy ? '保存中…' : '保存 Actions'}</button></> : null}</div>
    {!catalog ? <p>正在读取 Actions…</p> : !actions.length ? <p className="dtc-faint">还没有 Action。可新增常用指令。</p> : <>
      <div className="dtc-action-list">{actions.map((a, i) => <button className={`dtc-btn sm ${i === selected ? 'pri' : ''}`} key={i} aria-pressed={i === selected} onClick={() => setSelected(i)}>{a.name || '未命名'}</button>)}</div>
      {active ? <fieldset disabled={!catalog.writable || busy} className="dtc-action-fields">
        {taskId ? <div className="dtc-action-toolbar"><label className="dtc-action-check"><input type="checkbox" checked={active.enabled !== false} onChange={e => update({ enabled: e.target.checked, ...(!e.target.checked ? { isDefault: false } : {}) })} />启用 Action</label><label className="dtc-action-check"><input type="checkbox" checked={active.isDefault === true} disabled={active.enabled === false} onChange={e => setActions(rows => rows.map((a, i) => ({ ...a, isDefault: i === selected && e.target.checked })))} />默认 Action（优先显示，不自动执行）</label></div> : null}
        <div className="dtc-fields">
        <label>Action 名称<input value={active.name} onChange={e => update({ name: e.target.value })} maxLength={80} /></label>
        <label>Action id<input value={active.id} onChange={e => update({ id: e.target.value })} /></label>
        <label className="wide">说明<input value={active.description} onChange={e => update({ description: e.target.value })} maxLength={300} /></label>
        <label className="wide">提示词模板 · 使用 {'{{参数key}}'}<textarea value={active.template} onChange={e => update({ template: e.target.value })} maxLength={8000} /></label>
      </div>
      <h4>参数</h4>{active.parameters.map((p, i) => <div className="dtc-action-param" key={i}>
        <label>key<input value={p.key} onChange={e => parameter(i, { key: e.target.value })} /></label>
        <label>名称<input value={p.label} onChange={e => parameter(i, { label: e.target.value })} /></label>
        <label>类型<select value={p.type} onChange={e => parameter(i, { type: e.target.value as ActionParameter['type'], default: undefined, choices: undefined, source: undefined, min: undefined, integer: undefined })}><option value="text">文本</option><option value="number">数字</option><option value="boolean">是 / 否</option></select></label>
        <label>默认值{p.type === 'boolean' ? <select value={p.default === undefined ? '' : String(p.default)} onChange={e => parameter(i, { default: e.target.value === '' ? undefined : e.target.value === 'true' })}><option value="">未设置</option><option value="true">是</option><option value="false">否</option></select> : <input type={p.type === 'number' ? 'number' : 'text'} value={String(p.default ?? '')} onChange={e => parameter(i, { default: e.target.value === '' ? undefined : p.type === 'number' ? Number(e.target.value) : e.target.value })} />}</label>
        <label className="dtc-action-check"><input type="checkbox" checked={p.required} onChange={e => parameter(i, { required: e.target.checked })} />必填</label>
        <button className="dtc-btn sm" aria-label={`移除参数 ${p.key}`} onClick={() => update({ parameters: active.parameters.filter((_, j) => j !== i) })}>移除</button>
        <details className="dtc-action-param-settings"><summary>输入行为 · 默认值 / 候选 / 联动</summary><div className="dtc-action-param-options">
          <label className="dtc-action-check"><input type="checkbox" checked={p.acceptDefaultOnEnter !== false} onChange={e => parameter(i, { acceptDefaultOnEnter: e.target.checked })} />允许 Enter / Tab 接受默认值</label>
          {taskId && p.type === 'text' ? <label>参数用途<select value={p.binding ?? ''} onChange={e => parameter(i, { binding: (e.target.value || undefined) as ActionParameter['binding'], ...(e.target.value === 'ssh-password' ? { default: undefined, source: undefined, choices: undefined } : {}) })}><option value="">普通任务参数</option><option value="target-ip">本次目标 IPv4（不从其他文本提取）</option><option value="ssh-user">首次 SSH 用户名</option><option value="ssh-password">首次 SSH 密码（不保存执行明文）</option><option value="gemini-account">指定金库 Gemini 账号</option></select></label> : null}
          {p.type === 'number' ? <><label>最小值<input type="number" value={p.min ?? ''} onChange={e => parameter(i, { min: e.target.value === '' ? undefined : Number(e.target.value) })} /></label><label className="dtc-action-check"><input type="checkbox" checked={p.integer === true} onChange={e => parameter(i, { integer: e.target.checked })} />仅允许整数</label></> : null}
          {p.type === 'text' ? <><label>候选来源<select value={p.source ?? ''} onChange={e => parameter(i, { source: (e.target.value || undefined) as ActionParameter['source'], choices: undefined })}><option value="">手填 / 固定选项</option>{ACTION_SOURCES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
            {!p.source ? <label>固定选项 · 用 | 分隔<input value={p.choices?.join(' | ') ?? ''} onChange={e => parameter(i, { choices: e.target.value.trim() ? e.target.value.split('|').map(s => s.trim()) : undefined })} /></label> : null}</> : null}
          <label>依赖参数 · 逗号分隔<input value={p.dependsOn?.join(',') ?? ''} placeholder={active.parameters.slice(0, i).map(p => p.key).join(',')} onChange={e => parameter(i, { dependsOn: e.target.value.trim() ? e.target.value.split(',').map(s => s.trim()) : undefined })} /></label>
          <label>显示条件<select value={p.visibleWhen?.key ?? ''} onChange={e => parameter(i, { visibleWhen: e.target.value ? { key: e.target.value, equals: '' } : undefined })}><option value="">始终显示</option>{active.parameters.slice(0, i).map(parent => <option key={parent.key} value={parent.key}>{parent.label} 等于…</option>)}</select></label>
          {p.visibleWhen ? <><label>条件值<input value={String(p.visibleWhen.equals)} onChange={e => {
            const parent = active.parameters.find(v => v.key === p.visibleWhen!.key)
            parameter(i, { visibleWhen: { key: p.visibleWhen!.key, equals: parent?.type === 'number' ? Number(e.target.value) : parent?.type === 'boolean' ? ['是', 'true'].includes(e.target.value) : e.target.value } })
          }} /></label><label>不适用时填入<input value={p.inactiveValue ?? '无需指定'} onChange={e => parameter(i, { inactiveValue: e.target.value })} /></label></> : null}
        </div></details>
      </div>)}
      <div className="dtc-action-toolbar"><button className="dtc-btn sm" disabled={active.parameters.length >= 12} onClick={() => update({ parameters: [...active.parameters, { key: `param_${active.parameters.length + 1}`, label: '新参数', type: 'text', required: true }] })}>＋ 参数</button><button className="dtc-btn sm" disabled={actions.length >= 20} onClick={() => add(active)}>复制 Action</button><button className="dtc-btn sm danger" onClick={() => { if (confirm(`删除快捷指令「${active.name}」？不会删除会话、任务或浏览器。保存后生效。`)) { setActions(actions.filter((_, i) => i !== selected)); setSelected(0) } }}>删除 Action</button></div>
      </fieldset> : null}{active && taskId ? <details><summary>预览输入框 · 不会执行</summary><pre className="dtc-workflow-copy">{preview}</pre></details> : null}</>}
  </section>
}
