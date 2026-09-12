/** Lightweight browser entry. Heavy Agent, Board, DAG, and Trace code is fetched on demand. */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { installLightStyles } from './light-styles.ts'
import { agentMentionSource } from './agent-mentions.ts'

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
  try { ctx.effect(() => ctx.inputTriggers.registerSource(agentMentionSource(ctx, async () => (await loadHeavy()).activate(ctx), go)), 'task-console: lazy @agent trigger') } catch (error) { console.warn('[task-console] @agent trigger not registered:', error) }
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
  const [open, setOpen] = useState(window.location.hash.startsWith(HASH_PREFIX))
  useEffect(() => { const on = () => setOpen(window.location.hash.startsWith(HASH_PREFIX)); window.addEventListener('hashchange', on); on(); return () => window.removeEventListener('hashchange', on) }, [])
  const narrow = wide === false
  return <><div className="dtc-footstack"><button type="button" className={`dtc-foot ${narrow ? 'narrow' : ''}`} title="Agent" aria-label="Agent" onClick={() => go('agents')}><span className="ic">◎</span>{narrow ? null : <span>Agent</span>}</button><button type="button" className={`dtc-foot ${narrow ? 'narrow' : ''}`} title="任务看板" aria-label="任务看板" onClick={() => go('tasks')}><span className="ic">▦</span>{narrow ? null : <span>Board</span>}</button></div>{open ? createPortal(<LazyConsole ctx={ctx} />, document.body) : null}</>
}
