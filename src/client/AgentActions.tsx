import { useEffect, useRef, useState } from 'react'
import { actionDefaults, renderAction, validateActions, type ActionCatalog, type ActionParameter, type AgentAction } from '../agent-actions.ts'
import { ACTION_CHANGED, sendCurrentAction, type ActionRequest } from './action-dispatch.ts'
import type { Api } from './Console.tsx'

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)

export function ActionEditor({ api, agentId }: { api: Api; agentId: string }) {
  const [catalog, setCatalog] = useState<ActionCatalog | null>(null)
  const [actions, setActions] = useState<AgentAction[]>([])
  const [selected, setSelected] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const dirty = !!catalog && JSON.stringify(catalog.actions) !== JSON.stringify(actions)
  const load = async () => { setError(''); try { const value = await api.agentActions({ agentId }); setCatalog(value); setActions(value.actions); setSelected(0) } catch (e) { setError(errorText(e)) } }
  useEffect(() => { void load() }, [agentId, api])
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
    try { const value = await api.saveAgentActions(agentId, validateActions(actions), catalog.revision); setCatalog(value); setActions(value.actions); setNotice('Actions 已保存；未改变角色权限或现有 Task。'); window.dispatchEvent(new Event(ACTION_CHANGED)) }
    catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const parameter = (index: number, patch: Partial<ActionParameter>) => update({ parameters: active.parameters.map((p, i) => i === index ? { ...p, ...patch } : p) })
  return <section className="dtc-panel dtc-actions-editor" aria-label="Actions 配置"><h3>Actions <span className="dtc-faint">· 保存常用指令，在会话中 @ 调用</span></h3>
    <p className="dtc-faint">快捷提示词，不是额外工具权限。选择动作不会执行；填写参数并确认发送后，交给 Agent 处理。不要在模板或默认值中保存凭据。</p>
    {error ? <div className="dtc-err" role="alert">{error}</div> : null}{notice ? <div role="status">{notice}</div> : null}
    <div className="dtc-action-toolbar"><button className="dtc-btn sm" onClick={() => { if (!dirty || confirm('放弃未保存的 Actions 修改？')) void load() }}>重新加载</button>{catalog?.writable ? <><button className="dtc-btn sm" disabled={busy || actions.length >= 20} onClick={() => add()}>＋ 新增 Action</button><button className="dtc-btn sm pri" onClick={save} disabled={busy || !dirty}>{busy ? '保存中…' : '保存 Actions'}</button></> : null}</div>
    {!catalog ? <p>正在读取 Actions…</p> : !actions.length ? <p className="dtc-faint">还没有 Action。可新增常用指令。</p> : <>
      <div className="dtc-action-list">{actions.map((a, i) => <button className={`dtc-btn sm ${i === selected ? 'pri' : ''}`} key={i} aria-pressed={i === selected} onClick={() => setSelected(i)}>{a.name || '未命名'}</button>)}</div>
      {active ? <fieldset disabled={!catalog.writable || busy} className="dtc-action-fields"><div className="dtc-fields">
        <label>Action 名称<input value={active.name} onChange={e => update({ name: e.target.value })} maxLength={80} /></label>
        <label>Action id<input value={active.id} onChange={e => update({ id: e.target.value })} /></label>
        <label className="wide">说明<input value={active.description} onChange={e => update({ description: e.target.value })} maxLength={300} /></label>
        <label className="wide">提示词模板 · 使用 {'{{参数key}}'}<textarea value={active.template} onChange={e => update({ template: e.target.value })} maxLength={8000} /></label>
      </div>
      <h4>参数</h4>{active.parameters.map((p, i) => <div className="dtc-action-param" key={i}>
        <label>key<input value={p.key} onChange={e => parameter(i, { key: e.target.value })} /></label>
        <label>名称<input value={p.label} onChange={e => parameter(i, { label: e.target.value })} /></label>
        <label>类型<select value={p.type} onChange={e => parameter(i, { type: e.target.value as ActionParameter['type'], default: undefined })}><option value="text">文本</option><option value="number">数字</option><option value="boolean">是 / 否</option></select></label>
        <label>默认值{p.type === 'boolean' ? <select value={p.default === undefined ? '' : String(p.default)} onChange={e => parameter(i, { default: e.target.value === '' ? undefined : e.target.value === 'true' })}><option value="">未设置</option><option value="true">是</option><option value="false">否</option></select> : <input type={p.type === 'number' ? 'number' : 'text'} value={String(p.default ?? '')} onChange={e => parameter(i, { default: e.target.value === '' ? undefined : p.type === 'number' ? Number(e.target.value) : e.target.value })} />}</label>
        <label className="dtc-action-check"><input type="checkbox" checked={p.required} onChange={e => parameter(i, { required: e.target.checked })} />必填</label>
        <button className="dtc-btn sm" aria-label={`移除参数 ${p.key}`} onClick={() => update({ parameters: active.parameters.filter((_, j) => j !== i) })}>移除</button>
      </div>)}
      <div className="dtc-action-toolbar"><button className="dtc-btn sm" disabled={active.parameters.length >= 12} onClick={() => update({ parameters: [...active.parameters, { key: `param_${active.parameters.length + 1}`, label: '新参数', type: 'text', required: true }] })}>＋ 参数</button><button className="dtc-btn sm" disabled={actions.length >= 20} onClick={() => add(active)}>复制 Action</button><button className="dtc-btn sm danger" onClick={() => { if (confirm(`删除快捷指令「${active.name}」？不会删除会话、任务或浏览器。保存后生效。`)) { setActions(actions.filter((_, i) => i !== selected)); setSelected(0) } }}>删除 Action</button></div>
      </fieldset> : null}</>}
  </section>
}

