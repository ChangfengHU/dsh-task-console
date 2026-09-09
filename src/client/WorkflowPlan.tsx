import { useState } from 'react'
import type { Batch, TaskSpec } from '../wire.ts'
import { workflowView } from '../workflow-plan.ts'
import { TaskDesignView } from './TaskPlanReview.tsx'

export function WorkflowPlan({ task, batch, nameOf, openSession, trace }: {
  task: TaskSpec; batch?: Batch; nameOf: (id: string) => string
  openSession: (id: string) => void; trace: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState('plan')
  const view = workflowView(task, batch)
  const plan = view.definition
  if (!view.origin) return null
  return <section className="dtc-workflow" aria-label="创建与编排">
    <header><div><b>创建与编排</b><small>{view.directReuse ? '本次直接复用工作流 · 未再次调用创建 Agent' : view.origin.decision === 'reuse' ? 'Agent 选择复用工作流 · 新执行记录' : 'Agent 已生成工作流 · 执行由下方 DAG 跟踪'}</small></div>
      <div className="dtc-workflow-actions">{view.sessions.map(s => <button key={s.id} className="dtc-btn sm" onClick={() => openSession(s.id)}>{s.label} 会话 ↗</button>)}<button className="dtc-btn sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起计划' : '查看协作计划'}</button></div>
    </header>
    {expanded ? <div className="dtc-workflow-body">
      <nav role="tablist" aria-label="编排信息">{[['plan', '协作计划'], ['input', '本次输入'], ['json', '计划 JSON']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}</nav>
      <div className="dtc-workflow-meta"><span>{view.planId ? `计划指纹 ${view.planId.slice(0, 12)}` : '历史记录 · 未保存独立计划快照'}</span><span>{plan.graphMode === 'dynamic-rounds' ? '动态返工协议' : '角色交接 / static-chain'}</span>{view.origin.reviewPlanId ? <a href={`#/tc/tasks/plans/${view.origin.reviewPlanId}`}>查看放行记录</a> : null}{plan.workflowRecipe ? <span>预制配方 {plan.workflowRecipe.id} · {plan.workflowRecipe.login === 'provision-gemini' ? '验证并补齐 Gemini 登录' : '保持登录现状'}</span> : null}{view.sessions.map(s => <button key={s.id} className="dtc-btn sm" onClick={() => trace(s.id)}>{s.label} Trace</button>)}</div>
      {tab === 'plan' ? <TaskDesignView design={plan.design} /> : null}
      {tab === 'plan' ? <div role="tabpanel"><h3>{plan.title}</h3><p className="dtc-workflow-copy">{plan.brief}</p><p className="dtc-workflow-muted">决策依据：{view.origin.reason || '历史记录未提供'}</p>
        <ol className="dtc-workflow-roles">{plan.participants.map((role, index) => <li key={`${role.agentId}-${index}`}><header><b>{index + 1}. {nameOf(role.agentId)}</b><span>{plan.graphMode === 'dynamic-rounds' ? ['初始规划 / 后续收口', '每轮执行', '每轮评估'][index] : index ? `依赖 ${nameOf(plan.participants[index - 1].agentId)} 完成交接` : '首个执行角色'}</span></header><p>{role.brief || '未单独设置角色任务书，使用总体目标。'}</p><code>{role.agentId}</code></li>)}</ol>
        <p className="dtc-workflow-muted">每个角色使用自身预设的工具与 Skill 权限。{plan.graphMode === 'dynamic-rounds' ? '实际 Gate 和返工节点仅在数据库创建后出现在 DAG。' : '系统按顺序启动角色，把原始上游交接传给下游；末位角色汇总结果。'}超时 {Math.round(plan.timeoutSec / 60)} 分钟 / 角色；{plan.onFail === 'retry' ? `失败最多尝试 ${plan.maxTries} 次` : '失败停止'}。</p>
      </div> : tab === 'input' ? <div role="tabpanel"><h3>本次用户请求</h3><pre>{view.request ?? '历史记录未单独保存用户请求；不把总体任务书伪装成原始输入。'}</pre><h3>本次目标</h3><p>{batch?.turn?.targets?.map(t => `${t.kind}: ${t.id}`).join(' · ') || '未单独记录目标参数'}</p><p className="dtc-workflow-muted">创建 Agent 的原始对话、名册查询及工具提交参数，请打开上方会话或 Trace。此处是已脱敏的执行输入。</p></div>
      : <div role="tabpanel"><p className="dtc-workflow-muted">{view.legacy ? '按已有记录展示的定义，并非补造历史模型输出。' : '本次执行已保存的工作流定义；不会随 Agent 预设修改而改变。'}模型原始提交请查看创建 Agent 的 task_create_submit 工具调用。</p><pre>{JSON.stringify({ planId: view.planId, decision: view.origin.decision, reason: view.origin.reason, ...plan }, null, 2)}</pre></div>}
    </div> : null}
  </section>
}
