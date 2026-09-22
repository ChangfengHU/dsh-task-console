/**
 * The turn ledger: one session, turn by turn — which MCP servers and skills
 * it actually called, what the model took in and put out, how long each
 * step took. Not the context window (dsh-context owns that); the *work*.
 */

import { useEffect, useState } from 'react'
import { serialPoll } from './poll.ts'
import type { ModelConnection, StepRow, ToolRow, TurnLedger as Ledger } from '../wire.ts'

export interface LedgerApi { sessionTurns: (sessionId: string, page?: number) => Promise<Ledger> }

const fmt = (iso?: string) => iso ? new Date(iso).toTimeString().slice(0, 8) : ''
const ms = (n: number) => n < 1000 ? `${n}ms` : n < 60000 ? `${(n / 1000).toFixed(1)}s` : `${Math.floor(n / 60000)}m${String(Math.round((n % 60000) / 1000)).padStart(2, '0')}s`
const tok = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
const KIND: Record<ToolRow['kind'], { label: string; cls: string }> = {
  mcp: { label: 'MCP', cls: 'dtc-p-acc' }, skill: { label: 'Skill', cls: 'dtc-p-warn' }, native: { label: '原生', cls: 'dtc-p-grey' }, ask: { label: '问人', cls: 'dtc-p-park' }, task: { label: '交卷', cls: 'dtc-p-ok' },
}

/** Fetch + poll a session's ledger; `live` keeps polling. */
export function useLedger(api: LedgerApi, sessionId: string | undefined, live: boolean) {
  const [ledger, setLedger] = useState<Ledger | null>(null)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  useEffect(() => { setPage(1) }, [sessionId])
  useEffect(() => {
    if (!sessionId) { setLedger(null); return }
    let stop = false
    setLedger(null); setError('')
    const cancel = serialPoll(async () => {
      try { const l = await api.sessionTurns(sessionId, page); if (!stop) { setLedger(l); setError('') } }
      catch (e) { if (!stop) setError(String((e as Error).message ?? e)) }
      return live
    }, 4000)
    return () => { stop = true; cancel() }
  }, [api, sessionId, live, page])
  return { ledger, error, setPage }
}

