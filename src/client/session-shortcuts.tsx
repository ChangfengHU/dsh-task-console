/** Lightweight Session module. Uses existing native metadata and two narrow RPCs. */
import { useSyncExternalStore, useState } from 'react'
import type { SessionShortcut, ShortcutKind } from '../session-shortcuts.ts'

const EVENT = 'dtc:session-shortcuts'
const KEY = '__DSHSessionShortcuts__'
type State = { rows: SessionShortcut[]; ready: boolean; error: string; pending: Set<string> }

export function shortcutRows(rows: SessionShortcut[], sessions: any, workspaces: any) {
  const hidden = new Set([...(workspaces.archivedSessionIds ?? []), ...(workspaces.internalSessionIds ?? [])])
  return rows.filter(row => sessions.byId?.[row.sessionId] && !sessions.byId[row.sessionId].blank && sessions.byId[row.sessionId].origin !== 'subagent' && !hidden.has(row.sessionId))
}

export function installSessionShortcuts(ctx: any): () => void {
  let state: State = { rows: [], ready: false, error: '', pending: new Set() }, live = true, generation = 0
  const listeners = new Set<() => void>()
  const publish = (next: Partial<State>) => { if (!live) return; state = { ...state, ...next }; for (const fn of listeners) fn(); window.dispatchEvent(new Event(EVENT)) }
  const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
  const visible = () => shortcutRows(state.rows, ctx.sessions.list.getSnapshot(), ctx.workspaces.list.getSnapshot())
  const eligible = (id: string) => shortcutRows([{ sessionId: id } as SessionShortcut], ctx.sessions.list.getSnapshot(), ctx.workspaces.list.getSnapshot()).length > 0
  const controllers = new Set<AbortController>()
  const rpc = async (method: 'sessionShortcuts' | 'setSessionShortcut', value?: unknown): Promise<SessionShortcut[]> => {
    const controller = new AbortController(); controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 12000)
    try {
      const name = `taskConsole/${method}`
      const response = await fetch(`/api/${name}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: name, payload: { args: value === undefined ? {} : { payload: JSON.stringify(value) } } }) })
      if (!response.ok) throw Error(`会话标记请求失败（${response.status}）`)
      const data = await response.json(), result = data.result
      if (!result?.ok) throw Error(result?.error?.message ?? '会话标记服务暂不可用')
      const rows = typeof result.value === 'string' ? JSON.parse(result.value) : result.value
      if (!Array.isArray(rows)) throw Error('会话标记返回格式不正确')
      return rows
    } finally { clearTimeout(timeout); controllers.delete(controller) }
  }
  const refresh = async () => {
    if (state.pending.size || !live) return
    const token = ++generation
    try { const rows = await rpc('sessionShortcuts'); if (token === generation) publish({ rows, ready: true, error: '' }) }
    catch (error: any) { if (token === generation) publish({ error: error.message ?? '会话标记读取失败' }) }
  }
  const set = async (id: string, kind: ShortcutKind, value: boolean) => {
    if (!state.ready || state.pending.size || !eligible(id)) return
    ++generation
    const expected = Boolean(state.rows.find(r => r.sessionId === id)?.[kind])
    publish({ pending: new Set([id]), error: '' })
    try { const rows = await rpc('setSessionShortcut', { sessionId: id, kind, value, expected }); publish({ rows, pending: new Set() }) }
    catch (error: any) { publish({ pending: new Set(), error: `${error.message ?? '保存失败'}；未确认成功，请刷新核对后重试。` }) }
  }
  const bridge = {
    subscribe, getSnapshot: () => state, visible, refresh,
    menu(id: string) { const row = state.rows.find(r => r.sessionId === id); return !state.ready || state.pending.size || !eligible(id) ? [] : [
      { id: 'dtc-pin', label: row?.pinned ? 'Unpin session' : 'Pin session' },
      { id: 'dtc-favorite', label: row?.favorite ? 'Remove from Favorites' : 'Add to Favorites' },
    ] },
    select(id: string, action: string) { const kind = action === 'dtc-pin' ? 'pinned' : action === 'dtc-favorite' ? 'favorite' : null; if (kind) void set(id, kind, !state.rows.find(r => r.sessionId === id)?.[kind]) },
    set,
  }
  ;(window as any)[KEY] = bridge
  const stopSessions = ctx.sessions.list.subscribe(() => publish({})), stopWorkspaces = ctx.workspaces.list.subscribe(() => publish({}))
  const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 30000)
  const focus = () => { if (document.visibilityState === 'visible') void refresh() }
  window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus)
  const style = document.createElement('style'); style.textContent = CSS; document.head.append(style)
  try {
    ctx.slots.inject('sidebar.workspaces.shortcuts', () => ctx.slots.register({ name: 'sidebar.workspaces.shortcuts', id: 'task-console-session', inject: () => ({ ctx, bridge }) }, SessionShortcuts))
  } catch { console.warn('[task-console] Session shortcuts require the supported host sidebar patch; existing Agent/Board remain available') }
  publish({}); void refresh()
  return () => { live = false; ++generation; clearInterval(timer); stopSessions(); stopWorkspaces(); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); for (const c of controllers) c.abort(); style.remove(); if ((window as any)[KEY] === bridge) delete (window as any)[KEY]; window.dispatchEvent(new Event(EVENT)); listeners.clear() }
}

function MarkIcon({ kind }: { kind: ShortcutKind | 'folder' }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={kind === 'pinned' ? 'M9 3h6l-1 6 4 4v2h-5v6l-1-2-1 2v-6H6v-2l4-4z' : kind === 'favorite' ? 'm12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z' : 'M3 7V5h7l2 2h9v13H3z'} /></svg>
}

function SessionShortcuts({ ctx, bridge }: { ctx: any; bridge: any }) {
  const state = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot) as State
  const [expanded, expand] = useState(true)
  const rows: SessionShortcut[] = bridge.visible(), sessions = ctx.sessions.list.getSnapshot()
  const pinned = rows.filter(r => r.pinned).sort((a, b) => b.pinnedAt - a.pinnedAt || a.sessionId.localeCompare(b.sessionId))
  const favorites = rows.filter(r => r.favorite).sort((a, b) => b.favoriteAt - a.favoriteAt || a.sessionId.localeCompare(b.sessionId))
  const row = (r: SessionShortcut, kind: ShortcutKind) => {
    const s = sessions.byId[r.sessionId], title = s.displayTitle || r.sessionId
    return <div className={`dtc-session-row ${sessions.current === r.sessionId ? 'selected' : ''}`} key={r.sessionId} data-session-shortcut={r.sessionId}>
      <button className="dtc-session-open" title={title} onClick={() => { const url = new URL(window.location.href); url.searchParams.set('session', r.sessionId); url.hash = ''; history.pushState('', '', url); ctx.sessions.open(r.sessionId); window.dispatchEvent(new HashChangeEvent('hashchange')) }}><MarkIcon kind={kind} /><span>{title}</span>{s.running ? <i title="Running" /> : null}</button>
      <button className="dtc-session-remove" disabled={state.pending.size > 0} aria-label={kind === 'pinned' ? `Unpin ${title}` : `Unfavorite ${title}`} title={kind === 'pinned' ? '取消置顶' : '取消收藏'} onClick={() => bridge.set(r.sessionId, kind, false)}>×</button>
    </div>
  }
  return <section className="dtc-session-shortcuts" aria-label="Session shortcuts">
    {state.error ? <div className="dtc-session-error" role="status">{state.error} <button onClick={() => bridge.refresh()}>重试</button></div> : null}
    {state.pending.size ? <div className="dtc-session-empty" role="status">正在保存会话标记…</div> : null}
    {pinned.length ? <div className="dtc-session-pinned"><div className="dtc-session-heading">Pinned <span>{pinned.length}</span></div><div className="dtc-session-items">{pinned.map(r => row(r, 'pinned'))}</div></div> : null}
    <button className="dtc-session-heading folder" aria-expanded={expanded} onClick={() => expand(!expanded)}><span aria-hidden="true">{expanded ? '▾' : '▸'}</span><MarkIcon kind="folder" />Favorites <span>{favorites.length}</span></button>
    {expanded ? <div className="dtc-session-items">{favorites.length ? favorites.map(r => row(r, 'favorite')) : <div className="dtc-session-empty">{state.ready ? '在会话 ⋯ 菜单中添加收藏' : '正在读取收藏…'}</div>}</div> : null}
  </section>
}

const CSS = `.dtc-session-shortcuts{font:inherit;color:var(--dsw-alias-label-primary);margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l2)}.dtc-session-heading{display:flex;align-items:center;gap:6px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);min-height:30px;padding:0 8px}.dtc-session-heading span:last-child{margin-left:auto;font-size:11px}.dtc-session-heading.folder{width:100%;cursor:pointer;border:0;background:transparent;border-radius:8px;text-align:left}.dtc-session-items{max-height:192px;overflow-y:auto}.dtc-session-row{display:flex;align-items:center;height:32px;border-radius:8px;min-width:0}.dtc-session-row:hover,.dtc-session-row:focus-within,.dtc-session-row.selected,.dtc-session-heading.folder:hover{background:var(--dsw-alias-interactive-bg-hover)}.dtc-session-open{display:flex;align-items:center;gap:6px;min-width:0;flex:1;height:100%;padding:0 8px;cursor:pointer;background:transparent;border:0;color:inherit;font:inherit;font-size:14px;text-align:left}.dtc-session-open svg{flex:none;color:var(--dsw-alias-label-tertiary)}.dtc-session-open span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dtc-session-open i{width:5px;height:5px;flex:none;border-radius:50%;background:var(--dsw-alias-state-business-primary)}.dtc-session-remove{visibility:hidden;background:transparent;border:0;color:var(--dsw-alias-label-secondary);cursor:pointer;width:26px;height:28px;flex:none}.dtc-session-row:hover .dtc-session-remove,.dtc-session-row:focus-within .dtc-session-remove{visibility:visible}.dtc-session-empty,.dtc-session-error{padding:4px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}.dtc-session-error{color:var(--dsw-alias-state-error-primary)}.dtc-session-error button{font:inherit;background:transparent;color:inherit;border:0;text-decoration:underline;cursor:pointer}@media(hover:none){.dtc-session-remove{visibility:visible}}`
