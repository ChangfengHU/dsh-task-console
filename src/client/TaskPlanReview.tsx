import { useEffect, useState } from 'react'
import type { Api } from './Console.tsx'
import { go } from './Console.tsx'
import type { TaskDesign } from '../task-design.ts'

const states: Record<string, string> = { pending: '待审查 · 未执行', rejected: '已退回', superseded: '已由新计划替代', approved: '已放行 · 待派发', dispatched: '已派发', awaiting_trial: '待手动验收 · 定时未启用', scheduled: '时间表已配置 · 可在看板查看启停状态' }
export function TaskDesignView({ design }: { design?: TaskDesign }) {
  if (!design) return null
  return <section aria-label="条件与验收设计">
    {design.browserPatrol ? <p>浏览器边界：仅现存且获准实例；允许 {design.browserPatrol.actions.join(' / ') || '只读'}，不含删除重建。修复后独立观察 {design.browserPatrol.observationMinutes} 分钟、至少 {design.browserPatrol.minSamples} 个新时间样本。</p> : null}
    {design.browserPatrol?.excludedNodeIds?.length ? <p>明确排除：{design.browserPatrol.excludedNodeIds.join('、')}。保留观测记录，不计为健康，也不阻止本轮验收。</p> : null}
    {design.browserPatrol?.scheduleActivation === 'completed-patrol' ? <p>定时启用验收：巡查全部角色正常结束、原生检查结论完整且通知送达即可；节点未解决项保留为未通过，不停止后续巡查。协议失败、缺失证据或通知未知不能启用。</p> : null}
    {design.proxy ? <p>代理前置验收：<a href={`#/tc/agents/${design.proxy.agentId}`}>{design.proxy.agentId} ↗</a> 处理 {design.proxy.lineId}；单次故障最多 {design.proxy.maxAttempts} 次修复。代理阶段取得终态后交接；宿主逐机器阻止未通过目标复制登录，其他目标继续。最终由评估者独立复验。</p> : null}
    {design.notifications ? <p>企微收件群：{design.notifications.chatIds.join('、')}；{design.notifications.agentId ? <>独立通知员 <a href={`#/tc/agents/${design.notifications.agentId}`}>{design.notifications.agentId} ↗</a>，阶段触发通知支线，保留自己的执行卡、会话和发送回执。通知失败不重跑浏览器。</> : '由规划者经 task_notify 发送并保存回执。'}不广播到其他群。</p> : null}
    {design.evidenceContract ? <p>宿主证据闸门：{design.evidenceContract}（依据实际工具事件核对交卷，不接受模型自报统计）</p> : <p className="dtc-workflow-muted">未选择专用宿主证据闸门；结构化计划本身不保证执行结果正确。</p>}
    <h3>目标与范围</h3><p className="dtc-workflow-copy">{design.scope}</p>
    <h3>条件分支</h3><ol className="dtc-workflow-roles">{design.branches.map(b => <li key={b.id}>
      <header><b>{b.id}</b></header><p>条件：{b.when}</p><p>动作：{b.action}</p><p>证据：{b.evidence}</p>
    </li>)}</ol>
    <h3>协调与失败处理</h3><p>{design.coordination}</p><p>单项隔离：{design.failurePolicy.isolateItems ? '是' : '否'} · 最大尝试：{design.failurePolicy.maxAttempts}（不增加副作用操作权限）</p>
    <ul>{design.failurePolicy.stopConditions.map((x, i) => <li key={i}>{x}</li>)}</ul>
    <h3>验收条件</h3><ul>{design.acceptance.map((x, i) => <li key={i}>{x}</li>)}</ul>
    <p className="dtc-workflow-muted">这是执行 Agent 的决策契约；分支依据真实工具证据判断，不代表内核已自动生成这些执行节点。</p>
  </section>
}

