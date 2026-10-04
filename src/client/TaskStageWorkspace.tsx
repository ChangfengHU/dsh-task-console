import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TasksApi } from './TasksView.tsx'
import { go } from './Console.tsx'

export interface StageFile { path: string; sha256: string; bytes: number; media?: { kind?: string; durationSeconds?: number; width?: number; height?: number } }
export interface StudioReceipt { stage: string; round: number; cardId: string; sessionId: string; summary: string; qualityApproved: false; outputs: StageFile[] }
export interface StudioCardRun { id: string; status: string; sessionId: string | null; startedAt: string | null; endedAt: string | null; question: string | null; error: string | null; terminalBlock: boolean; blockKind: string | null; summary: string | null }
export interface StudioCard { id: string; role: string | null; round: number | null; title: string; status: string; error: string | null; deps: string[]; currentRunId: string | null; wakeAt?: string | null; runs: StudioCardRun[] }
export interface StudioTaskWorkspace { task: { id: string; title: string }; batch: { id: string; firedAt: string; outcome: string | null; archivedAt: string | null }; stages: { id: string; agentId: string }[]; cards: StudioCard[]; receipts: StudioReceipt[] }

const stageNames: Record<string, string> = { storyboard: '剧本与分镜', visual: '人物与场景素材', sound: '配音、配乐与音效' }
const statusNames: Record<string, string> = { todo: '等待上游', ready: '等待执行', running: '执行中', blocked: '已暂停', triage: '需要处理', failed: '失败', done: '已交接', archived: '已归档', cancelled: '已取消' }
const formatSize = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
const stageKey = (stage: string, round: number) => `${round}:${stage}`

function StagePreview({ api, taskId, batchId, stage, round, file }: { api: TasksApi; taskId: string; batchId: string; stage: string; round: number; file: StageFile }) {
  const [source, setSource] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  useEffect(() => () => { if (source.startsWith('blob:')) URL.revokeObjectURL(source) }, [source])
  const open = async () => {
    setLoading(true); setError('')
    try {
      const result = await api.studioStageArtifactContent({ taskId, batchId, stage, round, path: file.path, sha256: file.sha256 })
      const binary = atob(result.base64), bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const url = URL.createObjectURL(new Blob([bytes], { type: result.file.mime }))
      setSource(old => { if (old.startsWith('blob:')) URL.revokeObjectURL(old); return url })
    } catch (e) { setError(String((e as Error).message ?? e)) }
    finally { setLoading(false) }
  }
  const image = /\.(png|jpe?g|webp)$/i.test(file.path), audio = /\.(wav|mp3|m4a)$/i.test(file.path), text = /\.(json|txt|md)$/i.test(file.path)
  return <article className="dtc-stage-file">
    <div className="dtc-stage-file-head"><div><b>{file.path.split('/').at(-1)}</b><small>{formatSize(file.bytes)} · {file.media?.kind ?? (image ? '图片' : audio ? '音频' : text ? '文档' : '文件')}{file.media?.durationSeconds ? ` · ${file.media.durationSeconds.toFixed(1)} 秒` : ''}</small></div><button className="dtc-btn sm" disabled={loading || file.bytes > 8 * 1024 * 1024 || (!image && !audio && !text)} onClick={() => void open()}>{loading ? '读取中…' : source ? '重新读取' : file.bytes > 8 * 1024 * 1024 ? '超过预览上限' : '预览'}</button></div>
    <code title={file.sha256}>SHA-256 {file.sha256}</code>
    {error ? <p className="dtc-err">{error}</p> : null}
    {source && image ? <img className="dtc-stage-image" src={source} alt={file.path} /> : null}
    {source && audio ? <audio controls preload="metadata" src={source} /> : null}
    {source && text ? <StageText source={source} /> : null}
  </article>
}

