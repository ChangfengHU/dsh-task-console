import { useState } from 'react'
import type { GraphEventRow } from '../graph-data.ts'
import { patrolItemView, patrolReportSummary } from '../patrol-report.ts'

/** Replays only persisted evidence at the selected event, never today's Fleet snapshot. */
export function PatrolEvidence({ events }: { events: GraphEventRow[] }) {
  const [attentionOnly, setAttentionOnly] = useState(false)
  const snapshot = events.findLast(e => e.kind === 'patrol_snapshot')
  if (!snapshot) return null
  const report = snapshot.payload as any
  const proxyEvent = events.findLast(e=>e.kind==='proxy_snapshot')
  const proxy = proxyEvent && proxyEvent.id > snapshot.id ? proxyEvent.payload as any : report.proxy
  const items = report.items ?? [], uncovered = report.uncovered ?? []
  const { counts, summary } = patrolReportSummary(items, uncovered)
  const legacy = report.assessmentMode !== 'point-in-time-v1'
  const attention = items.filter((r: any) => !r.accepted || patrolItemView(r).freshness === 'expired')
  const notices = new Map(events.filter(e => e.kind === 'notification_delivery').map(e => [String(e.payload.notification_id), e.payload]))
  const queued = events.filter(e=>e.kind==='notification_requested' && !events.some(n=>n.task_id===e.task_id && ['notification_delivery','notification_blocked'].includes(n.kind)))
  const date = (at: unknown) => typeof at === 'string' && Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未记录'
  return <section className="dtc-cpanel dtc-patrol" aria-label="浏览器巡查验收">
    <header><div><h3>浏览器巡查 · 检查结果</h3><small>数据库回放 · 证据事件 #{snapshot.id} · 北京时间 {date(report.assessedAt ?? new Date(snapshot.created_at * 1000).toISOString())}</small></div><span>{legacy ? '历史验收记录' : '本轮检查快照'}</span></header>
    <p className="dtc-patrol-summary">{items.length || uncovered.length ? summary : report.reason || '等待本轮检查证据'}</p>
    <p className="dtc-patrol-note">{legacy ? '历史执行结果保持不变。旧口径曾将回执过期计为未通过，不代表浏览器已退出登录。' : '本轮有效的独立检查不会因交接耗时失效；后续掉线、未知、账号变化或修复操作仍需重新验收。'}这里的新鲜度是该事件发生时的状态，不是此刻 Fleet 的实时状态。</p>
    {proxy ? <details className="dtc-patrol-original"><summary>代理前置检查 · {proxy.lineId} · 独立验收 {proxy.items.filter((r:any)=>r.independent).length}/{proxy.items.length}</summary>
      <p className="dtc-patrol-note">新登录写入需要新鲜网络证据；独立验收保留本轮检查事实，新的异常或修复仍使它失效。以下均为该回放位置的数据。</p>
      <div className="dtc-patrol-rows">{proxy.items.map((r:any)=><article className="dtc-patrol-row" key={r.ip}>
        <div><b>{r.ip}</b><small>{date(r.checkedAt)}</small></div>
        <div><span className="dtc-patrol-label">本轮独立验收</span><b>{r.independent ? '已通过' : '未通过 / 待检查'}</b></div>
        <div><span className="dtc-patrol-label">快照时登录写入闸门</span><b>{r.accepted ? '可继续判定登录' : '禁止写入，先取得网络证据'}</b><small>{r.reason}</small></div>
        <details className="dtc-patrol-detail"><summary>网络证据</summary><dl>
          <div><dt>期望出口</dt><dd>{r.expectedIp ?? '未记录'}</dd></div>
          {Object.entries(r.paths ?? {}).map(([path,value])=><div key={path}><dt>{path}</dt><dd>{String(value)}</dd></div>)}
          <div><dt>操作回执</dt><dd>{r.operationId ?? '未记录'}</dd></div>
          {r.sessionId ? <div><dt>执行会话</dt><dd><a href={`/?session=${encodeURIComponent(r.sessionId)}`} target="_blank" rel="noreferrer">打开原会话 ↗</a></dd></div> : null}
        </dl></details>
      </article>)}</div>
    </details> : null}
    <nav aria-label="巡查结果筛选"><button className="dtc-btn sm" aria-pressed={!attentionOnly} onClick={() => setAttentionOnly(false)}>全部浏览器 · {counts.total}</button><button className="dtc-btn sm" aria-pressed={attentionOnly} onClick={() => setAttentionOnly(true)}>待关注 · {attention.length}</button><small>待关注包含待刷新，不等于需要修复</small></nav>
    <div className="dtc-patrol-rows">
      {(attentionOnly ? attention : items).map((r: any) => { const view = patrolItemView(r); return <article className="dtc-patrol-row" key={`${snapshot.id}:${r.ip}:${r.instance}`}>
        <div><b>{r.ip}</b><small>browser-{r.instance} · 修复尝试 {r.attempts ?? 0} 次</small></div>
        <div><span className="dtc-patrol-label">检查事实</span><b>{view.state}</b><small>{date(r.checkedAt)}</small></div>
        <div><span className="dtc-patrol-label">证据新鲜度 · 快照时</span><b className={view.freshness === 'expired' ? 'dtc-warn' : ''}>{view.freshness === 'expired' ? '待刷新（非登录失败）' : view.freshness === 'fresh' ? '当时有效' : '无法确认'}</b><small>{view.freshness === 'expired' ? '过期的是检测回执，不是账号 Cookie' : '不表示未来永不掉线'}</small></div>
        <div><span className="dtc-patrol-label">{legacy ? '历史结论 / 下一步' : '本轮结论 / 下一步'}</span><b>{legacy && r.accepted ? '当时已验收' : view.verdict}</b><small>{view.next}</small></div>
        <details className="dtc-patrol-detail"><summary>证据详情</summary><dl>
          <div><dt>原始判定</dt><dd>{r.reason} · {r.accepted ? 'accepted=true' : 'accepted=false'}</dd></div>
          <div><dt>独立检查时间</dt><dd>{date(r.independentCheckedAt)}</dd></div>
          <div><dt>回执有效期至</dt><dd>{date(r.independentExpiresAt ?? r.expiresAt)}{legacy ? '（旧快照缺失的字段不推测）' : ''}</dd></div>
          <div><dt>账号指纹</dt><dd>{r.fingerprint || '未记录'}</dd></div>
          <div><dt>独立检查</dt><dd>{r.independentlyObserved ?? 0} 次；{r.observation ? `${r.observation.samples}/${r.observation.requiredSamples} 个有效时间样本 · 要求跨 ${r.observation.minutes} 分钟 · ${r.observation.passed ? '已满足' : '未满足'}` : '未修复实例，无额外稳定性窗口'}</dd></div>
          {r.observation?.nextCheckAt ? <div><dt>下次采样</dt><dd>{date(r.observation.nextCheckAt)}</dd></div> : null}
          <div><dt>检查操作</dt><dd>{r.independentOperationId ?? r.operationId ?? '未记录'}</dd></div>
          {r.lastChangeAt ? <div><dt>最近修复</dt><dd>{date(r.lastChangeAt)}</dd></div> : null}
          {r.verificationFailure ? <div><dt>未完成的复验</dt><dd>{date(r.verificationFailure.at)} · {r.verificationFailure.reason} · {r.verificationFailure.operationId}</dd></div> : null}
        </dl></details>
      </article> })}
      {attentionOnly && !attention.length ? <p className="dtc-muted">这个回放位置没有待关注的浏览器。</p> : null}
    </div>
    {uncovered.map((r: any) => <p className="dtc-patrol-note dtc-warn" key={r.nodeId}>{r.nodeId}：节点未覆盖，无法确认其浏览器情况；单独阻止全量验收，不等于其他浏览器未登录。</p>)}
    <details className="dtc-patrol-original"><summary>原始快照结论（保留历史）</summary><p>{report.summary || report.reason}</p></details>
    {queued.map(e=><p key={e.id}>✉ {String(e.payload.stage)} · 通知员待发送 · {e.task_id}</p>)}
    {events.filter(e=>e.kind==='notification_blocked').map(e=><p key={e.id}>✉ 通知未完成：{String(e.payload.reason)}</p>)}
    {notices.size ? <details><summary>企微通知 · {notices.size} 条</summary>{[...notices].map(([id,n]) => <p key={id}>{String(n.stage)} · {String(n.state)} · {String(n.reason)}<br /><small>{id}</small></p>)}</details> : null}
  </section>
}