export function TaskPlanReview({ api, id }: { api: Api; id?: string }) {
  const [plan, setPlan] = useState<any>(null), [list, setList] = useState<any>(null)
  const [page, setPage] = useState(1), [error, setError] = useState(''), [reason, setReason] = useState('')
  const [checked, setChecked] = useState(false), [busy, setBusy] = useState(false)
  useEffect(() => {
    let current = true; setPlan(null); setError(''); setChecked(false); setReason('')
    void (id ? api.taskPlan(id) : api.taskPlans(page)).then(value => { if (current) id ? setPlan(value) : setList(value) }).catch(e => { if (current) setError(String(e.message || e)) })
    return () => { current = false }
  }, [api, id, page])
  const review = async (decision: 'approve' | 'reject') => {
    if (!plan || !reason.trim() || (decision === 'approve' && !checked)) return
    setBusy(true); setError('')
    try { setPlan(await api.reviewTaskPlan(plan.id, plan.hash, decision, reason)); setChecked(false) }
    catch (e) { setError(String((e as Error).message || e)) }
    finally { setBusy(false) }
  }
  return <section className="dtc-workflow" aria-label="任务计划审查">
    <header><div><b>{id ? '任务计划审查' : '计划审查记录'}</b><small>创建与执行分离 · 未放行不启动执行 Agent</small></div>
      <div className="dtc-workflow-actions"><button className="dtc-btn sm" onClick={() => go(id ? 'tasks/plans' : 'tasks')}>{id ? '全部计划' : '返回看板'}</button>{plan && <button className="dtc-btn sm" onClick={() => api.openSession(plan.sourceSessionId)}>创建 Agent 会话 ↗</button>}</div>
    </header>
    <div className="dtc-workflow-body">
      {error && <p className="dtc-err">{error}</p>}
      {!id && list ? <><p>共 {list.total} 个计划</p><ol className="dtc-workflow-roles">{list.rows.map((r: any) => <li key={r.id}><button className="dtc-btn" onClick={() => go(`tasks/plans/${r.id}`)}>{r.title}</button><p>{states[r.state] || r.state} · {new Date(r.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 北京时间</p></li>)}</ol><button className="dtc-btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button> {list.page} / {list.pages} <button className="dtc-btn sm" disabled={page >= list.pages} onClick={() => setPage(page + 1)}>下一页</button></> : null}
      {id && !plan && !error ? <p>读取计划…</p> : null}
      {plan ? <><div className="dtc-workflow-meta"><span>{states[plan.state] || plan.state}</span><span>指纹 {plan.hash.slice(0, 12)}</span></div><h2>{plan.definition.title}</h2>
        {plan.decision === 'revise' ? <section aria-label="同一任务版本更新"><p>更新现有任务 <a href={`#/tc/tasks/${plan.revisionTaskId}`}>{plan.revisionTaskId} ↗</a>，不新增任务或执行；旧执行继续使用原冻结定义。批准后仍暂停，必须重新手动验收。</p><details><summary>更新前的已审查定义</summary><pre>{JSON.stringify(plan.previousDefinition, null, 2)}</pre></details></section> : null}
        <h3>原始目标</h3><pre>{plan.request}</pre><p>{plan.definition.brief}</p><TaskDesignView design={plan.definition.design} />
        {plan.definition.trigger?.kind === 'cron' ? <p>时间表：{plan.definition.trigger.expr} · {plan.definition.trigger.timeZone || '宿主时区'}。批准后先手动验收，通过后才可启用定时；每次触发复用同一任务、新增执行记录。</p> : null}
        <h3>参与角色</h3><ol className="dtc-workflow-roles">{plan.definition.participants.map((p: any, i: number) => <li key={i}><b>{p.agentId}</b><p>{p.brief}</p></li>)}{plan.definition.design?.notifications?.agentId ? <li><b>{plan.definition.design.notifications.agentId}</b><p>辅助参与者 · 企微通知支线；按阶段创建独立卡和会话，不成为浏览器修复的前置依赖。</p></li> : null}</ol>
        <details><summary>完整冻结计划 JSON</summary><pre>{JSON.stringify(plan.definition, null, 2)}</pre></details>
        {plan.reviewReason ? <p>审查意见：{plan.reviewReason}</p> : null}
        {['pending', 'approved'].includes(plan.state) ? <section><h3>独立审查</h3><p>请核对范围、权限、条件、失败处理和验收标准。批准仅执行本计划，不增加节点或工具授权。</p>
          <textarea aria-label="审查意见" className="dtc-input" rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="填写通过或退回的依据" style={{ width: '100%', boxSizing: 'border-box' }} />
          <label><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={checked} onChange={e => setChecked(e.target.checked)} />已核对当前指纹对应的计划及本次操作范围</label>
          <div className="dtc-workflow-actions"><button className="dtc-btn" disabled={busy || !reason.trim() || plan.state !== 'pending'} onClick={() => review('reject')}>退回，不执行</button><button className="dtc-btn pri" disabled={busy || !checked || !reason.trim()} onClick={() => review('approve')}>{busy ? '提交中…' : plan.definition.trigger?.kind === 'cron' ? '批准计划，等待手动验收' : '批准并执行'}</button></div>
        </section> : null}
        {plan.taskId && plan.batchId ? <p><button className="dtc-btn" onClick={() => go(`tasks/${plan.taskId}/runs/${plan.batchId}`)}>查看真实执行记录 ↗</button></p> : null}
        {plan.taskId && !plan.batchId ? <p><button className="dtc-btn" onClick={() => go('tasks')}>查看时间表与触发记录 ↗</button></p> : null}
      </> : null}
    </div>
  </section>
}
