/** Lightweight browser entry. Heavy Agent, Board, DAG, and Trace code is fetched on demand. */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentRow } from '../wire.ts'
import { agentCandidates, AGENT_EXPAND, AGENT_COLLAPSE } from '../agent-order.ts'
import { installLightStyles } from './light-styles.ts'
import { actionCandidates, type ActionCatalog } from '../agent-actions.ts'
import { ACTION_OPEN, ACTION_CHANGED, type ActionRequest } from './action-dispatch.ts'

declare const require: (id: string) => unknown
declare const __DTC_VERSION__: string
declare const __DTC_ASSET_HASH__: string

export const name = 'dsh-task-console'
export const inject = ['slots', 'remote', 'sessions', 'workspaces', 'inputTriggers']
const HASH_PREFIX = '#/tc'

type Heavy = typeof import('./heavy.tsx')
type HeavyWindow = Window & { __DSHTaskConsoleHeavyFactory__?: (require: (id: string) => unknown) => Heavy }
let heavyPromise: Promise<Heavy> | undefined

function loadHeavy(): Promise<Heavy> {
  if (heavyPromise) return heavyPromise
  heavyPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.async = true
    script.src = `/dsh-task-console/client-heavy.js?v=${encodeURIComponent(__DTC_VERSION__)}&sha=${__DTC_ASSET_HASH__}`
    script.onload = () => {
      script.remove()
      const factory = (window as HeavyWindow).__DSHTaskConsoleHeavyFactory__
      if (!factory) { reject(new Error('任务界面已下载，但没有注册模块')); return }
      try { resolve(factory(require)) } catch (error) { reject(error) }
    }
    script.onerror = () => { script.remove(); reject(new Error('任务界面加载失败，请重试')) }
    document.head.append(script)
  }).catch(error => { heavyPromise = undefined; throw error })
  return heavyPromise
}

function go(path: string): void { window.location.hash = `${HASH_PREFIX}/${path}`.replace(/\/+$/, '') }

export async function apply(ctx: any): Promise<void> {
  ctx.effect(() => { document.documentElement.setAttribute('data-dsh-task-entry', ''); return () => document.documentElement.removeAttribute('data-dsh-task-entry') }, 'task-console: task mentions replace history references')
  ctx.effect(() => installLightStyles(), 'task-console: lightweight stylesheet')
  ctx.effect(() => installSessionUrlSync(ctx), 'task-console: session URL sync')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'task-console', order: 30, inject: () => ({ ctx }) }, FooterEntry))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'task-console-trace', order: 25, label: () => 'Trace', inject: (sessionId: string) => ({ ctx, sessionId }) }, LazyTrace))
  try { ctx.effect(() => ctx.inputTriggers.registerSource(lazyAgentSource(ctx)), 'task-console: lazy @agent trigger') } catch (error) { console.warn('[task-console] @agent trigger not registered:', error) }
}

/** Keep native session selection shareable without replacing DSH's own session list. */
function installSessionUrlSync(ctx: any): () => void {
  let requested = new URL(window.location.href).searchParams.get('session')
  const sync = () => {
    const snapshot = ctx.sessions.list.getSnapshot()
    if (requested && snapshot.byId?.[requested]) {
      const target = requested
      // open() publishes synchronously. Consume before notifying subscribers.
      requested = null
      try { if (snapshot.current !== target) ctx.sessions.open(target); return }
      catch { requested = target /* retry when the session list is ready */ }
    }
    if (window.location.hash.startsWith(HASH_PREFIX)) return
    const url = new URL(window.location.href)
    const internal = new Set<string>(ctx.workspaces.list.getSnapshot().internalSessionIds ?? [])
    const addressed = url.searchParams.get('session')
    if (snapshot.current && internal.has(snapshot.current) && addressed === snapshot.current) return
    if (!addressed && snapshot.current && internal.has(snapshot.current)) {
      const visible = snapshot.ids.find((id: string) => !internal.has(id))
      if (visible) { ctx.sessions.open(visible); return }
    }
    const current = snapshot.current && !internal.has(snapshot.current) ? snapshot.current : undefined
    if (current) url.searchParams.set('session', current)
    else url.searchParams.delete('session')
    history.replaceState('', document.title, `${url.pathname}${url.search}${url.hash}`)
  }
  const stopSessions = ctx.sessions.list.subscribe(sync)
  const stopWorkspaces = ctx.workspaces.list.subscribe(sync)
  window.addEventListener('hashchange', sync)
  // pushState session links are traversed with popstate; not every browser
  // emits hashchange for that traversal. Re-notify the console route readers.
  const onPop = () => {
    requested = new URL(window.location.href).searchParams.get('session')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }
  window.addEventListener('popstate', onPop)
  sync()
  return () => { stopSessions(); stopWorkspaces(); window.removeEventListener('hashchange', sync); window.removeEventListener('popstate', onPop) }
}