function StageText({ source }: { source: string }) {
  const [text, setText] = useState('读取中…')
  useEffect(() => { let live = true; fetch(source).then(r => r.text()).then(v => { if (live) { try { setText(JSON.stringify(JSON.parse(v), null, 2)) } catch { setText(v) } } }).catch(e => { if (live) setText(String(e)) }); return () => { live = false } }, [source])
  return <pre className="dtc-stage-text">{text}</pre>
}

function RecoveryActions({ api, data, card, toast, refresh }: { api: TasksApi; data: StudioTaskWorkspace; card: StudioCard; toast: (text: string) => void; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [confirmMode, setConfirmMode] = useState<'unblock' | 'recover' | 'storyboard' | 'visual' | 'sound' | null>(null)
  const [reason, setReason] = useState('')
  const latest = card.runs.at(-1), archived = Boolean(data.batch.archivedAt)
  const prepReceipts = data.receipts.filter(receipt => receipt.round === card.round && ['storyboard', 'visual', 'sound'].includes(receipt.stage) && data.cards.some(stageCard => stageCard.id === receipt.cardId && stageCard.status === 'done'))
  const begin = (mode: NonNullable<typeof confirmMode>) => { setReason(mode === 'unblock' ? '操作人确认解除终止阻塞' : mode === 'recover' ? '在阶段工作台请求恢复失败节点' : `在阶段工作台从 ${mode} 重新验证`); setConfirmMode(mode) }
  const recover = async (revalidateFrom?: 'storyboard' | 'visual' | 'sound') => {
    if (!latest || archived || busy) return
    if (!reason?.trim()) return
    setBusy(true)
    try {
      const result = await api.recoverStudioCard({ taskId: data.task.id, batchId: data.batch.id, cardId: card.id, expectedRunId: latest.id, recoveryId: crypto.randomUUID(), reason: reason.trim(), ...(revalidateFrom ? { revalidateFrom } : {}) })
      toast(result.restored.length ? `已恢复 ${result.restored.length} 个节点；新 Run 将按依赖顺序启动，旧证据仍保留。` : '恢复请求已记录')
      setConfirmMode(null)
      await refresh()
    } catch (e) { toast(`未能恢复：${String((e as Error).message ?? e)}`) }
    finally { setBusy(false) }
  }
  const openQuestion = async () => {
    if (!latest?.sessionId) return
    try { await api.openSession(latest.sessionId); toast('已打开原 Session；在会话中回答问题会继续同一个 Run。') }
    catch (e) { toast(String((e as Error).message ?? e)) }
  }
  const unblock = async () => {
    if (archived || busy) return
    setBusy(true)
    try { await api.unblockCard(card.id); setConfirmMode(null); toast('已解除阻塞，调度器将创建新的 Run。'); await refresh() }
    catch (e) { toast(`未能继续：${String((e as Error).message ?? e)}`) }
    finally { setBusy(false) }
  }
  if (!latest || archived || card.status === 'running') return null
  if (latest.status === 'blocked' && !latest.terminalBlock && latest.sessionId) return <div className="dtc-stage-actions"><span>等待你在原会话回答；会继续同一个 Run。</span><button className="dtc-btn pri sm" disabled={busy} onClick={() => void openQuestion()}>打开原会话回答</button></div>
  if (latest.status === 'blocked' && latest.terminalBlock) {
    const wakeAt = card.wakeAt ? Date.parse(card.wakeAt) : 0
    const waiting = wakeAt > Date.now()
    return <div className="dtc-stage-actions"><span>原 Run 已结束；继续会新建 Run。{waiting ? ` 定时等待至 ${new Date(wakeAt).toLocaleString()}。` : ''}</span>{card.role === 'executor' && prepReceipts.length ? <div className="dtc-stage-revalidate">{prepReceipts.map(receipt => <button key={stageKey(receipt.stage, receipt.round)} className="dtc-btn sm" disabled={busy || waiting} onClick={() => begin(receipt.stage as any)}>从第 {receipt.round} 轮「{stageNames[receipt.stage] ?? receipt.stage}」返修</button>)}</div> : <button className="dtc-btn pri sm" disabled={busy || waiting} onClick={() => begin('unblock')}>{waiting ? '等待定时恢复' : '解除阻塞并新建 Run'}</button>}{confirmMode ? <div className="dtc-stage-confirm"><b>{confirmMode === 'unblock' ? '确认新建 Run' : '说明本次恢复原因'}</b><small>{confirmMode === 'unblock' ? '旧 Run 和阶段历史会保留；新 Run 按依赖关系启动。' : '旧 Run 和阶段历史会保留；新的工作会按 Task 依赖关系启动。'}</small>{confirmMode !== 'unblock' ? <textarea value={reason} maxLength={500} onChange={event => setReason(event.target.value)} aria-label="恢复原因" /> : null}<div><button className="dtc-btn sm" disabled={busy} onClick={() => setConfirmMode(null)}>取消</button><button className="dtc-btn pri sm" disabled={busy || (confirmMode !== 'unblock' && !reason.trim())} onClick={() => confirmMode === 'unblock' ? void unblock() : void recover(confirmMode)}>{busy ? '处理中…' : '确认继续'}</button></div></div> : null}</div>
  }
  if (data.batch.outcome === 'failed' && card.status === 'failed' && ['failed', 'crashed', 'timed_out'].includes(latest.status)) return <div className="dtc-stage-actions"><span>批次已失败；恢复会保留历史并按依赖重新启动。</span><button className="dtc-btn pri sm" disabled={busy} onClick={() => begin('recover')}>恢复此节点并继续</button>{confirmMode ? <div className="dtc-stage-confirm"><b>说明本次恢复原因</b><small>只会对后端当前认定为可恢复的 Studio 失败批次执行操作。</small><textarea value={reason} maxLength={500} onChange={event => setReason(event.target.value)} aria-label="恢复原因" /><div><button className="dtc-btn sm" disabled={busy} onClick={() => setConfirmMode(null)}>取消</button><button className="dtc-btn pri sm" disabled={busy || !reason.trim()} onClick={() => void recover()}>{busy ? '处理中…' : '确认继续'}</button></div></div> : null}</div>
  return null
}

export function TaskStageWorkspace({ api, taskId, batchId, toast }: { api: TasksApi; taskId: string; batchId: string; toast: (text: string) => void }) {
  const [data, setData] = useState<StudioTaskWorkspace | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const refresh = useCallback(async () => { try { setData(await api.studioTaskWorkspace(taskId, batchId)); setError('') } catch (e) { setError(String((e as Error).message ?? e)) } finally { setLoading(false) } }, [api, taskId, batchId])
  useEffect(() => { void refresh(); const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 5000); return () => window.clearInterval(timer) }, [refresh])
  const cardsById = useMemo(() => new Map((data?.cards ?? []).map(card => [card.id, card])), [data])
  if (loading && !data) return <div className="dtc-empty"><span className="dtc-spin" />读取阶段工作区…</div>
  if (!data) return <div className="dtc-body"><div className="dtc-err">{error || '没有阶段数据'}<button className="dtc-btn sm" onClick={() => void refresh()}>重试</button></div><button className="dtc-btn" onClick={() => go(`tasks/${taskId}/runs/${batchId}`)}>← 返回执行图</button></div>
  const rounds = [...new Set([...data.receipts.map(receipt => receipt.round), ...data.cards.filter(card => card.role === 'studio-stage').map(card => card.round ?? 1)])].sort((a, b) => a - b)
  const receiptMap = new Map(data.receipts.map(receipt => [stageKey(receipt.stage, receipt.round), receipt]))
  const stageCard = (stage: string, round: number) => cardsById.get(`${batchId}#s${round}-${stage}`) ?? data.cards.find(card => card.role === 'studio-stage' && card.round === round && card.title?.toLowerCase().includes(stage))
  const productionCards = data.cards.filter(card => card.role !== 'studio-stage')
  return <main className="dtc-stage-workspace">
    <header className="dtc-stage-workspace-head"><div><button className="dtc-btn sm" onClick={() => go(`tasks/${taskId}/runs/${batchId}`)}>← 返回协作流程</button><p className="dtc-faint">Task · {taskId}　/　Batch · {data.batch.id}</p><h1>{data.task.title}</h1><p>阶段交付来自 Task 已登记的回执。回执只证明文件已交接，不代表质量验收通过。上游正常交接后，下游由 Task 依赖自动启动。</p></div><div><span className={`dtc-pill ${data.batch.outcome === 'done' ? 'dtc-p-ok' : data.batch.outcome === 'failed' ? 'dtc-p-bad' : ''}`}>{data.batch.outcome ?? '运行中'}</span><button className="dtc-btn sm" onClick={() => void refresh()}>刷新</button></div></header>
    {error ? <div className="dtc-err">刷新失败：{error}</div> : null}
    {rounds.length ? rounds.map(round => <section className="dtc-stage-round" key={round}><h2>第 {round} 轮制作</h2><div className="dtc-stage-grid">{data.stages.map((stage, index) => {
      const receipt = receiptMap.get(stageKey(stage.id, round)), card = stageCard(stage.id, round), latest = card?.runs.at(-1)
      const files = receipt?.outputs ?? []
      return <article className={`dtc-stage-card ${receipt ? 'has-receipt' : ''}`} key={stage.id}><header><i>{String(index + 1).padStart(2, '0')}</i><div><h3>{stageNames[stage.id] ?? stage.id}</h3><small>{stage.agentId} · {card ? statusNames[card.status] ?? card.status : '尚未创建执行节点'}</small></div><span className={`dtc-pill ${receipt ? 'dtc-p-ok' : 'dtc-p-grey'}`}>{receipt ? '已登记交付' : '等待交付'}</span></header>
        {receipt ? <><p className="dtc-stage-summary">{receipt.summary}</p><div className="dtc-stage-files">{files.map(file => <StagePreview key={`${file.path}:${file.sha256}`} api={api} taskId={taskId} batchId={batchId} stage={stage.id} round={round} file={file} />)}</div><small className="dtc-stage-note">Session {receipt.sessionId} · {files.length} 个文件 · 质量批准：否</small></> : <p className="dtc-stage-empty">该阶段还没有登记交付文件。执行完成后这里会自动更新。</p>}
        {card ? <><details className="dtc-stage-run"><summary>执行记录 · {card.runs.length} 个 Run</summary>{card.runs.map(run => <div key={run.id} className="dtc-stage-run-row"><b>Run {run.id} · {statusNames[run.status] ?? run.status}</b><small>{run.startedAt ? new Date(run.startedAt).toLocaleString() : ''}{run.sessionId ? ` · Session ${run.sessionId}` : ''}</small>{run.error || run.question ? <p>{run.error ?? run.question}</p> : null}{run.summary ? <p>{run.summary}</p> : null}</div>)}</details><RecoveryActions api={api} data={data} card={card} toast={toast} refresh={refresh} /></> : null}
      </article>
    })}</div></section>) : <section className="dtc-stage-round"><h2>阶段还未创建</h2><p className="dtc-stage-empty">当前 Batch 尚未生成阶段节点或交付回执；回到协作流程查看规划节点和执行事件。</p></section>}
    <section className="dtc-stage-round"><h2>编导、合成与质检节点</h2><div className="dtc-stage-production">{productionCards.map(card => <article key={card.id}><div><b>{card.role ?? '任务节点'}{card.round ? ` · 第 ${card.round} 轮` : ''}</b><span className={`dtc-pill ${card.status === 'done' ? 'dtc-p-ok' : ['failed', 'triage'].includes(card.status) ? 'dtc-p-bad' : 'dtc-p-grey'}`}>{statusNames[card.status] ?? card.status}</span></div><small>{card.title}</small>{card.error ? <p>{card.error}</p> : null}<RecoveryActions api={api} data={data} card={card} toast={toast} refresh={refresh} /></article>)}</div></section>
  </main>
}
