/** Heavy client runtime, fetched only when Board, Agent, or Trace is opened. */

import type { AgentRow, AgentSpec, ArtifactView, Catalog, GraphSnapshot, Preview, LegacyRun as Run, TaskEvent, TaskSnapshot, TaskSpec, TryRunResult, TurnLedger } from '../wire.ts'
import { Console, type Api } from './Console.tsx'
import { CONSOLE_REMOTE, unwrap } from './remote.ts'
import { installStyles } from './styles.ts'
import { SessionLedgerTab } from './TurnLedger.tsx'

let activation: Promise<Api> | undefined

/** Mount the remote contract and build the shared API exactly once, on demand. */
export function activate(ctx: any): Promise<Api> {
  if (activation) return activation
  activation = (async () => {
    ctx.effect(() => installStyles(), 'task-console: stylesheet')
    await ctx.remote.$mount(CONSOLE_REMOTE)
    const call = async <T,>(method: string, payload?: unknown): Promise<T> => {
      const service = ctx.get('remote.taskConsole')
      const result = payload === undefined ? await service[method]() : await service[method](JSON.stringify(payload))
      return JSON.parse(unwrap<string>(result, method)) as T
    }
    return {
      catalog: () => call<Catalog>('catalog'), agents: () => call<AgentRow[]>('agents'),
      previewAgent: (spec: AgentSpec) => call<Preview>('previewAgent', spec), saveAgent: (spec: AgentSpec) => call<{ path: string; preview: Preview }>('saveAgent', spec),
      deleteAgent: async (id: string) => { await call('deleteAgent', { id }) }, tryRun: (id: string) => call<TryRunResult>('tryRun', { id }),
      tasks: () => call<{ tasks: (TaskSpec & { nextFire: string | null })[]; runs: Run[] }>('tasks'), createTask: (spec: Partial<TaskSpec>) => call<{ id: string }>('createTask', spec),
      setTaskEnabled: async (id: string, enabled: boolean) => { await call('setTaskEnabled', { id, enabled }) }, deleteTask: async (id: string) => { await call('deleteTask', { id }) }, deleteTasks: async (ids: string[]) => { await call('deleteTasks', { ids }) },
      fireTask: (id: string, by?: 'manual' | 'retry') => call<{ runId: string }>('fireTask', { id, by }), cancelRun: async (runId: string) => { await call('cancelRun', { runId }) },
      taskSnapshot: (id: string, batchId?: string) => call<TaskSnapshot>('taskSnapshot', { id, batchId }), taskGraph: (id: string, batchId?: string) => call<GraphSnapshot>('taskGraph', { id, batchId }), taskEvents: (id: string) => call<TaskEvent[]>('taskEvents', { id }),
      taskArtifacts: (id: string, batchId?: string) => call<ArtifactView[]>('taskArtifacts', { id, batchId }), artifactContent: (id: string, artifactId: string, batchId?: string) => call<{ artifact: ArtifactView; base64: string }>('artifactContent', { id, artifactId, batchId }), publishArtifact: (id: string, artifactId: string) => call<{ publicUrl: string }>('publishArtifact', { id, artifactId }),
      reviewCard: async (cardId: string, decision: 'approve' | 'changes', note?: string, targetCardId?: string) => { await call('reviewCard', { cardId, decision, note, targetCardId }) }, unblockCard: async (cardId: string) => { await call('unblockCard', { cardId }) },
      startAgentSession: (agentId: string, text?: string, cwd?: string) => call<{ sessionId: string; name: string }>('startAgentSession', { agentId, text, cwd }), openSession: (sessionId: string) => openWhenListed(ctx, sessionId),
      sessionTurns: (sessionId: string) => call<TurnLedger>('sessionTurns', { sessionId }), agentActivity: (agentId: string) => call<any>('agentActivity', { agentId }),
    }
  })().catch(error => { activation = undefined; throw error })
  return activation
}

async function openWhenListed(ctx: any, sessionId: string): Promise<void> {
  const url = new URL(window.location.href)
  url.searchParams.set('session', sessionId)
  const open = () => {
    ctx.sessions.open(sessionId)
    history.pushState('', document.title, `${url.pathname}${url.search}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }
  try { open(); return } catch { /* wait for the host baseline below */ }
  await ctx.sessions.refresh()
  for (let i = 0; i < 40; i++) {
    try { open(); return } catch { /* a just-created session may arrive on the next stream frame */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('会话已建好,但列表还没刷出来;在左侧找一下')
}

export { Console, SessionLedgerTab }
export type { Api }
