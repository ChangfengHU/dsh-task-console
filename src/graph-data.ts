/** Browser-safe, DB-shaped graph rows. No inferred roles or links live here. */

export interface GraphTaskRow {
  id: string
  title: string
  body: string | null
  assignee: string | null
  status: string
  created_at: number
  started_at: number | null
  completed_at: number | null
  result: string | null
  node_kind: 'agent' | 'gate'
  round: number | null
  role: 'planner' | 'executor' | 'reviewer' | 'gate' | null
  current_run_id: number | null
}

export interface GraphLinkRow {
  parent_id: string
  child_id: string
  kind: string
  created_at: number | null
}

export interface GraphRunRow {
  id: number
  external_run_id: string | null
  task_id: string
  profile: string | null
  status: string
  started_at: number
  ended_at: number | null
  outcome: string | null
  summary: string | null
  error: string | null
  session_id: string | null
}

export interface GraphEventRow {
  id: number
  graph_id: string
  task_id: string
  run_id: number | null
  kind: string
  payload: Record<string, unknown>
  created_at: number
}

export interface GraphFrame {
  tasks: GraphTaskRow[]
  links: GraphLinkRow[]
  runs: GraphRunRow[]
}

export interface GraphSnapshot {
  graphId: string
  taskId: string
  batch: { id: string; firedAt: number; settledAt: number | null; outcome: string | null }
  live: GraphFrame
  events: GraphEventRow[]
}

const blankTask = (e: GraphEventRow): GraphTaskRow => {
  const p = e.payload
  return {
    id: e.task_id,
    title: String(p.title ?? e.task_id),
    body: typeof p.body === 'string' ? p.body : null,
    assignee: typeof p.assignee === 'string' ? p.assignee : null,
    status: String(p.status ?? 'todo'),
    created_at: Number(p.created_at ?? e.created_at),
    started_at: null,
    completed_at: null,
    result: null,
    node_kind: p.node_kind === 'gate' ? 'gate' : 'agent',
    round: typeof p.round === 'number' ? p.round : null,
    role: ['planner', 'executor', 'reviewer', 'gate'].includes(String(p.role)) ? p.role as GraphTaskRow['role'] : null,
    current_run_id: null,
  }
}

/** Reconstruct one historical frame from canonical task_events only. */
export function replayGraph(events: GraphEventRow[], count = events.length): GraphFrame {
  const tasks = new Map<string, GraphTaskRow>()
  const links = new Map<string, GraphLinkRow>()
  const runs = new Map<number, GraphRunRow>()
  for (const e of events.slice(0, count)) {
    const p = e.payload
    if (e.kind === 'created') {
      tasks.set(e.task_id, blankTask(e))
      continue
    }
    const task = tasks.get(e.task_id)
    if (e.kind === 'linked') {
      const parent = String(p.parent_id ?? '')
      if (parent) links.set(`${parent}>${e.task_id}`, { parent_id: parent, child_id: e.task_id, kind: String(p.kind ?? 'dependency'), created_at: e.created_at })
    } else if (e.kind === 'promoted' && task) task.status = 'ready'
    else if (e.kind === 'claimed' && task && e.run_id !== null) {
      task.status = 'running'; task.started_at ??= e.created_at; task.current_run_id = e.run_id
      runs.set(e.run_id, { id: e.run_id, external_run_id: typeof p.external_run_id === 'string' ? p.external_run_id : null, task_id: e.task_id, profile: task.assignee, status: 'running', started_at: e.created_at, ended_at: null, outcome: null, summary: null, error: null, session_id: typeof p.session_id === 'string' ? p.session_id : null })
    } else if ((e.kind === 'run_bound' || e.kind === 'session_created') && e.run_id !== null) {
      const run = runs.get(e.run_id)
      if (run) { if (typeof p.external_run_id === 'string') run.external_run_id = p.external_run_id; if (typeof p.session_id === 'string') run.session_id = p.session_id }
    } else if ((e.kind === 'completed' || e.kind === 'gate_opened') && task) {
      task.status = 'done'; task.completed_at = e.created_at; task.current_run_id = null
      if (e.run_id !== null) { const run = runs.get(e.run_id); if (run) { run.status = 'done'; run.outcome = 'completed'; run.summary = typeof p.summary === 'string' ? p.summary : null; run.ended_at = e.created_at } }
    } else if (e.kind === 'blocked' && task) {
      task.status = String(p.status ?? 'blocked'); task.current_run_id = null
      if (e.run_id !== null) { const run = runs.get(e.run_id); if (run) { run.status = 'blocked'; run.outcome = 'blocked'; run.error = String(p.reason ?? ''); run.ended_at = e.created_at } }
    } else if (['failed', 'crashed', 'timed_out', 'cancelled', 'protocol_violation', 'reclaimed'].includes(e.kind) && task) {
      task.status = e.kind === 'cancelled' ? 'archived' : String(p.retry_status ?? 'ready'); task.current_run_id = null
      if (e.run_id !== null) { const run = runs.get(e.run_id); if (run) { run.status = 'failed'; run.outcome = String(p.outcome ?? 'failed'); run.error = String(p.error ?? ''); run.ended_at = e.created_at } }
    } else if (e.kind === 'gave_up' && task) task.status = 'triage'
    else if (e.kind === 'unblocked' && task) task.status = String(p.status ?? 'ready')
    else if (e.kind === 'review_requested' && task) { task.status = 'review'; task.current_run_id = null }
  }
  return { tasks: [...tasks.values()], links: [...links.values()], runs: [...runs.values()] }
}

export function graphEventLabel(e: GraphEventRow): string {
  const role = String(e.payload.role ?? e.task_id)
  switch (e.kind) {
    case 'created': return `INSERT tasks · ${role}`
    case 'linked': return `INSERT task_links · ${String(e.payload.parent_id ?? '?')} → ${e.task_id}`
    case 'claimed': return `INSERT task_runs · ${role} 开始运行`
    case 'promoted': return `UPDATE tasks · ${role} 进入 ready`
    case 'gate_opened': return `UPDATE tasks · Gate 放行`
    case 'completed': return `UPDATE tasks/task_runs · ${role} 完成`
    case 'blocked': return `UPDATE tasks/task_runs · ${role} 阻塞`
    default: return `${e.kind} · ${role}`
  }
}
