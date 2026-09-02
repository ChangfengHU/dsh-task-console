/**
 * The turn ledger: one session, turn by turn — which MCP servers and skills
 * it actually called, what the model took in and put out, how long each
 * step took. Not the context window (dsh-context owns that); the *work*.
 */

import { useEffect, useState } from 'react'
import type { StepRow, ToolRow, TurnLedger as Ledger } from '../wire.ts'

export interface LedgerApi { sessionTurns: (sessionId: string) => Promise<Ledger> }

const fmt = (iso?: string) => iso ? new Date(iso).toTimeString().slice(0, 8) : ''
const ms = (n: number) => n < 1000 ? `${n}ms` : n < 60000 ? `${(n / 1000).toFixed(1)}s` : `${Math.floor(n / 60000)}m${String(Math.round((n % 60000) / 1000)).padStart(2, '0')}s`
const tok = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
const KIND: Record<ToolRow['kind'], { label: string; cls: string }> = {
  mcp: { label: 'MCP', cls: 'dtc-p-acc' }, skill: { label: 'Skill', cls: 'dtc-p-warn' }, native: { label: '原生', cls: 'dtc-p-grey' }, ask: { label: '问人', cls: 'dtc-p-park' }, task: { label: '交卷', cls: 'dtc-p-ok' },
}

/** Fetch + poll a session's ledger; `live` keeps polling. */
export function useLedger(api: LedgerApi, sessionId: string | undefined, live: boolean): { ledger: Ledger | null; error: string } {
  const [ledger, setLedger] = useState<Ledger | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!sessionId) { setLedger(null); return }
    let stop = false
    const load = () => api.sessionTurns(sessionId).then(l => { if (!stop) { setLedger(l); setError('') } }).catch(e => { if (!stop) setError(String((e as Error).message ?? e)) })
    void load()
    const t = live ? window.setInterval(load, 4000) : undefined
    return () => { stop = true; if (t) window.clearInterval(t) }
  }, [api, sessionId, live])
  return { ledger, error }
}

export function LedgerTotals({ ledger }: { ledger: Ledger }) {
  const t = ledger.totals
  const servers = Object.entries(t.byServer).sort((a, b) => b[1] - a[1])
  return (
    <div className="dtc-totals">
      <div className="dtc-tot"><b>{t.turns}</b><span>回合</span></div>
      <div className="dtc-tot"><b>{t.steps}</b><span>步</span></div>
      <div className="dtc-tot acc"><b>{t.mcp}</b><span>MCP 调用</span></div>
      <div className="dtc-tot warn"><b>{t.skill}</b><span>Skill 加载</span></div>
      <div className="dtc-tot"><b>{t.native}</b><span>原生工具</span></div>
      <div className="dtc-tot park"><b>{t.ask}</b><span>问人</span></div>
      {t.task ? <div className="dtc-tot"><b>{t.task}</b><span>交卷</span></div> : null}
      <div className="dtc-tot"><b>{tok(t.input)}</b><span>输入 tok</span></div>
      <div className="dtc-tot"><b>{tok(t.output)}</b><span>输出 tok</span></div>
      <div className="dtc-tot"><b>{ms(t.ms)}</b><span>模型在跑</span></div>
      {servers.length ? <div className="dtc-tot wide"><span>按 MCP 服务</span><b style={{ fontSize: 12.5, fontWeight: 500 }}>{servers.map(([s, n]) => `${s} ×${n}`).join(' · ')}</b></div> : null}
      {t.skills.length ? <div className="dtc-tot wide"><span>加载过的 skill</span><b style={{ fontSize: 12.5, fontWeight: 500 }}>{t.skills.join(' · ')}</b></div> : null}
    </div>
  )
}

