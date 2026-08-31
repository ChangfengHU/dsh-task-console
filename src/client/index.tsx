/**
 * Browser half: one sidebar footer button that opens the console as a
 * full-page overlay; the URL hash carries which screen is open.
 *
 * @module dsh-task-console/client
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentRow, AgentSpec, Catalog, Preview, LegacyRun as Run, TaskEvent, TaskSpec, TryRunResult, TurnLedger } from '../wire.ts'
import { Console, HASH_PREFIX, go, readRoute, type Api } from './Console.tsx'
import { CONSOLE_REMOTE, unwrap } from './remote.ts'
import { installStyles } from './styles.ts'
import { SessionLedgerTab } from './TurnLedger.tsx'

export const name = 'dsh-task-console'
export const inject = ['slots', 'remote', 'sessions', 'inputTriggers']

export async function apply(ctx: any): Promise<void> {
  ctx.effect(() => installStyles(), 'task-console: stylesheet')
  await ctx.remote.$mount(CONSOLE_REMOTE)

  const call = async <T,>(method: string, payload?: unknown): Promise<T> => {
    const service = ctx.get('remote.taskConsole')
    const result = payload === undefined ? await service[method]() : await service[method](JSON.stringify(payload))
    return JSON.parse(unwrap<string>(result, method)) as T
  }
  const api: Api = {
    catalog: () => call<Catalog>('catalog'),
    agents: () => call<AgentRow[]>('agents'),
    previewAgent: (spec: AgentSpec) => call<Preview>('previewAgent', spec),
    saveAgent: (spec: AgentSpec) => call<{ path: string; preview: Preview }>('saveAgent', spec),
    deleteAgent: async (id: string) => { await call('deleteAgent', { id }) },
    tryRun: (id: string) => call<TryRunResult>('tryRun', { id }),
    tasks: () => call<{ tasks: (TaskSpec & { nextFire: string | null })[]; runs: Run[] }>('tasks'),
    createTask: (spec: Partial<TaskSpec>) => call<{ id: string }>('createTask', spec),
    setTaskEnabled: async (id: string, enabled: boolean) => { await call('setTaskEnabled', { id, enabled }) },
    deleteTask: async (id: string) => { await call('deleteTask', { id }) },
    fireTask: (id: string, by?: 'manual' | 'retry') => call<{ runId: string }>('fireTask', { id, by }),
    cancelRun: async (runId: string) => { await call('cancelRun', { runId }) },
    taskEvents: (id: string) => call<TaskEvent[]>('taskEvents', { id }),
    startAgentSession: (agentId: string, text?: string, cwd?: string) => call<{ sessionId: string; name: string }>('startAgentSession', { agentId, text, cwd }),
    openSession: (sessionId: string) => openWhenListed(ctx, sessionId),
    sessionTurns: (sessionId: string) => call<TurnLedger>('sessionTurns', { sessionId }),
  }

  // `@巡检员 …` in the composer: pick an agent, type the ask, Enter starts a
  // session on that agent's preset with the ask as its first message.
  let roster: AgentRow[] = []
  const refreshRoster = () => api.agents().then(a => { roster = a.filter(x => !x.broken) }).catch(() => undefined)
  void refreshRoster()
  const claimFor = (agent: AgentRow, prefix: string) => ({
    claim: {
      token: prefix,
      hint: `要 ${agent.name} 做什么`,
      images: false,
      submit: async (args: string, actx: any) => {
        try {
          const cwd = currentCwd(ctx, actx)
          const { sessionId } = await api.startAgentSession(agent.id, args, cwd)
          await openWhenListed(ctx, sessionId)
          return { kind: 'success' as const }
        } catch (e) { return { kind: 'error' as const, text: e instanceof Error ? e.message : String(e) } }
      },
    },
  })
  const source = {
    trigger: '@' as const,
    name: 'Agent',
    order: -10,
    warm: () => { void refreshRoster() },
    candidates: async (_session: unknown, req: { query: string }) => {
      if (!roster.length) await refreshRoster()
      const q = (req.query ?? '').toLowerCase()
      return roster.filter(a => !q || a.name.toLowerCase().includes(q) || a.id.includes(q)).map(a => ({
        name: a.name, description: a.description || a.id, hint: '开一个它的会话', value: a.id, section: 'Agent',
      }))
    },
    onPick: (pick: { candidate: { value?: string } }) => {
      const agent = roster.find(a => a.id === pick.candidate.value)
      return agent ? claimFor(agent, `@${agent.name} `) : undefined
    },
    matchEnter: async (_session: unknown, line: string) => {
      const m = /^@(\S+)\s*([\s\S]*)$/.exec(line.trim())
      if (!m) return undefined
      if (!roster.length) await refreshRoster()
      const agent = roster.find(a => a.name === m[1] || a.id === m[1])
      return agent ? claimFor(agent, `@${m[1]} `) : undefined
    },
  }
  try { ctx.effect(() => ctx.inputTriggers.registerSource(source), 'task-console: @agent trigger') } catch (e) { console.warn('[task-console] @agent trigger not registered:', e) }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'task-console',
    order: 30,
    inject: () => ({ api }),
  }, FooterEntry))

  // 「回合」beside Chat / Trajectory: this session's MCP / skill / model work, turn by turn.
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'task-console-turns',
    order: 25,
    label: () => '回合',
    inject: (sessionId: string) => ({ api, sessionId }),
  }, SessionLedgerTab))
}

/** The workspace path of the session the composer belongs to, when knowable. */
function currentCwd(ctx: any, actx: any): string | undefined {
  try {
    const id = actx?.session?.id ?? actx?.sessionId
    const snap = ctx.sessions?.list?.getSnapshot?.()
    const cwd = id && snap?.byId?.[id]?.cwd
    if (typeof cwd === 'string' && cwd) return cwd
    const cur = snap?.current && snap.byId?.[snap.current]?.cwd
    return typeof cur === 'string' && cur ? cur : undefined
  } catch { return undefined }
}

/** Open a session once the client's list mirror has learned about it (the host announces it over the socket). */
async function openWhenListed(ctx: any, sessionId: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try { ctx.sessions.open(sessionId); return } catch { /* not listed yet */ }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('会话已建好,但列表还没刷出来;在左侧找一下')
}

/** The sidebar button plus the overlay it opens (portaled to body). */
function FooterEntry({ api, wide }: { api: Api; wide?: boolean }) {
  const [open, setOpen] = useState(readRoute().length > 0 || window.location.hash.startsWith(HASH_PREFIX))
  useEffect(() => {
    const on = () => setOpen(window.location.hash.startsWith(HASH_PREFIX))
    window.addEventListener('hashchange', on)
    on()
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const narrow = wide === false
  return (
    <>
      <button type="button" className={`dtc-foot ${narrow ? 'narrow' : ''}`} title="Agent" aria-label="Agent" onClick={() => go('agents')}>
        <span className="ic">◎</span>{narrow ? null : <span>Agent</span>}
      </button>
      <button type="button" className={`dtc-foot ${narrow ? 'narrow' : ''}`} title="任务" aria-label="任务" onClick={() => go('tasks')}>
        <span className="ic">▦</span>{narrow ? null : <span>任务</span>}
      </button>
      {open ? createPortal(<Console api={api} />, document.body) : null}
    </>
  )
}
