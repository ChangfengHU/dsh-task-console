import { useEffect, useRef, useState } from 'react'
import { actionDefaults, type ActionCatalog } from '../agent-actions.ts'
import { closeConsole, type Api } from './Console.tsx'

export function AppEpisodeActions({ api, agentId }: { api: Api; agentId: string }) {
  const [catalog, setCatalog] = useState<ActionCatalog | null>(null)
  const [selected, setSelected] = useState(''), [values, setValues] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = useRef(false), request = useRef<string | null>(sessionStorage.getItem(`dsh-episode-request:${agentId}`))
  useEffect(() => { let live = true; api.agentActions({ agentId }).then(c => { if (live) { setCatalog(c); const a = c.actions.find(a => a.isDefault && a.enabled !== false) ?? c.actions.find(a => a.enabled !== false); if (a) { setSelected(a.id); setValues(actionDefaults(a)) } } }).catch(e => { if (live) setError(e.message) }); return () => { live = false } }, [api, agentId])
  const action = catalog?.actions.find(a => a.id === selected)
  const launch = async () => {
    if (!catalog || !action || pending.current) return
    pending.current = true; setBusy(true); setError('')
    const key = `dsh-episode-request:${agentId}`
    request.current ??= sessionStorage.getItem(key) ?? crypto.randomUUID()
    sessionStorage.setItem(key, request.current)
    try {
      const run = await api.launchAgentAction({ agentId, actionId: action.id, revision: catalog.revision, values, requestId: request.current })
      // Keep request until the confirmed existing session has actually opened.
      await api.openSession(run.sessionId); sessionStorage.removeItem(key); request.current = null; closeConsole()
    } catch (e: any) { setError(`${e.message ?? e}。重试沿用本次请求，不会重复生成。`) }
    finally { pending.current = false; setBusy(false) }
  }
  return <section className="dtc-panel" aria-label="视频制作 Actions"><h3>视频制作 Actions</h3>
    <p className="dtc-note">默认自主选题，无需准备素材或写长提示词。每次新制作独立会话、独立目录；沿用此 Agent 的模型、Skill 与 MCP，不自动发抖音。</p>
    {error ? <div role="alert" className="dtc-err">{error}</div> : null}
    <select aria-label="制作 Action" disabled={busy} value={selected} onChange={e => { if (request.current) return; const a = catalog?.actions.find(a => a.id === e.target.value); if (a) { setSelected(a.id); setValues(actionDefaults(a)) } }}>
      {catalog?.actions.filter(a => a.enabled !== false).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
    </select>
    {action?.parameters.map(p => <label key={p.key}>{p.label}<input aria-label={p.label} disabled={busy || !!request.current} value={String(values[p.key] ?? '')} onChange={e => setValues(v => ({ ...v, [p.key]: p.type === 'number' ? Number(e.target.value) : e.target.value }))} /></label>)}
    <button className="dtc-btn pri" disabled={busy || !action} onClick={launch}>{busy ? '正在启动…' : request.current ? '重试本次制作' : '开始制作视频'}</button>
    {!catalog ? <span>读取已安装 Actions…</span> : null}
  </section>
}
