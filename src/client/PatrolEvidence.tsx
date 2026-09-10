import type { GraphEventRow } from '../graph-data.ts'

/** Replays only persisted evidence at the selected event, never today's Fleet snapshot. */
export function PatrolEvidence({ events }: { events: GraphEventRow[] }) {
  const snapshot = events.findLast(e => e.kind === 'patrol_snapshot')
  if (!snapshot) return null
  const report = snapshot.payload as any
  const notices = new Map(events.filter(e => e.kind === 'notification_delivery').map(e => [String(e.payload.notification_id), e.payload]))
  const queued = events.filter(e=>e.kind==='notification_requested' && !events.some(n=>n.task_id===e.task_id && ['notification_delivery','notification_blocked'].includes(n.kind)))
  const date = (at: unknown) => typeof at === 'string' ? new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'
  return <section className="dtc-cpanel" aria-label="浏览器巡查验收" style={{ padding: 16 }}>
    <h3>浏览器巡查 · 真实证据</h3><p>{report.summary || report.reason}</p>
    <small className="dtc-muted">跟随数据库回放 · 证据事件 #{snapshot.id} · 时间为北京时间；角色完成不等于业务验收通过</small>
    <div style={{ overflowX: 'auto', marginTop: 12 }}><table style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse', fontSize: 13, textAlign: 'left' }}>
      <thead><tr>{['浏览器','当前证据','修复次数','独立观察','验收 / 下一步'].map(x => <th key={x} style={{ padding: 8 }}>{x}</th>)}</tr></thead>
      <tbody>{(report.items ?? []).map((r: any) => <tr key={`${r.ip}:${r.instance}`}>
        <td style={{ padding: 8 }}>{r.ip}<br />browser-{r.instance}</td>
        <td style={{ padding: 8 }}>{r.state}{r.fingerprint ? ` · ${r.fingerprint}` : ''}<br /><small>{date(r.checkedAt)}</small></td>
        <td style={{ padding: 8 }}>{r.attempts} 次</td>
        <td style={{ padding: 8 }}>{r.observation ? `${r.observation.samples}/${r.observation.requiredSamples} 次 · ${r.observation.minutes} 分钟` : '未修复实例：当前独立验证'}{r.observation?.nextCheckAt ? <><br /><small>下次 {date(r.observation.nextCheckAt)}</small></> : null}</td>
        <td style={{ padding: 8 }}>{r.accepted ? '已验收' : '未通过'}<br /><small>{r.reason}</small></td>
      </tr>)}</tbody>
    </table></div>
    {(report.uncovered ?? []).map((r: any) => <p className="dtc-warn" key={r.nodeId}>{r.nodeId}：无法确认浏览器覆盖，不能视为已通过。</p>)}
    {queued.map(e=><p key={e.id}>✉ {String(e.payload.stage)} · 通知员待发送 · {e.task_id}</p>)}
    {events.filter(e=>e.kind==='notification_blocked').map(e=><p key={e.id}>✉ 通知未完成：{String(e.payload.reason)}</p>)}
    {notices.size ? <details><summary>企微通知 · {notices.size} 条</summary>{[...notices].map(([id,n]) => <p key={id}>{String(n.stage)} · {String(n.state)} · {String(n.reason)}<br /><small>{id}</small></p>)}</details> : null}
  </section>
}
