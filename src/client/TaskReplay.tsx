/** Run detail: result first, dependency state, selected-card evidence, and an always-visible activity stream. */

import { useEffect, useMemo, useRef, useState } from 'react'
import { cronHuman } from '../cron.ts'
import { actorOf, batchStatus, cardRun, describe, fold, type Batch, type Card, type Event, type Run, type TaskSpec } from '../fold.ts'
import type { AgentRow, ArtifactView } from '../wire.ts'
import { closeConsole, go } from './Console.tsx'
import type { TasksApi } from './TasksView.tsx'
import { TurnLedgerView, useLedger, type LedgerApi } from './TurnLedger.tsx'

const fmt = (iso?: string) => iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }) : ''
const dur = (a?: string, b?: string) => { if (!a) return ''; const s = Math.max(0, Math.round(((b ? +new Date(b) : Date.now()) - +new Date(a)) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` }
const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`
const CARD: Record<string, string> = { todo: '等上游', ready: '就绪', running: '进行中', blocked: '停车等人', done: '完成', review: '待验收', failed: '失败', cancelled: '取消' }
const RUN: Record<string, string> = { completed: '交卷', review: '提交验收', blocked: '停车', crashed: '进程没了', timed_out: '超时', failed: '失败', protocol_violation: '没按协议交卷', cancelled: '取消' }
const ACTOR = { dispatcher: { label: '系统', cls: 'dtc-p-grey' }, agent: { label: 'Agent', cls: 'dtc-p-acc' }, person: { label: '人', cls: 'dtc-p-warn' }, clock: { label: '时钟', cls: 'dtc-p-park' } } as const
const BS = { run: { label: '进行中', cls: 'dtc-p-acc' }, park: { label: '停车等人', cls: 'dtc-p-park' }, review: { label: '待验收', cls: 'dtc-p-warn' }, done: { label: '完成', cls: 'dtc-p-ok' }, bad: { label: '失败', cls: 'dtc-p-bad' } } as const
const pillOf = (st: string) => st === 'done' ? 'dtc-p-ok' : st === 'review' ? 'dtc-p-warn' : st === 'running' ? 'dtc-p-acc' : st === 'blocked' ? 'dtc-p-park' : st === 'failed' ? 'dtc-p-bad' : 'dtc-p-grey'

function belongsToBatch(e: Event, batchId: string): boolean {
  if (e.t === 'batch/fired') return e.batch.id === batchId
  if (e.t === 'batch/settled') return e.batchId === batchId
  if (e.t === 'artifact/registered') return e.artifact.batchId === batchId
  if ('cardId' in e && typeof e.cardId === 'string') return e.cardId.startsWith(`${batchId}#`)
  if ('runId' in e && typeof e.runId === 'string') return e.runId.startsWith(`${batchId}#`)
  return false
}

export function TaskReplay({ api, agents, id, runId, toast }: { api: TasksApi & LedgerApi; agents: AgentRow[]; id: string; runId?: string; toast: (m: string) => void }) {
  const [events, setEvents] = useState<Event[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactView[]>([])
  const [error, setError] = useState('')
  const [cursor, setCursor] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [selectedCard, setSelectedCard] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    let stop = false
    const load = async () => {
      try {
        const next = await api.taskEvents(id)
        if (!stop) { setEvents(next as Event[]); setError('') }
      } catch (e) { if (!stop) setError(String((e as Error).message ?? e)) }
    }
    void load(); const t = window.setInterval(load, 2500)
    return () => { stop = true; window.clearInterval(t) }
  }, [api, id])

  const upto = cursor === null ? events.length : Math.min(cursor, events.length)
  const full = useMemo(() => fold(events), [events])
  const now = useMemo(() => cursor === null ? full : fold(events.slice(0, upto)), [events, upto, cursor, full])
  const task: TaskSpec | undefined = full.tasks.get(id)
  const batches = [...full.batches.values()].filter(b => b.taskId === id).sort((a, b) => b.firedAt.localeCompare(a.firedAt))
  const selId = runId ?? batches[0]?.id
  const batchFull: Batch | undefined = selId ? full.batches.get(selId) : undefined
  const batchNow: Batch | undefined = selId ? now.batches.get(selId) : undefined

  useEffect(() => {
    let stop = false
    if (!selId) { setArtifacts([]); return }
    const load = () => api.taskArtifacts(id, selId).then(a => { if (!stop) setArtifacts(a) }).catch(e => { if (!stop) setError(String((e as Error).message ?? e)) })
    void load(); const t = window.setInterval(load, 3000)
    return () => { stop = true; window.clearInterval(t) }
  }, [api, id, selId])

  useEffect(() => {
    const cards = batchFull?.cardIds.map(cid => full.cards.get(cid)).filter(Boolean) as Card[] | undefined
    if (!cards?.length) { setSelectedCard(null); return }
    if (!selectedCard || !cards.some(c => c.id === selectedCard)) {
      const best = cards.find(c => c.status === 'running' || c.status === 'blocked' || c.status === 'review') ?? [...cards].reverse().find(c => c.runIds.length) ?? cards[0]
      setSelectedCard(best.id)
    }
  }, [batchFull?.id, events.length])

  useEffect(() => {
    if (!playing) { window.clearTimeout(timer.current); return }
    if (upto >= events.length) { setPlaying(false); setCursor(null); return }
    timer.current = window.setTimeout(() => setCursor(c => (c ?? 0) + 1), 700)
    return () => window.clearTimeout(timer.current)
  }, [playing, upto, events.length])

  const agentName = (aid: string) => agents.find(a => a.id === aid)?.name ?? aid
  if (!task) return <div className="dtc-empty">{error || (events.length ? '没有这个任务' : <><span className="dtc-spin" /> 读取事件流…</>)}</div>

  const cardsNow = batchNow ? batchNow.cardIds.map(cid => now.cards.get(cid)).filter(Boolean) as Card[] : []
  const cardsFull = batchFull ? batchFull.cardIds.map(cid => full.cards.get(cid)).filter(Boolean) as Card[] : []
  const selected = selectedCard ? full.cards.get(selectedCard) : undefined
  const bst = batchFull ? batchStatus(full, batchFull) : undefined
  const stopAt = cursor !== null ? events[upto - 1]?.at : undefined
  const total = cardsFull.length ? dur(cardsFull.find(c => c.startedAt)?.startedAt, batchFull?.settled?.at ?? [...cardsFull].reverse().find(c => c.endedAt)?.endedAt) : ''
  const batchEvents = batchFull ? events.map((e, index) => ({ e, index })).filter(x => belongsToBatch(x.e, batchFull.id)) : []
  const lastCard = [...cardsFull].reverse().find(c => c.summary)
  const lastRun = lastCard ? cardRun(full, lastCard) : undefined

  const stepTo = (n: number) => { setPlaying(false); const v = Math.max(1, Math.min(n, events.length)); setCursor(v >= events.length ? null : v) }
  const refreshArtifacts = async () => { if (selId) setArtifacts(await api.taskArtifacts(id, selId)) }

  return (
    <>
      <div className="dtc-crumb"><a onClick={() => go('tasks')}>任务</a><span>/</span><span>{task.title}</span></div>
      <div className="dtc-h1">{task.title}
        {bst ? <span className={`dtc-pill ${BS[bst].cls}`}>{BS[bst].label}</span> : null}
        {task.trigger.kind === 'cron' ? <span className="dtc-pill dtc-p-warn">{cronHuman(task.trigger.expr)}</span> : <span className="dtc-pill dtc-p-grey">单次</span>}
        <span className="dtc-acts">
          {batches.length > 1 ? <select value={selId} onChange={e => go(`tasks/${task.id}/runs/${e.target.value}`)}>{batches.map(b => <option key={b.id} value={b.id}>{b.id === batches[0].id ? '这次运行' : '之前'} · {fmt(b.firedAt)} · {BS[batchStatus(full, b)].label}</option>)}</select> : null}
          <button className="dtc-btn pri" onClick={async () => { const { runId: rid } = await api.fireTask(task.id); toast('已触发'); go(`tasks/${task.id}/runs/${rid}`) }}>▶ 再跑一次</button>
          {batchFull && (bst === 'run' || bst === 'park') ? <button className="dtc-btn danger" onClick={async () => { await api.cancelRun(batchFull.id); toast('已取消') }}>取消这次</button> : null}
          <button className="dtc-btn danger" onClick={async () => { if (!window.confirm('删除任务和它的运行记录?会话本身不删。')) return; await api.deleteTask(task.id); go('tasks') }}>删除</button>
        </span>
      </div>
      <div className="dtc-sub">{batchFull ? `${batchFull.id} · ${cardsFull.length} 个角色${total ? ` · 共 ${total}` : ''} · ${batchEvents.length} 个事件` : '还没跑过'}</div>
      {error ? <div className="dtc-err">{error}</div> : null}

      {batchFull ? <ResultPanel api={api} taskId={id} batchId={batchFull.id} status={bst} summary={lastCard?.summary} metadata={lastRun?.metadata} artifacts={artifacts} toast={toast} refresh={refreshArtifacts} /> : null}

      <div className="dtc-runlayout">
        <main>
          <div className="dtc-panel">
            <h3>角色与依赖 <span className="dtc-faint">点击节点查看证据{stopAt ? ` · 正在回放 ${fmt(stopAt)}` : ''}</span></h3>
            {cardsNow.length ? <div className="dtc-chain">
              {cardsNow.map((c, i) => {
                const r = cardRun(now, c); const up = i ? cardsNow[i - 1] : undefined; const open = up?.status === 'done'
                return <span key={c.id} style={{ display: 'contents' }}>
                  {up ? <div className={`dtc-link ${open ? 'open' : ''}`}><span className="lbl">{open ? '已放行' : '等待'}</span><div className="bar" /></div> : null}
                  <button className={`dtc-node s-${c.status} ${selectedCard === c.id ? 'selected' : ''}`} onClick={() => setSelectedCard(c.id)}>
                    <div className="role"><div className="av">{agentName(c.agentId)[0]}</div><div><div className="nm">{agentName(c.agentId)}</div><div className="dtc-faint">角色 {c.index + 1}</div></div></div>
                    <div className="st">{c.status === 'running' ? <span className="dtc-live" /> : null}{CARD[c.status]}{c.runIds.length > 1 ? ` · 尝试 ${c.runIds.length}` : ''}</div>
                    <div className="dur">{c.startedAt ? dur(c.startedAt, c.endedAt ?? stopAt) : '—'}<small>{r?.sessionCreatedAt ? '会话已建' : r ? '已领取' : '未开始'}</small></div>
                    {r?.status === 'blocked' ? <div className="q">? {r.question}</div> : null}
                  </button>
                </span>
              })}
            </div> : <div className="dtc-empty">这个时刻还没有运行。</div>}
          </div>

          {selected ? <CardEvidence api={api} taskId={id} batchId={batchFull?.id} card={selected} runs={selected.runIds.map(rid => full.runs.get(rid)).filter(Boolean) as Run[]} artifacts={artifacts.filter(a => a.cardId === selected.id)} agentName={agentName(selected.agentId)} toast={toast} refreshArtifacts={refreshArtifacts} /> : null}
        </main>

        <aside>
          <div className="dtc-panel dtc-activity">
            <h3>活动 <span className="dtc-faint">{batchEvents.length} 个可回放事件</span></h3>
            <div className="dtc-activity-list">{[...batchEvents].reverse().map(({ e, index }) => { const a = ACTOR[actorOf(e)]; return (
              <button key={index} className={`dtc-activity-row ${index >= upto ? 'off' : ''} ${index === upto - 1 ? 'cur' : ''}`} onClick={() => stepTo(index + 1)}>
                <span className="dot" /><span className="copy"><b>{describe(e, full, agentName)}</b><small>{fmt(e.at)} · {e.t}</small></span><span className={`dtc-pill ${a.cls}`}>{a.label}</span>
              </button>) })}</div>
            <div className="dtc-replayctl">
              <button className="dtc-btn sm" onClick={() => stepTo(Math.max(1, upto - 1))} disabled={upto <= 1}>←</button>
              <button className={`dtc-btn sm ${playing ? 'pri' : ''}`} onClick={() => { if (upto >= events.length) setCursor(Math.max(1, batchEvents[0]?.index ?? 0)); setPlaying(p => !p) }}>{playing ? '暂停' : '播放'}</button>
              <button className="dtc-btn sm" onClick={() => stepTo(upto + 1)} disabled={upto >= events.length}>→</button>
              <button className="dtc-btn sm" onClick={() => { setPlaying(false); setCursor(null) }} disabled={cursor === null}>现在</button>
              <span className="dtc-faint">{upto}/{events.length}</span>
            </div>
          </div>
          <details className="dtc-panel dtc-details"><summary>任务书与运行边界</summary><div className="dtc-hand">{task.brief}</div><div className="dtc-kv">
            <span className="k">工作区</span><span className="dtc-mono">{task.cwd}</span>
            <span className="k">超时</span><span>{Math.round(task.timeoutSec / 60)} 分钟 / 角色</span>
            <span className="k">失败后</span><span>{task.onFail === 'retry' ? `自动重试,最多 ${task.maxTries} 次` : '停下'}</span>
          </div></details>
        </aside>
      </div>
    </>
  )
}

function ResultPanel({ api, taskId, batchId, status, summary, metadata, artifacts, toast, refresh }: { api: TasksApi; taskId: string; batchId: string; status?: keyof typeof BS; summary?: string; metadata?: Record<string, unknown>; artifacts: ArtifactView[]; toast: (m: string) => void; refresh: () => Promise<void> }) {
  return <section className="dtc-result">
    <div className="dtc-result-head"><div><span className="eyebrow">RUN RESULT</span><h2>{status === 'done' ? '任务已完成' : status === 'bad' ? '任务未完成' : status === 'park' ? '正在等待输入' : status === 'review' ? '正在等待人工验收' : '任务正在运行'}</h2></div>{status ? <span className={`dtc-pill ${BS[status].cls}`}>{BS[status].label}</span> : null}</div>
    <div className="dtc-result-grid"><div><h3>最终交接</h3><div className="dtc-result-copy">{summary || <span className="dtc-faint">最后一个角色交卷后，结果会显示在这里。</span>}</div>{metadata ? <pre className="dtc-meta">{JSON.stringify(metadata, null, 2)}</pre> : null}</div>
      <div><h3>交付产物 <span className="dtc-faint">{artifacts.length}</span></h3><ArtifactList api={api} taskId={taskId} batchId={batchId} artifacts={artifacts} toast={toast} refresh={refresh} empty="还没有登记产物。新任务会把 task_complete 的 artifacts 保存成可访问副本。" /></div>
    </div>
  </section>
}

function CardEvidence({ api, taskId, batchId, card, runs, artifacts, agentName, toast, refreshArtifacts }: { api: TasksApi & LedgerApi; taskId: string; batchId?: string; card: Card; runs: Run[]; artifacts: ArtifactView[]; agentName: string; toast: (m: string) => void; refreshArtifacts: () => Promise<void> }) {
  const latest = runs[runs.length - 1]
  const [runId, setRunId] = useState<string | undefined>(latest?.id)
  const [tab, setTab] = useState<'handoff' | 'ledger' | 'artifacts'>('handoff')
  const [reviewNote, setReviewNote] = useState('')
  const [busy, setBusy] = useState(false)
  const run = runs.find(r => r.id === runId) ?? latest
  const { ledger, error } = useLedger(api, tab === 'ledger' ? run?.sessionId : undefined, run?.status === 'running' || run?.status === 'blocked')
  const decide = async (decision: 'approve' | 'changes') => {
    setBusy(true)
    try { await api.reviewCard(card.id, decision, reviewNote); toast(decision === 'approve' ? '已验收通过' : '已退回修改'); setReviewNote('') }
    catch (e) { toast(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }
  return <div className="dtc-panel dtc-evidence">
    <div className="dtc-evidence-head"><div><span className="eyebrow">SELECTED ROLE</span><h2>{agentName}</h2></div><span className={`dtc-pill ${pillOf(card.status)}`}>{CARD[card.status]}</span><span className="sp" />
      {run?.sessionId ? <button className="dtc-btn sm" onClick={() => { closeConsole(); void api.openSession(run.sessionId) }}>打开会话</button> : null}
    </div>
    {runs.length > 1 ? <div className="dtc-chips">{runs.map(r => <button key={r.id} className={`dtc-chip ${r.id === run?.id ? 'on' : ''}`} onClick={() => setRunId(r.id)}>尝试 {r.attempt} · {RUN[r.outcome ?? r.status] ?? r.status}</button>)}</div> : null}
    <div className="dtc-tabs"><button className={tab === 'handoff' ? 'on' : ''} onClick={() => setTab('handoff')}>交接与状态</button><button className={tab === 'ledger' ? 'on' : ''} onClick={() => setTab('ledger')}>会话与工具</button><button className={tab === 'artifacts' ? 'on' : ''} onClick={() => setTab('artifacts')}>产物 {artifacts.length}</button></div>
    {tab === 'handoff' ? <div className="dtc-tabbody">
      {run?.summary ? <div className="dtc-hand">{run.summary}</div> : <div className="dtc-empty">还没有交接单。</div>}
      <div className="dtc-kv dtc-runfacts"><span className="k">领取</span><span>{fmt(run?.startedAt) || '—'}</span><span className="k">会话创建</span><span>{fmt(run?.sessionCreatedAt) || '旧记录未拆分'}</span><span className="k">提示词发送</span><span>{fmt(run?.promptDispatchedAt) || '旧记录未拆分'}</span><span className="k">Session</span><span className="dtc-mono">{run?.sessionId || '—'}</span></div>
      {run?.error ? <div className="dtc-err">{run.error}</div> : null}
      {run?.status === 'blocked' ? <div className="dtc-ask"><b>? {run.question}</b><div className="dtc-note">在这个会话里回答后会自动继续。</div></div> : null}
      {card.status === 'review' ? <div className="dtc-review"><h3>人工验收门禁</h3><p>通过前不会启动下游，也不会把整批任务标成完成。</p><textarea value={reviewNote} onChange={e => setReviewNote(e.target.value)} placeholder="验收意见；退回修改时必填" /><div className="dtc-chips"><button className="dtc-btn pri" disabled={busy} onClick={() => decide('approve')}>通过并放行</button><button className="dtc-btn danger" disabled={busy || !reviewNote.trim()} onClick={() => decide('changes')}>退回修改</button></div></div> : null}
    </div> : null}
    {tab === 'ledger' ? <div className="dtc-tabbody">{error ? <div className="dtc-err">{error}</div> : ledger ? <TurnLedgerView ledger={ledger} compact /> : run?.sessionId ? <div className="dtc-empty"><span className="dtc-spin" /> 折叠会话日志…</div> : <div className="dtc-empty">没有会话。</div>}</div> : null}
    {tab === 'artifacts' ? <div className="dtc-tabbody"><ArtifactList api={api} taskId={taskId} batchId={batchId} artifacts={artifacts} toast={toast} refresh={refreshArtifacts} empty="这个角色没有登记产物。" /></div> : null}
  </div>
}

function ArtifactList({ api, taskId, batchId, artifacts, toast, refresh, empty }: { api: TasksApi; taskId: string; batchId?: string; artifacts: ArtifactView[]; toast: (m: string) => void; refresh: () => Promise<void>; empty: string }) {
  const [busy, setBusy] = useState('')
  const blobFor = async (a: ArtifactView) => {
    const { base64 } = await api.artifactContent(taskId, a.id, batchId)
    const raw = atob(base64); const data = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i)
    return URL.createObjectURL(new Blob([data], { type: a.mime }))
  }
  const preview = async (a: ArtifactView) => {
    const tab = window.open('', '_blank')
    setBusy(a.id)
    try { const url = await blobFor(a); if (tab) tab.location.href = url; else window.open(url, '_blank', 'noopener') }
    catch (e) { tab?.close(); toast(String((e as Error).message ?? e)) } finally { setBusy('') }
  }
  const download = async (a: ArtifactView) => {
    setBusy(a.id)
    try { const url = await blobFor(a); const link = document.createElement('a'); link.href = url; link.download = a.name; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 30_000) }
    catch (e) { toast(String((e as Error).message ?? e)) } finally { setBusy('') }
  }
  const publish = async (a: ArtifactView) => {
    if (!window.confirm(`把 ${a.name} 发布为任何人都可访问的公网链接?`)) return
    setBusy(a.id)
    try { const { publicUrl } = await api.publishArtifact(taskId, a.id); await refresh(); await navigator.clipboard?.writeText(publicUrl); toast('已发布，公网链接已复制') }
    catch (e) { toast(String((e as Error).message ?? e)) } finally { setBusy('') }
  }
  if (!artifacts.length) return <div className="dtc-empty dtc-art-empty">{empty}</div>
  return <div className="dtc-artifacts">{artifacts.map(a => <div className="dtc-artifact" key={a.id}>
    <div className="file">{a.mime.startsWith('image/') ? '▧' : a.mime === 'text/html' ? '◇' : '▤'}</div><div className="info"><b>{a.name}</b><span>{bytes(a.size)} · SHA256 {a.sha256.slice(0, 10)}…</span><span className="dtc-mono" title={a.originalPath}>{a.originalPath}</span></div>
    <div className="badges">{a.legacy ? <span className="dtc-pill dtc-p-warn">历史路径</span> : <span className="dtc-pill dtc-p-ok">已保存副本</span>}{a.publicUrl ? <a href={a.publicUrl} target="_blank" rel="noreferrer">公网链接 ↗</a> : null}</div>
    <div className="actions"><button className="dtc-btn sm" disabled={busy === a.id} onClick={() => preview(a)}>预览</button><button className="dtc-btn sm" disabled={busy === a.id} onClick={() => download(a)}>下载</button>{!a.legacy && (a.mime === 'text/html' || /\.html?$/i.test(a.name)) && !a.publicUrl ? <button className="dtc-btn sm pri" disabled={busy === a.id} onClick={() => publish(a)}>发布公网</button> : null}</div>
  </div>)}</div>
}
