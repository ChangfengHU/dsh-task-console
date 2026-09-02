/** Agent and Task use separate sidebar entries; the hash carries the current screen. */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentRow, AgentSpec, Catalog, Preview, TaskSessionRow, TryRunResult } from '../wire.ts'
import { AgentsPage } from './AgentsPage.tsx'
import { TaskReplay } from './TaskReplay.tsx'
import { NewTask, TaskBoard, type TasksApi } from './TasksView.tsx'
import { SessionsPage, type NativeSessionRow } from './SessionsPage.tsx'

export interface Api extends TasksApi {
  catalog: () => Promise<Catalog>
  agents: () => Promise<AgentRow[]>
  previewAgent: (spec: AgentSpec) => Promise<Preview>
  saveAgent: (spec: AgentSpec) => Promise<{ path: string; preview: Preview }>
  deleteAgent: (id: string) => Promise<void>
  tryRun: (id: string) => Promise<TryRunResult>
  startAgentSession: (agentId: string, text?: string, cwd?: string) => Promise<{ sessionId: string; name: string }>
  openSession: (sessionId: string) => Promise<void>
  sessionTurns: (sessionId: string) => Promise<import('../wire.ts').TurnLedger>
  agentActivity: (agentId: string) => Promise<{ cards: number; done: number; failed: number; runs: number; lastRunAt: string | null; lastOutcome: string | null; tasks: { id: string; title: string }[] }>
  taskSessions: () => Promise<TaskSessionRow[]>
  sessionSnapshot: () => NativeSessionRow[]
  subscribeSessions: (listener: () => void) => () => void
  refreshSessions: () => Promise<void>
  archiveSession: (sessionId: string) => Promise<void>
}

export const HASH_PREFIX = '#/tc'

export function readRoute(): string[] {
  const h = window.location.hash
  if (!h.startsWith(HASH_PREFIX)) return []
  return h.slice(HASH_PREFIX.length).split('?', 1)[0].split('/').filter(Boolean)
}

/** Selection state belongs in the shareable hash, separate from the route path. */
export function readRouteQuery(): URLSearchParams {
  const h = window.location.hash
  if (!h.startsWith(HASH_PREFIX)) return new URLSearchParams()
  const mark = h.indexOf('?')
  return new URLSearchParams(mark < 0 ? '' : h.slice(mark + 1))
}

export function go(path: string): void {
  window.location.hash = `${HASH_PREFIX}/${path}`.replace(/\/+$/, '')
}

export function closeConsole(): void {
  history.pushState('', document.title, window.location.pathname + window.location.search)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

function useToast(): [string, (m: string) => void] {
  const [msg, setMsg] = useState('')
  const timer = useRef<number | undefined>(undefined)
  const show = useCallback((m: string) => { setMsg(m); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setMsg(''), 2800) }, [])
  return [msg, show]
}

/** A render error inside one page must not take the whole sidebar slot down. */
class Boundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() { return this.state.error ? <div className="dtc-err" style={{ margin: 20 }}>页面出错:{this.state.error.message}<br /><button className="dtc-btn sm" style={{ marginTop: 8 }} onClick={() => this.setState({ error: null })}>重试</button></div> : this.props.children }
}

export function Console({ api }: { api: Api }) {
  const [route, setRoute] = useState<string[]>(readRoute())
  const [query, setQuery] = useState<URLSearchParams>(readRouteQuery())
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [agents, setAgents] = useState<AgentRow[] | null>(null)
  const [error, setError] = useState('')
  const [toast, showToast] = useToast()

  useEffect(() => { const on = () => { setRoute(readRoute()); setQuery(readRouteQuery()) }; window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on) }, [])
  const loadAgents = useCallback(async () => {
    try { setAgents(await api.agents()); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [api])
  const loadCatalog = useCallback(async () => {
    try { setCatalog(await api.catalog()); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [api])

  const section = route[0] === 'tasks' ? 'tasks' : route[0] === 'sessions' ? 'sessions' : 'agents'
  const needsCatalog = section === 'agents' || route[1] === 'new'
  const reload = useCallback(async () => { await Promise.all([loadCatalog(), loadAgents()]) }, [loadCatalog, loadAgents])
  useEffect(() => { if (section !== 'sessions') void loadAgents(); if (needsCatalog) void loadCatalog() }, [loadAgents, loadCatalog, needsCatalog, section])
  const url = `${HASH_PREFIX}/${route.join('/')}`
  const loading = <div className="dtc-empty" style={{ padding: 60 }}><span className="dtc-spin" /> 读取…</div>

  let page: JSX.Element
  if (section === 'agents') page = !agents || !catalog ? loading : <AgentsPage api={api} catalog={catalog} agents={agents} id={route[1] === 'new' ? 'new' : (route[1] ?? null)} onSaved={reload} toast={showToast} />
  else if (section === 'sessions') page = <SessionsPage api={api} toast={showToast} />
  else if (route[1] === 'new') page = !agents || !catalog ? loading : <div className="dtc-body"><NewTask api={api} agents={agents} toast={showToast} workspaces={catalog.workspaces} /></div>
  else if (route[1]) page = <div className="dtc-body"><TaskReplay api={api} agents={agents ?? []} id={route[1]} runId={route[2] === 'runs' ? route[3] : undefined} sessionId={query.get('session') ?? undefined} toast={showToast} /></div>
  else page = <div className="dtc-body"><TaskBoard api={api} agents={agents ?? []} toast={showToast} /></div>

  return (
    <div className="dtc-root dtc-overlay">
      <div className="dtc-head">
        <div className="dtc-brand"><span className="ic">{section === 'agents' ? '◎' : section === 'sessions' ? '◫' : '▦'}</span><span><b>{section === 'agents' ? 'Agent' : section === 'sessions' ? 'Sessions' : '任务中心'}</b><small>{section === 'agents' ? '预置配置与能力边界' : section === 'sessions' ? '会话关系与生命周期' : '任务编排与交付验收'}</small></span></div>
        <div className="dtc-head-actions">
          {section === 'tasks' && !route[1] ? <button className="dtc-btn sm pri" onClick={() => go('tasks/new')}>＋ 新建任务</button> : null}
          <span className="dtc-head-context">{section === 'agents' ? (route[1] === 'new' ? '新建 Agent' : 'Agent 配置') : section === 'sessions' ? '会话管理' : route[1] === 'new' ? '新建任务' : route[1] ? '任务详情' : '任务看板'}</span>
          <button className="dtc-close" title="关闭工作台" aria-label="关闭工作台" onClick={closeConsole}>×</button>
        </div>
      </div>
      {error ? <div className="dtc-err" style={{ margin: '12px 20px 0' }}>{error}</div> : null}
      <Boundary key={url}>{page}</Boundary>
      {toast ? <div className="dtc-toast">{toast}</div> : null}
    </div>
  )
}
