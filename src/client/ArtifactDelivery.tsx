import { useEffect, useMemo, useState } from 'react'
import { finalArtifact, groupArtifacts, type ArtifactActor, type ArtifactGroup } from '../artifact-delivery.ts'
import type { ArtifactView } from '../wire.ts'
import type { TasksApi } from './TasksView.tsx'

const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`
const role = (value?: ArtifactActor['role']) => value === 'executor' ? '执行者提交' : value === 'reviewer' ? '评估者核验' : value === 'planner' ? '规划者' : '角色登记'

function useArtifactActions(api: TasksApi, taskId: string, batchId: string | undefined, toast: (text: string) => void, refresh: () => Promise<void>) {
  const [busy, setBusy] = useState('')
  const [preview, setPreview] = useState<{ artifact: ArtifactView; url: string } | null>(null)
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url) }, [preview])
  const blobFor = async (artifact: ArtifactView) => {
    const { base64 } = await api.artifactContent(taskId, artifact.id, batchId)
    const raw = atob(base64); const data = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i)
    return URL.createObjectURL(new Blob([data], { type: artifact.mime }))
  }
  const openPreview = async (artifact: ArtifactView) => {
    setBusy(artifact.id)
    try { setPreview({ artifact, url: await blobFor(artifact) }) }
    catch (error) { toast(String((error as Error).message ?? error)) } finally { setBusy('') }
  }
  const download = async (artifact: ArtifactView) => {
    setBusy(artifact.id)
    try { const url = await blobFor(artifact); const link = document.createElement('a'); link.href = url; link.download = artifact.name; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 30_000) }
    catch (error) { toast(String((error as Error).message ?? error)) } finally { setBusy('') }
  }
  const publish = async (artifact: ArtifactView) => {
    if (!window.confirm(`把最终产物 ${artifact.name} 发布为任何人都能访问的公网链接？`)) return
    setBusy(artifact.id)
    try { const { publicUrl } = await api.publishArtifact(taskId, artifact.id); await refresh(); await navigator.clipboard?.writeText(publicUrl); toast('已发布，公网链接已复制') }
    catch (error) { toast(String((error as Error).message ?? error)) } finally { setBusy('') }
  }
  const copy = async (url: string) => { try { await navigator.clipboard.writeText(url); toast('公网链接已复制') } catch { toast('浏览器未允许复制，请手动复制链接') } }
  const modal = preview ? <div className="dtc-art-modal" role="dialog" aria-modal="true" aria-label={`预览 ${preview.artifact.name}`} onMouseDown={event => { if (event.target === event.currentTarget) setPreview(null) }}><div><header><span><b>{preview.artifact.name}</b><small>沙箱预览 · 页面无法访问任务面板</small></span><button onClick={() => setPreview(null)}>×</button></header>{preview.artifact.mime.startsWith('image/') ? <img src={preview.url} alt={preview.artifact.name} /> : <iframe src={preview.url} title={preview.artifact.name} sandbox="allow-scripts" />}</div></div> : null
  return { busy, openPreview, download, publish, copy, modal }
}

export function FinalArtifactActions({ api, taskId, batchId, group, toast, refresh, compact = false }: { api: TasksApi; taskId: string; batchId?: string; group?: ArtifactGroup; toast: (text: string) => void; refresh: () => Promise<void>; compact?: boolean }) {
  const actions = useArtifactActions(api, taskId, batchId, toast, refresh)
  if (!group) return <span className="dtc-delivery-wait">{compact ? '最终产物待确认' : '规划者尚未确认最终产物。'}</span>
  const artifact: ArtifactView = group.primary
  return <div className={`dtc-delivery-actions ${compact ? 'compact' : ''}`}>
    <button className="dtc-btn sm pri" disabled={actions.busy === artifact.id} onClick={() => actions.openPreview(artifact)}>预览最终结果</button>
    <button className="dtc-btn sm" disabled={actions.busy === artifact.id} onClick={() => actions.download(artifact)}>下载</button>
    {group.publicUrl ? <><a className="dtc-btn sm" href={group.publicUrl} target="_blank" rel="noreferrer">打开公网 ↗</a><button className="dtc-btn sm" onClick={() => actions.copy(group.publicUrl!)}>复制链接</button></> : !artifact.legacy && (artifact.mime === 'text/html' || /\.html?$/i.test(artifact.name)) ? <button className="dtc-btn sm" disabled={actions.busy === artifact.id} onClick={() => actions.publish(artifact)}>发布公网</button> : null}
    {actions.modal}
  </div>
}

export function ArtifactDelivery({ api, taskId, batchId, artifacts, actors = [], summary, toast, refresh, empty = '还没有登记产物。' }: { api: TasksApi; taskId: string; batchId?: string; artifacts: ArtifactView[]; actors?: ArtifactActor[]; summary?: string; toast: (text: string) => void; refresh: () => Promise<void>; empty?: string }) {
  const groups = useMemo(() => groupArtifacts(artifacts, actors), [artifacts, actors])
  const final = finalArtifact(groups)
  const actions = useArtifactActions(api, taskId, batchId, toast, refresh)
  if (!groups.length) return <section id="dtc-final-delivery" className="dtc-delivery"><div className="dtc-delivery-head"><div><span>FINAL DELIVERY</span><h2>最终交付</h2></div><em>等待产物</em></div><div className="dtc-empty">{empty}</div></section>
  return <section id="dtc-final-delivery" className="dtc-delivery">
    <div className="dtc-delivery-head"><div><span>FINAL DELIVERY</span><h2>{final ? '最终产物已确认' : '交付版本记录'}</h2><p>{final?.finalSource === 'compatibility' ? '此任务完成于显式最终产物功能上线前；系统按“最新执行者版本”兼容识别，请人工核对。' : final ? '规划者已经明确指定最终版本；相同字节的提交与评估快照已合并。' : '当前只有过程产物，任务完成前不会冒充最终结果。'}</p></div>{final ? <div className="dtc-delivery-final"><b>{final.primary.name}</b><small>SHA256 {final.sha256.slice(0, 12)}…</small><FinalArtifactActions api={api} taskId={taskId} batchId={batchId} group={final} toast={toast} refresh={refresh} /></div> : <em>待规划者确认</em>}</div>
    {summary ? <details className="dtc-delivery-handoff"><summary>查看最终交接说明</summary><p>{summary}</p></details> : null}
    <div className="dtc-artifact-groups">{[...groups].reverse().map((group, index) => { const artifact: ArtifactView = group.primary; const actorRows = [...new Map(group.actors.map(actor => [actor.cardId, actor])).values()]; return <article key={group.sha256} className={`dtc-artifact-group ${group.final ? 'is-final' : ''}`}>
      <div className="dtc-artifact-version"><span>V{groups.length - index}</span><i>{artifact.mime.startsWith('image/') ? '▧' : artifact.mime === 'text/html' ? '◇' : '▤'}</i></div>
      <div className="dtc-artifact-copy"><div className="dtc-artifact-title"><b>{artifact.name}</b>{group.final ? <span className="dtc-pill dtc-p-ok">{group.finalSource === 'compatibility' ? '兼容识别' : '最终版本'}</span> : null}{group.round ? <span className="dtc-pill dtc-p-grey">第 {group.round} 轮</span> : null}{group.decision === 'approved' ? <span className="dtc-pill dtc-p-ok">审核通过</span> : group.decision === 'changes' ? <span className="dtc-pill dtc-p-warn">已退回</span> : null}</div><small>{bytes(artifact.size)} · SHA256 {group.sha256}</small><div className="dtc-artifact-actors">{actorRows.map(actor => <span key={actor.cardId}><b>{actor.name}</b>{role(actor.role)}</span>)}{group.entries.length > 1 ? <em>{group.entries.length} 条相同登记已合并</em> : null}</div></div>
      <div className="dtc-delivery-actions"><button className="dtc-btn sm" disabled={actions.busy === artifact.id} onClick={() => actions.openPreview(artifact)}>预览</button><button className="dtc-btn sm" disabled={actions.busy === artifact.id} onClick={() => actions.download(artifact)}>下载</button>{group.publicUrl ? <a href={group.publicUrl} target="_blank" rel="noreferrer">公网 ↗</a> : null}</div>
    </article> })}</div>{actions.modal}
  </section>
}
