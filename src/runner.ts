/**
 * The dispatcher: the host-resident part that turns a fired run into legs.
 *
 * Deterministic on purpose. No model decides who goes next — the host
 * starts leg N+1 when leg N's turn ends, hands it the brief plus leg N's
 * last assistant text, and writes every transition to the event stream.
 * Each leg is a ROOT session on its own preset (never a subagent: a child
 * joins its parent's composition, which would undo the per-agent fence).
 *
 * @module dsh-task-console/runner
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { readSpec } from './presets.ts'
import { EventStore, cronMatches, legMessage, parseCron, type Run, type TaskSpec } from './tasks.ts'

interface Flight {
  runId: string
  leg: number
  sessionId: string
  messageId: string
  consumed: boolean
  handle: any
  lastText: string
  pendingAsk?: string
  timer?: ReturnType<typeof setTimeout>
}

export class TaskRunner {
  private flights = new Map<string, Flight>()
  private ticker?: ReturnType<typeof setInterval>
  private firedMinute = new Map<string, string>()
  private disposeListener?: () => void

  private readonly ctx: Context
  readonly store: EventStore

  constructor(ctx: Context, store: EventStore) { this.ctx = ctx; this.store = store }

  async start(): Promise<void> {
    await this.store.load()
    // Anything still "running" in the fold belonged to a previous process.
    for (const run of this.store.runs.values()) {
      for (const [i, leg] of run.legs.entries()) {
        if (leg.status === 'running' || leg.status === 'blocked') await this.store.append({ t: 'leg/lost', at: now(), runId: run.id, leg: i, error: '宿主重启,进程不在了' })
      }
      if (!run.settled && run.legs.some(l => l.status === 'lost')) await this.store.append({ t: 'run/settled', at: now(), runId: run.id, outcome: 'failed' })
    }
    this.disposeListener = (this.ctx as any).on('session/event', (session: any, event: any) => this.onSessionEvent(session, event))
    this.ticker = setInterval(() => { void this.tick() }, 60_000)
    ;(this.ctx as any).effect?.(() => () => this.stop(), 'task-console: runner')
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.disposeListener?.()
    for (const f of this.flights.values()) if (f.timer) clearTimeout(f.timer)
  }

  /** Cron: fire every enabled cron task whose expression matches this minute, once per minute. */
  private async tick(): Promise<void> {
    const d = new Date(); const key = d.toISOString().slice(0, 16)
    for (const task of this.store.tasks.values()) {
      if (task.trigger.kind !== 'cron' || !task.enabled) continue
      const c = parseCron(task.trigger.expr); if (!c || !cronMatches(c, d)) continue
      if (this.firedMinute.get(task.id) === key) continue
      this.firedMinute.set(task.id, key)
      await this.fire(task.id, 'cron').catch(err => console.warn('[task-console] cron fire failed:', err))
    }
  }

  /** Create a run and start its first leg. Preflight failures settle the run without spending a model call. */
  async fire(taskId: string, by: Run['by']): Promise<Run> {
    const task = this.store.tasks.get(taskId)
    if (!task) throw new Error('没有这个任务')
    const runId = `r-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    await this.store.append({ t: 'run/fired', at: now(), run: { id: runId, taskId, by, legs: task.participants.map(p => p.agentId) } })
    const problem = await this.preflight(task)
    if (problem) {
      await this.store.append({ t: 'leg/failed', at: now(), runId, leg: 0, error: `预检不过:${problem}` })
      await this.store.append({ t: 'run/settled', at: now(), runId, outcome: 'failed' })
    } else {
      await this.startLeg(runId, 0, 1)
    }
    return this.store.runs.get(runId)!
  }

  private async preflight(task: TaskSpec): Promise<string | null> {
    const presets = (this.ctx as any).get('agentPresets')
    if (!presets) return '这个部署没有 preset 服务'
    for (const p of task.participants) {
      try { const r = await presets.resolve(p.agentId); if (r.broken) return `preset ${p.agentId} 坏了:${r.broken}` } catch { return `preset ${p.agentId} 不在名册上` }
    }
    try { const { stat } = await import('node:fs/promises'); if (!(await stat(task.cwd)).isDirectory()) return `工作目录不存在:${task.cwd}` } catch { return `工作目录不存在:${task.cwd}` }
    return null
  }

  private async startLeg(runId: string, leg: number, tries: number): Promise<void> {
    const run = this.store.runs.get(runId); const task = run && this.store.tasks.get(run.taskId)
    if (!run || !task) return
    const participant = task.participants[leg]
    const presets = (this.ctx as any).get('agentPresets')
    const preset = await presets.resolve(participant.agentId)
    const spec = await readSpec(dirname(String(preset.path)))
    const agentName = spec?.name ?? preset.name ?? preset.id

    let selection: any = (() => { try { return (this.ctx as any).get('agentDefaultModel')?.currentSelection?.() } catch { return undefined } })()
    if (spec?.model?.includes('/')) { const [provider, ...rest] = spec.model.split('/'); selection = { provider, model: rest.join('/'), ...(spec.effort ? { reasoningEffort: spec.effort } : {}) } }

    const sessionId = `task-${run.taskId}-${runId}-${leg + 1}${tries > 1 ? `-t${tries}` : ''}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    const upstream = leg > 0 ? { agentName: await this.agentName(task.participants[leg - 1].agentId), handoff: run.legs[leg - 1].handoff ?? '' } : undefined
    const text = legMessage(task, run, leg, upstream)
    const messageId = randomUUID()
    const flight: Flight = { runId, leg, sessionId, messageId, consumed: false, handle: undefined, lastText: '' }
    this.flights.set(sessionId, flight)
    try {
      flight.handle = await (this.ctx as any).agents.create({
        sessionId,
        ...(selection ? { agentOptions: selection } : {}),
        meta: { cwd: task.cwd, agentPreset: preset.id },
        setup: async (agentCtx: object) => { await presets.mount(agentCtx, preset.id) },
      })
      await this.store.append({ t: 'leg/spawned', at: now(), runId, leg, sessionId, tries })
      try { (this.ctx as any).get('sessionTitle')?.rename?.(flight.handle.agent.session, `task: ${task.title} · ${runId} · ${agentName}`) } catch { /* title is cosmetic */ }
      flight.handle.agent.followup({ id: messageId, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
      flight.timer = setTimeout(() => { void this.finish(flight, 'timed_out', `${task.timeoutSec} 秒没交卷`) }, task.timeoutSec * 1000)
    } catch (error) {
      this.flights.delete(sessionId)
      await this.store.append({ t: 'leg/failed', at: now(), runId, leg, error: error instanceof Error ? error.message : String(error) })
      await this.store.append({ t: 'run/settled', at: now(), runId, outcome: 'failed' })
    }
  }

  private async agentName(id: string): Promise<string> {
    try { const presets = (this.ctx as any).get('agentPresets'); const p = await presets.resolve(id); const s = await readSpec(dirname(String(p.path))); return s?.name ?? p.name ?? id } catch { return id }
  }

  private onSessionEvent(session: any, event: any): void {
    const f = this.flights.get(session?.id); if (!f) return
    switch (event.type) {
      case 'user/message':
        if (event.data?.id === f.messageId) f.consumed = true
        break
      case 'tool/call':
        if (String(event.data?.name ?? '').endsWith('ask_user_question')) {
          let q = ''
          try { const a = JSON.parse(event.data.arguments ?? '{}'); q = a.questions?.[0]?.question ?? a.question ?? JSON.stringify(a).slice(0, 200) } catch { q = String(event.data.arguments ?? '').slice(0, 200) }
          f.pendingAsk = event.data.callId
          void this.store.append({ t: 'leg/blocked', at: now(), runId: f.runId, leg: f.leg, question: q })
        }
        break
      case 'tool/result':
        if (f.pendingAsk && event.data?.message?.source?.callId === f.pendingAsk) {
          f.pendingAsk = undefined
          void this.store.append({ t: 'leg/resumed', at: now(), runId: f.runId, leg: f.leg })
        }
        break
      case 'assistant/message': {
        const blocks = event.data?.message?.content
        if (Array.isArray(blocks)) { const t = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim(); if (t) f.lastText = t }
        break
      }
      case 'turn/end':
        if (!f.consumed) break
        if (event.data?.reason && event.data.reason.kind !== 'completed') void this.finish(f, 'failed', JSON.stringify(event.data.reason))
        else void this.finish(f, 'done')
        break
    }
  }

  private async finish(f: Flight, outcome: 'done' | 'failed' | 'timed_out' | 'cancelled', error?: string): Promise<void> {
    if (!this.flights.has(f.sessionId)) return
    this.flights.delete(f.sessionId)
    if (f.timer) clearTimeout(f.timer)
    try { await f.handle?.dispose?.() } catch { /* already gone */ }
    const run = this.store.runs.get(f.runId); const task = run && this.store.tasks.get(run.taskId)
    if (!run || !task) return
    if (outcome === 'done') {
      await this.store.append({ t: 'leg/done', at: now(), runId: f.runId, leg: f.leg, handoff: f.lastText })
      if (f.leg + 1 < task.participants.length) await this.startLeg(f.runId, f.leg + 1, 1)
      else await this.store.append({ t: 'run/settled', at: now(), runId: f.runId, outcome: 'done' })
      return
    }
    await this.store.append({ t: `leg/${outcome}` as 'leg/failed', at: now(), runId: f.runId, leg: f.leg, error })
    const tries = run.legs[f.leg].tries
    if (outcome !== 'cancelled' && task.onFail === 'retry' && tries < task.maxTries) { await this.startLeg(f.runId, f.leg, tries + 1); return }
    await this.store.append({ t: 'run/settled', at: now(), runId: f.runId, outcome: outcome === 'cancelled' ? 'cancelled' : 'failed' })
  }

  async cancel(runId: string): Promise<void> {
    for (const f of [...this.flights.values()]) if (f.runId === runId) await this.finish(f, 'cancelled', '人工取消')
    const run = this.store.runs.get(runId)
    if (run && !run.settled) await this.store.append({ t: 'run/settled', at: now(), runId, outcome: 'cancelled' })
  }
}

function now(): string { return new Date().toISOString() }