function Tool({ r }: { r: ToolRow }) {
  const [open, setOpen] = useState(false)
  const k = KIND[r.kind] ?? KIND.native
  return (
    <div className={`dtc-toolrow ${r.ok ? '' : 'bad'}`}>
      <div className="dtc-toolhead" onClick={() => setOpen(o => !o)}>
        <span className={`dtc-pill ${k.cls}`}>{k.label}</span>
        <span className="dtc-mono name">{r.server ? <span className="dtc-faint">{r.server} / </span> : null}{r.name}</span>
        <span className="dtc-faint args">{r.args}</span>
        <span className="sp" />
        {!r.ok ? <span className="dtc-pill dtc-p-bad">失败</span> : null}
        <span className="dtc-mono dtc-faint">{r.ms ? ms(r.ms) : '…'}</span>
        <span className="dtc-faint">{open ? '▾' : '▸'}</span>
      </div>
      {open ? <div className="dtc-toolbody"><div className="dtc-faint" style={{ fontSize: 11.5 }}>入参</div><pre>{r.args || '(无)'}</pre><div className="dtc-faint" style={{ fontSize: 11.5 }}>返回(前 400 字)</div><pre>{r.result || '(还没返回)'}</pre></div> : null}
    </div>
  )
}

function Step({ s }: { s: StepRow }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="dtc-step-row">
      <div className="dtc-step-head">
        <span className="dtc-faint">第 {s.step} 步</span>
        <span className="dtc-mono dtc-faint">{s.model ?? ''}</span>
        <span className="dtc-faint">↓{tok(s.usage.input)} ↑{tok(s.usage.output)}{s.usage.reasoning ? ` (思考 ${tok(s.usage.reasoning)})` : ''}</span>
        <span className="dtc-faint">{ms(s.ms)}</span>
        <span className="sp" />
        {s.tools.length ? <span className="dtc-faint">{s.tools.length} 次工具</span> : null}
        {s.text ? <button className="dtc-btn sm" onClick={() => setOpen(o => !o)}>{open ? '收起回复' : '看回复'}</button> : null}
      </div>
      {s.tools.map(r => <Tool key={r.callId} r={r} />)}
      {open ? <div className="dtc-hand" style={{ marginTop: 6 }}>{s.text}</div> : null}
    </div>
  )
}

export function TurnLedgerView({ ledger, compact }: { ledger: Ledger; compact?: boolean }) {
  return (
    <div className="dtc-ledger">
      <LedgerTotals ledger={ledger} />
      {ledger.turns.length === 0 ? <div className="dtc-empty">No turns in this session yet.</div> : null}
      {ledger.turns.map(t => (
        <div key={t.turn} className="dtc-turn">
          <div className="dtc-turn-head">
            <b>Turn {t.turn}</b>
            <span className="dtc-faint dtc-mono">{fmt(t.at)}{t.endedAt ? ` → ${fmt(t.endedAt)}` : ' · 进行中'}</span>
            {t.reason && t.reason !== 'completed' ? <span className="dtc-pill dtc-p-bad">{t.reason}</span> : null}
            <span className="sp" />
            <span className="dtc-faint">{t.steps.length} 步 · {t.steps.reduce((n, s) => n + s.tools.length, 0)} 次工具</span>
          </div>
          {t.user && !compact ? <div className="dtc-user">{t.user.length > 400 ? t.user.slice(0, 400) + '…' : t.user}</div> : null}
          {t.steps.map(s => <Step key={s.step} s={s} />)}
        </div>
      ))}
    </div>
  )
}

/** The `conversation.view` tab body: the current session's ledger, live. */
export function SessionLedgerTab({ api, sessionId }: { api: LedgerApi; sessionId: string }) {
  const { ledger, error } = useLedger(api, sessionId, true)
  return (
    <div className="dtc-root dtc-tab">
      {error ? <div className="dtc-err">{error}</div> : null}
      {ledger ? <TurnLedgerView ledger={ledger} /> : <div className="dtc-empty"><span className="dtc-spin" /> 折叠会话日志…</div>}
    </div>
  )
}
