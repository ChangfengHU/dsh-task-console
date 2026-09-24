import type { GraphFrame } from './graph-data.ts'

const statuses: Record<string,string> = {todo:'等待依赖',ready:'尚未启动',running:'运行中',blocked:'受阻',review:'等待评审',done:'完成',archived:'已归档',triage:'失败待处理',scheduled:'定时等待'}
const outcomes: Record<string,string> = {completed:'完成',failed:'执行失败',timed_out:'执行超时',cancelled:'已取消',blocked:'受阻',crashed:'执行中断',protocol_violation:'未按协议交卷',changes_requested:'需要返工',review_requested:'已提交评审'}

/** Only the supplied replay frame is visible; never consult later runs or Fleet. */
export function executionProgress(frame: GraphFrame, outcome: string | null, nameOf: (id: string | null) => string): string | undefined {
  if (!frame.tasks.length) return
  const heading=outcome==='failed'?'本次执行未通过':outcome==='cancelled'?'本次执行已取消':outcome==='done'?'本次执行已结束':'本次执行尚未完成'
  const rows=frame.tasks.map(task=>{
    const runs=frame.runs.filter(run=>run.task_id===task.id).sort((a,b)=>a.id-b.id),run=runs.at(-1)
    const role=task.node_kind==='gate'?'Gate':nameOf(task.assignee)
    const state=run?.outcome ? outcomes[run.outcome]??statuses[task.status]??task.status : statuses[task.status]??task.status
    const lines=[`${role}：${state}${run?` · Run #${run.id}`:task.node_kind==='gate'?' · 无 Agent Run':' · 尚未生成执行会话'}`]
    if(run?.error){
      // Raw provider errors may contain request details; expose known codes only.
      let code: unknown
      try {const parsed=JSON.parse(run.error);code=parsed?.error?.code??parsed?.code}catch{}
      const reasons: Record<string,string>={TIMEOUT:'模型请求超时；不等同于目标机器故障或登录掉线',TRANSPORT:'模型连接中断',ABORTED:'执行被中止'}
      lines.push(typeof code==='string'&&reasons[code]?`原因：${reasons[code]}`:'原因与原始调用结果请查看该角色的 Session Trace。')
    }
    if(run?.summary)lines.push(run.summary)
    if(runs.length>1)lines.push(`此节点共 ${runs.length} 次尝试；先前失败记录保留在会话与回放中。`)
    return lines.join('\n')
  })
  return `${heading}\n${frame.tasks.filter(t=>t.status==='done').length}/${frame.tasks.length} 个流程节点完成；阶段完成不等于整项业务验收通过。\n\n${rows.join('\n\n────────\n\n')}`
}
