/** Lightweight browser entry. Heavy Agent, Board, DAG, and Trace code is fetched on demand. */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentRow } from '../wire.ts'
import { installLightStyles } from './light-styles.ts'

declare const require: (id: string) => unknown
declare const __DTC_VERSION__: string

export const name = 'dsh-task-console'
export const inject = ['slots', 'remote', 'sessions', 'inputTriggers']
const HASH_PREFIX = '#/tc'

type Heavy = typeof import('./heavy.tsx')
type HeavyWindow = Window & { __DSHTaskConsoleHeavyFactory__?: (require: (id: string) => unknown) => Heavy }
let heavyPromise: Promise<Heavy> | undefined

function loadHeavy(): Promise<Heavy> {
  if (heavyPromise) return heavyPromise
  heavyPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.async = true
    script.src = `/dsh-task-console/client-heavy.js?v=${encodeURIComponent(__DTC_VERSION__)}`
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
  ctx.effect(() => installLightStyles(), 'task-console: lightweight stylesheet')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'task-console', order: 30, inject: () => ({ ctx }) }, FooterEntry))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'task-console-trace', order: 25, label: () => 'Trace', inject: (sessionId: string) => ({ ctx, sessionId }) }, LazyTrace))
  try { ctx.effect(() => ctx.inputTriggers.registerSource(lazyAgentSource(ctx)), 'task-console: lazy @agent trigger') } catch (error) { console.warn('[task-console] @agent trigger not registered:', error) }
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

function currentCwd(ctx: any, action: any): string | undefined {
  try { const id = action?.session?.id ?? action?.sessionId; const snap = ctx.sessions?.list?.getSnapshot?.(); const cwd = id && snap?.byId?.[id]?.cwd; if (typeof cwd === 'string' && cwd) return cwd; const current = snap?.current && snap.byId?.[snap.current]?.cwd; return typeof current === 'string' && current ? current : undefined } catch { return undefined }
}

function lazyAgentSource(ctx: any) {
  let roster: AgentRow[] = []
  const api = async () => (await loadHeavy()).activate(ctx)
  const refresh = async () => { roster = (await (await api()).agents()).filter(agent => !agent.broken) }
  const claimFor = (agent: AgentRow, prefix: string) => ({ claim: { token: prefix, hint: `要 ${agent.name} 做什么`, images: false, submit: async (args: string, action: any) => { try { const service = await api(); const { sessionId } = await service.startAgentSession(agent.id, args, currentCwd(ctx, action)); await service.openSession(sessionId); return { kind: 'success' as const } } catch (error) { return { kind: 'error' as const, text: error instanceof Error ? error.message : String(error) } } } } })
  return {
    trigger: '@' as const, name: 'Agent', order: -10, warm: () => undefined,
    candidates: async (_session: unknown, request: { query: string }) => { if (!roster.length) await refresh(); const query = (request.query ?? '').toLowerCase(); return roster.filter(agent => !query || agent.name.toLowerCase().includes(query) || agent.id.includes(query)).map(agent => ({ name: agent.name, description: agent.description || agent.id, hint: '开一个它的会话', value: agent.id, section: 'Agent' })) },
    onPick: (pick: { candidate: { value?: string } }) => { const agent = roster.find(row => row.id === pick.candidate.value); return agent ? claimFor(agent, `@${agent.name} `) : undefined },
    matchEnter: async (_session: unknown, line: string) => { const match = /^@(\S+)\s*([\s\S]*)$/.exec(line.trim()); if (!match) return undefined; if (!roster.length) await refresh(); const agent = roster.find(row => row.name === match[1] || row.id === match[1]); return agent ? claimFor(agent, `@${match[1]} `) : undefined },
  }
}