function useHeavy(ctx: any): { heavy?: Heavy; api?: Awaited<ReturnType<Heavy['activate']>>; error?: string } {
  const [state, setState] = useState<{ heavy?: Heavy; api?: Awaited<ReturnType<Heavy['activate']>>; error?: string }>({})
  useEffect(() => { let live = true; loadHeavy().then(async heavy => ({ heavy, api: await heavy.activate(ctx) })).then(next => { if (live) setState(next) }).catch(error => { if (live) setState({ error: String(error?.message ?? error) }) }); return () => { live = false } }, [ctx])
  return state
}

function LazyConsole({ ctx }: { ctx: any }) {
  const { heavy, api, error } = useHeavy(ctx)
  if (error) return <div className="dtc-lazy error">{error}</div>
  if (!heavy || !api) return <div className="dtc-lazy"><div><span />正在加载任务界面…</div></div>
  return <heavy.Console api={api} />
}

function LazyTrace({ ctx, sessionId }: { ctx: any; sessionId: string }) {
  const { heavy, api, error } = useHeavy(ctx)
  if (error) return <div className="dtc-lazy error">{error}</div>
  if (!heavy || !api) return <div className="dtc-lazy"><div><span />正在加载 Trace…</div></div>
  return <heavy.SessionLedgerTab api={api} sessionId={sessionId} />
}

function FooterEntry({ ctx, wide }: { ctx: any; wide?: boolean }) {
  const [action, setAction] = useState<ActionRequest | null>(null)
  useEffect(() => { const on = (event: Event) => setAction((event as CustomEvent<ActionRequest>).detail); window.addEventListener(ACTION_OPEN, on); return () => window.removeEventListener(ACTION_OPEN, on) }, [])
  const [open, setOpen] = useState(window.location.hash.startsWith(HASH_PREFIX))
  useEffect(() => { const on = () => setOpen(window.location.hash.startsWith(HASH_PREFIX)); window.addEventListener('hashchange', on); on(); return () => window.removeEventListener('hashchange', on) }, [])
  const narrow = wide === false
  return <><div className="dtc-footstack"><button type="button" className={`dtc-foot ${narrow ? 'narrow' : ''}`} title="Agent" aria-label="Agent" onClick={() => go('agents')}><span className="ic">◎</span>{narrow ? null : <span>Agent</span>}</button><button type="button" className={`dtc-foot ${narrow ? 'narrow' : ''}`} title="任务看板" aria-label="任务看板" onClick={() => go('tasks')}><span className="ic">▦</span>{narrow ? null : <span>Board</span>}</button></div>{open ? createPortal(<LazyConsole ctx={ctx} />, document.body) : null}{action ? createPortal(<LazyAction key={`${action.originSessionId}:${action.agentId}:${action.actionId ?? ''}`} ctx={ctx} request={action} close={() => setAction(null)} />, document.body) : null}</>
}

function LazyAction({ ctx, request, close }: { ctx: any; request: ActionRequest; close: () => void }) {
  const { heavy, api, error } = useHeavy(ctx)
  if (!heavy || !api) return <div className="dtc-lazy">{error ?? '正在加载 Action…'}<button onClick={close}>取消</button></div>
  return <heavy.ActionDialog api={api} ctx={ctx} request={request} close={close} />
}

function currentCwd(ctx: any, action: any): string | undefined {
  try { const id = action?.session?.id ?? action?.sessionId; const snap = ctx.sessions?.list?.getSnapshot?.(); const cwd = id && snap?.byId?.[id]?.cwd; if (typeof cwd === 'string' && cwd) return cwd; const current = snap?.current && snap.byId?.[snap.current]?.cwd; return typeof current === 'string' && current ? current : undefined } catch { return undefined }
}