export function ActionDialog({ api, ctx, request, close }: { api: Api; ctx: any; request: ActionRequest; close: () => void }) {
  const [catalog, setCatalog] = useState<ActionCatalog | null>(null)
  const [selected, setSelected] = useState(request.actionId ?? '')
  const [values, setValues] = useState<Record<string, string | number | boolean>>({})
  const [ordinary, setOrdinary] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const [uncertain, setUncertain] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  useEffect(() => { let live = true; api.agentActions({ agentId: request.agentId, sessionId: request.targetSessionId }).then(c => { if (!live) return; setCatalog(c); const a = c.actions.find(a => a.id === request.actionId); if (a) setValues(actionDefaults(a)); else if (request.actionId) setError('Action 已删除，请重新选择') }).catch(e => { if (live) setError(errorText(e)) }); return () => { live = false } }, [api, request])
  const action = catalog?.actions.find(a => a.id === selected)
  let preview = ordinary, validation = ''
  if (action) { try { preview = renderAction(action, values) } catch (e) { preview = ''; validation = errorText(e) } }
  else if (selected) validation = '请选择存在的 Action'
  const send = async () => {
    if (!catalog || sending.current || uncertain || validation || !preview.trim()) return
    sending.current = true; setBusy(true); setError('')
    let dispatched = false
    try {
      const text = action ? (await api.prepareAgentAction({ agentId: request.agentId, sessionId: request.targetSessionId, actionId: action.id, revision: catalog.revision, values })).text : ordinary.trim()
      dispatched = true
      if (request.targetSessionId) await sendCurrentAction(ctx, request.targetSessionId, text)
      else {
        const result = await api.startAgentSession(request.agentId, text, request.cwd)
        // Accepted already: failure to navigate must never offer another send.
        await api.openSession(result.sessionId).catch(() => { window.location.assign(`/?session=${encodeURIComponent(result.sessionId)}`) })
      }
      // Composer housekeeping must not turn an accepted message into a retry.
      try { if (request.span) ctx.sessions.scope(request.originSessionId)?.bail('slash/input-consume-token', { guard: { kind: 'span', span: request.span } }) } catch { /* draft revision may have moved */ }
      close()
    } catch (e) { setUncertain(dispatched); setError(errorText(e) + (dispatched ? '。请关闭弹窗并检查会话记录，本窗口不会重复发送。' : '')) } finally { sending.current = false; setBusy(false) }
  }
  return <dialog ref={dialog} className="dtc-root dtc-action-dialog" aria-label="Agent Action" onCancel={e => { e.preventDefault(); if (!sending.current) close() }}>
    <div className="dtc-mbox"><div className="mh">{request.name} · {request.targetSessionId ? '当前会话 Action' : '选择 Action'}<button className="dtc-close" aria-label="关闭 Action" disabled={busy} onClick={close}>×</button></div>
      <div className="mb"><p className="dtc-faint">{request.targetSessionId ? '保留当前角色与会话，不会新建 Task。' : '选择常用动作，或直接填写普通消息。发送时才创建该 Agent 的会话。'}</p>
        {error ? <div className="dtc-err" role="alert">{error}</div> : null}
        <fieldset disabled={busy || !catalog} className="dtc-action-fields">
        <label>Action<select aria-label="选择 Action" value={selected} onChange={e => { setSelected(e.target.value); setError(''); const a = catalog?.actions.find(a => a.id === e.target.value); setValues(a ? actionDefaults(a) : {}) }}><option value="">{request.targetSessionId ? '请选择动作' : '普通会话（不使用 Action）'}</option>{catalog?.actions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        {action ? <><p>{action.description}</p><div className="dtc-fields">{action.parameters.map(p => <label key={p.key}>{p.label}{p.required ? ' *' : ''}{p.type === 'boolean' ? <select value={String(values[p.key] ?? false)} onChange={e => setValues({ ...values, [p.key]: e.target.value === 'true' })}><option value="false">否</option><option value="true">是</option></select> : <input type={p.type === 'number' ? 'number' : 'text'} value={String(values[p.key] ?? '')} onChange={e => setValues({ ...values, [p.key]: p.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value })} />}</label>)}</div></> : !request.targetSessionId ? <label>消息<textarea value={ordinary} onChange={e => setOrdinary(e.target.value)} placeholder="要这个 Agent 做什么？" /></label> : null}
        </fieldset>
        {action ? <><h4>将发送的内容</h4>{validation ? <p className="dtc-faint">{validation}</p> : <pre className="dtc-action-preview">{preview}</pre>}</> : null}
        <div className="dtc-action-toolbar"><button className="dtc-btn" disabled={busy} onClick={close}>取消</button><button className="dtc-btn pri" disabled={busy || uncertain || !catalog || !!validation || !preview.trim() || (!!request.targetSessionId && !action)} onClick={send}>{busy ? '正在发送…' : request.targetSessionId ? '确认发送到当前会话' : '创建会话并发送'}</button></div>
      </div>
    </div>
  </dialog>
}
