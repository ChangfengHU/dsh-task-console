/**
 * Wire contract for the `taskConsole` Remote namespace — one frozen
 * descriptor list shared by the host TYPERT manifest and the client Remote
 * contribution, so the two faces cannot drift.
 *
 * Every method is string-in / string-out carrying JSON (Typert's only codec
 * mode is `strict`, and a JSON string keeps that to one `z.string()` per
 * side while the surface is still moving).
 *
 * @module dsh-agent-task-console/wire
 */

import { z } from 'zod'

// This key is part of DSH's persisted Typert remote registry. Keep it stable
// across the product rename so an installed console can still reach its host.
export const PKG = 'dsh-task-console'
export const NAMESPACE = 'taskConsole'

function jsonParam(name: string) {
  return Object.freeze({
    name,
    wire: name,
    source: 'json',
    codec: Object.freeze({ mode: 'strict', typeSymbol: `${PKG}/types#Json`, schema: z.string() }),
  })
}

const JSON_RESULT = Object.freeze({ mode: 'strict', typeSymbol: `${PKG}/types#Json`, schema: z.string() })

function descriptor(method: string, argc: 0 | 1) {
  return Object.freeze({
    id: `${PKG}#${NAMESPACE}/${method}`,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method,
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze(argc === 1 ? [jsonParam('payload')] : []),
    result: JSON_RESULT,
    sourceLocation: Object.freeze({ file: 'src/wire.ts', line: 1, column: 1 }),
  })
}

/** Every method the console calls, in the order the service defines them. */
export const METHODS = [
  ['catalog', 0], ['agents', 0], ['previewAgent', 1], ['saveAgent', 1], ['deleteAgent', 1], ['tryRun', 1],
  ['startAgentSession', 1], ['sessionTurns', 1], ['taskSessions', 0],
  ['board', 0], ['tasks', 0], ['createTask', 1], ['setTaskEnabled', 1], ['deleteTask', 1], ['deleteTasks', 1], ['fireTask', 1], ['cancelRun', 1], ['taskEvents', 1],
  ['taskSnapshot', 1], ['taskGraph', 1], ['taskArtifacts', 1], ['artifactContent', 1], ['publishArtifact', 1], ['reviewCard', 1], ['unblockCard', 1], ['agentActivity', 1],
] as const

export const CONSOLE_INVOCATIONS = Object.freeze(METHODS.map(([method, argc]) => descriptor(method, argc)))

// ── shapes both faces read ─────────────────────────────────────────────

/** One native tool the editor can put in a preset. */
export interface NativeTool {
  id: string
  label: string
  group: string
  description: string
  /** Whether the tool can change anything — drives the derived permission. */
  writes: boolean
}

/** One MCP server the host composition currently runs. */
export interface McpServer {
  entryId: string
  serverName: string
  /** URL or command line, credentials hidden. */
  target: string
  /** Tools it registered right now (public `mcp__<server>__<tool>` names, prefix stripped). */
  tools: string[]
  disabled: boolean
}

/** One skill directory the editor can copy into a preset. */
export interface SkillEntry {
  name: string
  dir: string
  description: string
  root: string
}

export interface Catalog {
  tools: NativeTool[]
  mcp: McpServer[]
  skills: SkillEntry[]
  models: string[]
  defaultModel: string
  /** Where authored presets land; null when no root accepts writes. */
  userRoot: string | null
  /** Registered workspaces, in sidebar order — where a task's sessions land. */
  workspaces: { id: string; path: string; title: string }[]
}

/** What the editor authors; persisted beside the composition as task-console.json. */
export interface AgentSpec {
  id: string
  name: string
  description: string
  persona: string
  /** `provider/model`. */
  model: string
  effort: 'low' | 'medium' | 'high' | ''
  tools: string[]
  mcp: string[]
  skills: string[]
}

/** One roster row, enriched with our spec when we authored it. */
export interface AgentRow {
  id: string
  name: string
  description: string
  trust: 'system' | 'user'
  broken?: string
  path: string
  spec: AgentSpec | null
}

export interface Preview {
  yml: string
  /** MCP servers renamed because the host still runs one with the same name. */
  renamed: { from: string; to: string }[]
  permission: 'read-only' | 'limited-write' | 'write'
}

export interface TryRunResult {
  sessionId: string
  provider: string
  model: string
  elapsedMs: number
  /** Exactly what dsh handed the model on the first request. */
  tools: string[]
  answer: string
  error?: string
}

/** One DSH session created by a task run; DSH remains the session authority. */
export interface TaskSessionRow {
  sessionId: string
  taskId: string
  taskTitle: string
  batchId: string
  cardId: string
  runId: string
  agentId: string
  role: string
  round: number
  status: string
  outcome?: string
  startedAt: string
  endedAt?: string
  archived: boolean
  internal: boolean
}

// ── tasks (types live beside the fold; type-only import keeps node out of the client) ──
export type { Artifact, Batch, BlockKind, Card, CardStatus, Event as TaskEvent, Participant, Run, RunOutcome, RunStatus, TaskSpec, Trigger, TurnLedger, TurnRow, StepRow, ToolRow } from './fold.ts'
export type { GraphEventRow, GraphFrame, GraphLinkRow, GraphRunRow, GraphSnapshot, GraphTaskRow } from './graph-data.ts'
import type { Artifact as FoldArtifact } from './fold.ts'

/** Browser-safe artifact row; the immutable host snapshot path never crosses the wire. */
export type ArtifactView = Omit<FoldArtifact, 'storagePath'>

/** One task detail read, avoiding a browser-side events → batch → artifacts waterfall. */
export interface TaskSnapshot {
  events: import('./fold.ts').Event[]
  artifacts: ArtifactView[]
  batchId: string | null
}

/** The board payload: every map as arrays, plus next cron fire per task. */
export interface BoardView {
  tasks: (TaskSpec & { nextFire: string | null })[]
  batches: Batch[]
  cards: Card[]
  runs: Run[]
}


/** Legacy 0.4 projection served by `tasks()` until the 0.5 pages land. */
export interface LegacyLeg { agentId: string; status: string; tries: number; sessionId?: string; startedAt?: string; endedAt?: string; handoff?: string; question?: string; error?: string }
export interface LegacyRun {
  id: string
  taskId: string
  firedAt: string
  by: 'cron' | 'manual' | 'retry'
  legs: LegacyLeg[]
  settled?: { at: string; outcome: 'done' | 'failed' | 'cancelled' }
  finalArtifact?: ArtifactView
  /** Most recent registered delivery, even when it is not an HTML file. */
  resultArtifact?: ArtifactView
  rounds?: number
  reworks?: number
}