function lazyAgentSource(ctx: any) {
  const expanded = new Set<string>()
  let roster: AgentRow[] = []
  let workflows: { id: string; title: string; brief: string; scheduleEnabled?: boolean | null }[] = []
  let refreshedAt = 0
  let role: { sessionId: string; at: number; catalog: ActionCatalog } | undefined
  ctx.effect(() => { const clear = () => { refreshedAt = 0; role = undefined }; window.addEventListener(ACTION_CHANGED, clear); return () => window.removeEventListener(ACTION_CHANGED, clear) }, 'task-console: action cache invalidation')
  const api = async () => (await loadHeavy()).activate(ctx)
  const refresh = async () => { if (Date.now() - refreshedAt < 1500) return; const service = await api(); const [agents, tasks] = await Promise.all([service.agents(), service.workflowCatalog()]); roster = agents.filter(agent => !agent.broken); workflows = tasks; refreshedAt = Date.now() }
  const currentActions = async (sessionId: string) => {
    if (!role || role.sessionId !== sessionId || Date.now() - role.at > 1500) role = { sessionId, at: Date.now(), catalog: await (await api()).agentActions({ sessionId }) }
    return role.catalog
  }
  const showAction = (pick: any, agentId: string, name: string, actionId?: string) => {
    window.dispatchEvent(new CustomEvent(ACTION_OPEN, { detail: { agentId, name, actionId, ...(actionId ? { targetSessionId: pick.session.sessionId } : {}), originSessionId: pick.session.sessionId, span: pick.span, cwd: currentCwd(ctx, pick.session) } satisfies ActionRequest }))
    return 'handled' as const
  }
  const claimFor = (agent: AgentRow, prefix: string) => ({ claim: { token: prefix, hint: `要 ${agent.name} 做什么`, images: false, submit: async (args: string, action: any) => { try { const service = await api(); const { sessionId } = await service.startAgentSession(agent.id, args, currentCwd(ctx, action)); await service.openSession(sessionId); return { kind: 'success' as const } } catch (error) { return { kind: 'error' as const, text: error instanceof Error ? error.message : String(error) } } } } })
  const claimTask = (task: { id: string; title: string }, prefix: string) => {
    const requestId = crypto.randomUUID()
    return { claim: { token: prefix, hint: `提交 ${task.title} 的本次参数 · 新执行记录`, images: false, submit: async (text: string, action: any) => {
      try { const result = await (await api()).launchWorkflow(task.id, text, requestId, currentCwd(ctx, action)); go(`tasks/${result.taskId}/runs/${result.batchId}`); return { kind: 'success' as const } }
      catch (error) { return { kind: 'error' as const, text: error instanceof Error ? error.message : String(error) } }
    } } }
  }
  return {
    trigger: '@' as const, name: 'Agent', order: -10, warm: () => undefined,
    candidates: async (session: { sessionId: string }, request: { query: string }) => { const [, catalog] = await Promise.all([refresh(), currentActions(session.sessionId).catch(() => null)]); const query = (request.query ?? '').toLowerCase(); return [
      ...actionCandidates(catalog, query),
      ...agentCandidates(roster, query, expanded.has(session.sessionId)),
      ...workflows.filter(task => !query || task.title.toLowerCase().includes(query) || task.id.toLowerCase().includes(query)).map(task => ({ name: task.title, description: `${task.scheduleEnabled === false ? '定时已暂停 · 可手动执行。' : ''}${task.brief}`, hint: '复用工作流 · 新执行', value: `task:${task.id}`, section: 'Task / Workflow' })),
    ] },
    onPick: (pick: { candidate: { value?: string }; session: { sessionId: string } }) => {
      if (pick.candidate.value?.startsWith('action:') && role?.sessionId === pick.session.sessionId && role.catalog.agentId) return showAction(pick, role.catalog.agentId, role.catalog.name, pick.candidate.value.slice(7))
      if (pick.candidate.value === AGENT_EXPAND || pick.candidate.value === AGENT_COLLAPSE) {
        if (pick.candidate.value === AGENT_EXPAND) expanded.add(pick.session.sessionId)
        else expanded.delete(pick.session.sessionId)
        return { text: '@', continue: true }
      }
      const task = workflows.find(row => `task:${row.id}` === pick.candidate.value); if (task) return claimTask(task, `@${task.title} `); const agent = roster.find(row => row.id === pick.candidate.value); return agent ? agent.actionCount ? showAction(pick, agent.id, agent.name) : claimFor(agent, `@${agent.name} `) : undefined
    },
    matchEnter: async (_session: unknown, line: string) => { const match = /^@(\S+)\s*([\s\S]*)$/.exec(line.trim()); if (!match) return undefined; await refresh(); const task = workflows.find(row => row.title === match[1] || row.id === match[1]); if (task) return claimTask(task, `@${match[1]} `); const agent = roster.find(row => row.name === match[1] || row.id === match[1]); return agent ? claimFor(agent, `@${match[1]} `) : undefined },
  }
}
