/** Agent and Task use separate sidebar entries; the hash carries the current screen. */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentRow, AgentSpec, Catalog, Preview, TryRunResult } from '../wire.ts'
import { AgentsPage } from './AgentsPage.tsx'
import { TaskReplay } from './TaskReplay.tsx'
import { NewTask, TaskBoard, type TasksApi } from './TasksView.tsx'
import { TaskPlanReview } from './TaskPlanReview.tsx'
import { TaskExecutions } from './TaskExecutions.tsx'
import { ConfigMigration } from './ConfigMigration.tsx'
import { ActionEditor } from './AgentActions.tsx'

export interface Api extends TasksApi {
  agentPage: (query:{page:number;query:string;id?:string})=>Promise<{page:number;pages:number;total:number;rows:AgentRow[];detail:AgentRow|null}>
  taskActions: (taskId: string) => Promise<import('../agent-actions.ts').ActionCatalog>
  saveTaskActions: (taskId: string, actions: import('../agent-actions.ts').AgentAction[], revision: string) => Promise<import('../agent-actions.ts').ActionCatalog>
  launchTaskAction: (query: import('../task-actions.ts').TaskActionInput) => Promise<{ taskId: string; batchId: string; path: string }>
  agentActions: (query: { agentId?: string; sessionId?: string }) => Promise<import('../agent-actions.ts').ActionCatalog>
  agentActionOptions: (query: import('../action-options.ts').ActionOptionQuery) => Promise<import('../action-options.ts').ActionOptionPage>
  saveAgentActions: (agentId: string, actions: import('../agent-actions.ts').AgentAction[], revision: string) => Promise<import('../agent-actions.ts').ActionCatalog>
  prepareAgentAction: (query: { agentId: string; sessionId?: string; actionId: string; revision: string; values: Record<string, unknown> }) => Promise<{ text: string; agentId: string }>
  taskPlans: (page: number) => Promise<any>
  taskPlan: (id: string) => Promise<any>
  reviewTaskPlan: (id: string, hash: string, decision: 'approve' | 'reject', reason: string) => Promise<any>
  agentHistory: (query: import('../wire.ts').AgentHistoryQuery) => Promise<import('../wire.ts').AgentHistoryPage>
  launchWorkflow: (taskId: string, text: string, requestId: string, cwd?: string) => Promise<{ taskId: string; batchId: string; path: string }>
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

/** Static assets can update while an active Task keeps the old host alive. */
function TaskTabs({ api, id, actions, batchId, report = false }: { api: Api; id: string; actions: boolean; batchId?: string; report?: boolean }) {
  const [supported, setSupported] = useState(false)
  useEffect(() => { let live = true; setSupported(false); void api.workflowCatalog().then(rows => { if (live) setSupported(rows.some(t => t.id === id && typeof t.actionCount === 'number')) }).catch(() => {}); return () => { live = false } }, [api, id])
  if (!supported) return null
  return <nav className="dtc-action-toolbar" aria-label="Task 导航"><button className={`dtc-btn sm ${!actions && !report ? 'pri' : ''}`} aria-pressed={!actions && !report} onClick={() => go(batchId ? `tasks/${id}/runs/${batchId}` : `tasks/${id}`)}>执行记录</button>{batchId ? <button className={`dtc-btn sm ${report ? 'pri' : ''}`} aria-pressed={report} onClick={() => go(`tasks/${id}/runs/${batchId}/report`)}>执行报告</button> : null}<button className={`dtc-btn sm ${actions ? 'pri' : ''}`} aria-pressed={actions} onClick={() => go(`tasks/${id}/actions`)}>Actions</button></nav>
}

export function Console({ api }: { api: Api }) {
  const [route, setRoute] = useState<string[]>(readRoute())
  const [query, setQuery] = useState<URLSearchParams>(readRouteQuery())
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [agents, setAgents] = useState<AgentRow[] | null>(null)
  const [error, setError] = useState('')
  const [toast, showToast] = useToast()
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Use the same explicit close buttons as pointer users, from top layer down.
    // A disabled close button must not fall through and dismiss the whole center.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.repeat || event.defaultPrevented || !root.current) return
      const visible = (selector: string, within: Element = root.current!) =>
        Array.from(within.querySelectorAll<HTMLElement>(selector)).find(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
      const layers: [string, string][] = [
        ['.dtc-art-modal', 'header button'],
        ['.dtc-execution-popover', ''],
        ['.dtc-session-layer', '.dtc-session-scrim'],
        ['.dtc-modal', '.dtc-close'],
        ['.inspector-open .dtc-dag-inspector', '.dtc-inspector-close'],
        ['.dtc-dag-fullscreen', '[data-dtc-exit-fullscreen]'],
      ]
      event.preventDefault(); event.stopImmediatePropagation()
      for (const [selector, closeSelector] of layers) {
        const layer = visible(selector)
        if (!layer) continue
        const button = selector === '.dtc-execution-popover'
          ? visible('.dtc-execution-picker button[aria-expanded="true"]')
          : visible(closeSelector, layer)
        // Desktop inspectors are always visible, but are not a dismissible layer.
        if (!button && selector === '.inspector-open .dtc-dag-inspector') continue
        if (button && !(button as HTMLButtonElement).disabled) button.click()
        return
      }
      if (!visible('[role="dialog"]')) closeConsole()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => { const on = () => { setRoute(readRoute()); setQuery(readRouteQuery()) }; window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on) }, [])
  useEffect(() => { if (route[0] === 'sessions') go('agents') }, [route])
  const loadAgents = useCallback(async () => {
    try { setAgents(await api.agents()); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [api])
  const loadCatalog = useCallback(async () => {
    try { setCatalog(await api.catalog()); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [api])

  const section = route[0] === 'tasks' ? 'tasks' : 'agents'
  const executionPage = section === 'tasks' && !!route[1] && !['new', 'plans', 'executions', 'migration'].includes(route[1]) && route[2] !== 'actions'
  const report = executionPage && route[2] === 'runs' && route[4] === 'report'
  const needsCatalog = section === 'agents' || route[1] === 'new'
  const needsTaskAgentNames = section === 'tasks' && !!route[1] && !['new', 'migration', 'executions', 'plans'].includes(route[1])
  useEffect(() => { if (needsTaskAgentNames) void loadAgents() }, [loadAgents, needsTaskAgentNames])
  const reload = useCallback(async () => { await Promise.all([loadCatalog(), loadAgents()]) }, [loadCatalog, loadAgents])
  useEffect(() => { if (needsCatalog) { if(section!=='agents')void loadAgents(); void loadCatalog() } }, [loadAgents, loadCatalog, needsCatalog, section])
  const url = `${HASH_PREFIX}/${route.join('/')}`
  const loading = <div className="dtc-empty" style={{ padding: 60 }}><span className="dtc-spin" /> 读取…</div>

  let page: JSX.Element
  if (section === 'agents') page = !catalog ? loading : <AgentsPage api={api} catalog={catalog} agents={[]} id={route[1] === 'new' ? 'new' : (route[1] ?? null)} onSaved={loadCatalog} toast={showToast} />
  else if (route[1] === 'new') page = !agents || !catalog ? loading : <div className="dtc-body"><NewTask api={api} agents={agents} toast={showToast} workspaces={catalog.workspaces} /></div>
  else if (route[1] === 'plans') page = <div className="dtc-body"><TaskPlanReview api={api} id={route[2]} /></div>
  else if (route[1] === 'executions') page = <div className="dtc-body"><TaskExecutions api={api} query={query} /></div>
  else if (route[1] === 'migration') page = <div className="dtc-body"><ConfigMigration api={api} toast={showToast} /></div>
  else if (route[1]) page = <div className="dtc-body">{!executionPage && <TaskTabs api={api} id={route[1]} actions={true} />}{route[2] === 'actions' ? <ActionEditor key={route[1]} api={api} taskId={route[1]} /> : <TaskReplay api={api} agents={agents ?? []} id={route[1]} report={report} runId={route[2] === 'runs' ? route[3] : undefined} sessionId={query.get('session') ?? undefined} toast={showToast} />}</div>
  else page = <div className="dtc-body"><TaskBoard api={api} agents={agents ?? []} toast={showToast} /></div>

  return (
    <div className="dtc-root dtc-overlay" ref={root}>
      <div className="dtc-head">
        <div className="dtc-brand"><span className="ic">{section === 'agents' ? '◎' : '▦'}</span><span><b>{section === 'agents' ? 'Agent' : '任务中心'}</b><small>{section === 'agents' ? '预置配置与能力边界' : '任务编排与交付验收'}</small></span></div>
        <div className="dtc-head-actions">
          {executionPage ? <TaskTabs api={api} id={route[1]} actions={false} batchId={route[2] === 'runs' ? route[3] : undefined} report={report} /> : null}
          {section === 'agents' && !route[1] ? <button className="dtc-btn sm" onClick={() => go('tasks/migration')}>导入 / 导出</button> : null}
          {section === 'tasks' && !route[1] ? <><button className="dtc-btn sm" onClick={() => go('tasks/migration')}>导入 / 导出</button><button className="dtc-btn sm" onClick={() => go('tasks/executions')}>执行记录</button><button className="dtc-btn sm" onClick={() => go('tasks/plans')}>计划审查</button><button className="dtc-btn sm pri" onClick={() => go('tasks/new')}>＋ 新建任务</button></> : null}
          <span className="dtc-head-context">{section === 'agents' ? (route[1] === 'new' ? '新建 Agent' : 'Agent 配置') : route[1] === 'new' ? '新建任务' : route[1] === 'executions' ? '执行记录' : route[1] === 'migration' ? '配置迁移' : route[1] ? '任务详情' : '任务看板'}</span>
          <button className="dtc-close" title="关闭工作台" aria-label="关闭工作台" onClick={closeConsole}>×</button>
        </div>
      </div>
      {error ? <div className="dtc-err" style={{ margin: '12px 20px 0' }}>{error}</div> : null}
      <Boundary key={executionPage ? `execution/${route[1]}` : url}>{page}</Boundary>
      {toast ? <div className="dtc-toast">{toast}</div> : null}
    </div>
  )
}