export function ConnectionStatus({ connection: c }: { connection?: ModelConnection }) {
  if (!c || c.status === 'unknown') return null
  const labels = { active: '已观察到模型输出', reconnecting: '模型连接重连中', failed: '模型连接终止失败', resumed: '重连后已观察到模型进展', ended: '模型回合已结束' }
  return <div role="status" className="dtc-audit-request">
    <span className={`dtc-pill ${c.status === 'failed' ? 'dtc-p-bad' : c.status === 'reconnecting' ? 'dtc-p-warn' : 'dtc-p-grey'}`}>{labels[c.status]}</span>
    {c.retry ? <span> · 最近重连 {c.retry.attempt}/{c.retry.limit}</span> : null}
    <small> · 最近事件 {fmt(c.lastEventAt) || '未知'} · 最近模型进展 {fmt(c.lastProgressAt) || '尚无证据'}</small>
    {c.status === 'reconnecting' ? <p>等待上游内置重连；此状态不代表正在制作，也不会自动重跑任务。</p> : null}
    {c.status === 'resumed' ? <p>仅确认模型再次产生输出或工具请求；制作完成仍需检查产物。</p> : null}
  </div>
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
      <div className="dtc-tot"><b>{ms(t.ms)}</b><span>已结束回合耗时（含等待）</span></div>
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

type AuditFilter = 'all' | 'llm' | 'skill' | 'mcp' | 'tools'

function Step({ s, filter }: { s: StepRow; filter: AuditFilter }) {
  const [open, setOpen] = useState(false)
  const tools = s.tools.filter(tool => {
    if (filter === 'all') return true
    if (filter === 'mcp') return tool.kind === 'mcp'
    if (filter === 'skill') return tool.kind === 'skill'
    if (filter === 'tools') return !['mcp', 'skill'].includes(tool.kind)
    return false
  })
  if (filter !== 'all' && filter !== 'llm' && tools.length === 0) return null
  return (
    <div className="dtc-step-row">
      <div className="dtc-step-head">
        <span className="dtc-faint">第 {s.step} 步</span>{filter === 'all' || filter === 'llm' ? <span className="dtc-pill dtc-p-acc">LLM RESPONSE</span> : null}
        <span className="dtc-mono dtc-faint">{s.model ?? ''}</span>
        <span className="dtc-faint">↓{tok(s.usage.input)} ↑{tok(s.usage.output)}{s.usage.reasoning ? ` (思考 ${tok(s.usage.reasoning)})` : ''}</span>
        <span className="dtc-faint">{ms(s.ms)}</span>
        <span className="sp" />
        {tools.length ? <span className="dtc-faint">{tools.length} 次工具</span> : null}
        {s.text && (filter === 'all' || filter === 'llm') ? <button className="dtc-btn sm" onClick={() => setOpen(o => !o)}>{open ? '收起响应' : '查看响应'}</button> : null}
      </div>
      {tools.map(r => <Tool key={r.callId} r={r} />)}
      {open && (filter === 'all' || filter === 'llm') ? <div className="dtc-hand" style={{ marginTop: 6 }}>{s.text}</div> : null}
    </div>
  )
}

export function TurnLedgerView({ ledger, compact, onPage }: { ledger: Ledger; compact?: boolean; onPage?: (page: number) => void }) {
  const [filter, setFilter] = useState<AuditFilter>('all')
  const filters: { id: AuditFilter; label: string }[] = [{ id: 'all', label: '全部' }, { id: 'llm', label: 'LLM' }, { id: 'skill', label: 'Skills' }, { id: 'mcp', label: 'MCP' }, { id: 'tools', label: 'Tools' }]
  return (
    <div className="dtc-ledger">
      <ConnectionStatus connection={ledger.connection} />
      <LedgerTotals ledger={ledger} />
      {ledger.pagination && onPage ? <nav aria-label="Trace 分页"><button className="dtc-btn sm" disabled={ledger.pagination.page <= 1} onClick={() => onPage(ledger.pagination!.page - 1)}>上一页</button><span> {ledger.pagination.page} / {ledger.pagination.pages} · 共 {ledger.pagination.total} 步 · 汇总为全会话 </span><button className="dtc-btn sm" disabled={ledger.pagination.page >= ledger.pagination.pages} onClick={() => onPage(ledger.pagination!.page + 1)}>下一页</button></nav> : null}
      <div className="dtc-audit-head"><div><b>运行审计</b><small>LLM 请求/响应、Skill、MCP 与 Tool 调用</small></div><div className="dtc-audit-filters">{filters.map(item => <button key={item.id} className={filter === item.id ? 'on' : ''} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div></div>
      {ledger.turns.length === 0 ? <div className="dtc-empty">No turns in this session yet.</div> : null}
      {ledger.turns.map(t => (
        <div key={t.turn} className="dtc-turn">
          <div className="dtc-turn-head">
            <b>Turn {t.turn}</b>
            <span className="dtc-faint dtc-mono">{fmt(t.at)}{t.endedAt ? ` → ${fmt(t.endedAt)}` : t.connection?.status === 'reconnecting' ? ' · 等待模型重连' : t.connection?.status === 'failed' ? ' · 模型失败' : ' · 进行中'}</span>
            {t.reason && t.reason !== 'completed' ? <span className="dtc-pill dtc-p-bad">{t.reason}</span> : null}
            <span className="sp" />
            <span className="dtc-faint">{t.steps.length} 步 · {t.steps.reduce((n, s) => n + s.tools.length, 0)} 次工具</span>
          </div>
          <ConnectionStatus connection={t.connection} />
          {t.user && (filter === 'all' || filter === 'llm') ? <div className="dtc-audit-request"><span className="dtc-pill dtc-p-acc">LLM REQUEST</span><p>{t.user.length > (compact ? 220 : 400) ? t.user.slice(0, compact ? 220 : 400) + '…' : t.user}</p></div> : null}
          {t.steps.map(s => <Step key={s.step} s={s} filter={filter} />)}
        </div>
      ))}
    </div>
  )
}

/** The `conversation.view` tab body: the current session's ledger, live. */
export function SessionLedgerTab({ api, sessionId }: { api: LedgerApi; sessionId: string }) {
  const { ledger, error, setPage } = useLedger(api, sessionId, true)
  return (
    <div className="dtc-root dtc-tab">
      {error ? <div className="dtc-err">{error}</div> : null}
      {ledger ? <TurnLedgerView ledger={ledger} onPage={setPage} /> : <div className="dtc-empty"><span className="dtc-spin" /> 折叠会话日志…</div>}
    </div>
  )
}
