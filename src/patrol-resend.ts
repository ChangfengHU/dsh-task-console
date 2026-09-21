import { createHash } from 'node:crypto'
import { patrolFollowup } from './patrol-followup.ts'

/** Explicit operator resend only. Never runs a Task or retries an ambiguous send. */
export async function resendPatrolReport(db: any, taskId: string, requestId: string, origin: string, deliver: (args: any) => Promise<any>) {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(requestId) || !/^https:\/\/[^/?#]+$/.test(origin)) throw Error('Invalid resend request')
  const data=patrolFollowup(db),task=data.tasks.find(t=>t.taskId===taskId)
  if (!task) throw Error('No patrol record')
  const batch=db.prepare('SELECT turn_json FROM dsh_batches WHERE id=?').get(task.batchId)
  const spec=JSON.parse(db.prepare('SELECT spec_json FROM dsh_task_specs WHERE id=?').get(taskId).spec_json)
  const definition=JSON.parse(batch.turn_json||'null')?.workflow?.definition??spec
  const groups=definition.design?.notifications?.chatIds
  if (!Array.isArray(groups)||!groups.length) throw Error('No reviewed recipients')
  const card=db.prepare('SELECT card_id FROM dsh_card_bindings WHERE batch_id=? ORDER BY position LIMIT 1').get(task.batchId)?.card_id
  if (!card) throw Error('No source card')
  const items=data.items.filter(r=>r.taskId===taskId),problems=items.filter(r=>r.treatment!=='checked')
  const result=[]
  for (const chatId of groups) {
    const id=createHash('sha256').update(JSON.stringify([taskId,requestId,chatId])).digest('hex').slice(0,24)
    const markdown=['## Gemini 巡查补充汇总（按要求重发）',`记录读取时间：${new Date(data.capturedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} 北京时间`,
      `最近执行：${({blocked:'处理受阻，尚未完成',running:'处理中',unresolved:'已结束，但有未解决项',completed:'已结束'})[task.state as string] ?? task.state}。`,
      `以下为 Task 已记录的检查和处理事实，不把历史验证当作现在仍然有效。`,
      ...problems.map(r=>`\n**${r.ip} / browser-${r.instance}：${r.verdict}**\n处理情况：${r.reason}。\n下一步：${r.next}。`),
      `${items.length-problems.length} 个浏览器最近独立检查通过；不重复复制健康登录。`,
      `[查看处理过程](${origin}/#/tc/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(task.batchId)})`,
      `通知编号：${id}`].join('\n')
    // Store intent before transport. Existing IDs never re-send, including unknown.
    const inserted=db.prepare("INSERT OR IGNORE INTO dsh_task_notifications VALUES (?,?,?,?,?,?,?,'sending',1,?,NULL,?)")
      .run(id,taskId,task.batchId,card,'resend',chatId,markdown,Date.now(),'operator-resend:'+requestId)
    if (inserted.changes) {
      let state='unknown',reason='发送结果未知；保留通知编号，不自动重发'
      try {const receipt=await deliver({markdown,chatids:[chatId]});if(receipt?.ok!==false&&!receipt?.error&&receipt?.sent===1){state='sent';reason='MCP 确认送达1个群，不代表用户已阅读'}} catch { /* no blind retry */ }
      db.prepare('UPDATE dsh_task_notifications SET state=?,reason=?,updated_at=? WHERE id=?').run(state,reason,Date.now(),id)
      db.prepare("INSERT INTO task_events(task_id,kind,payload,created_at,graph_id) VALUES (?,'notification_delivery',?,?,?)")
        .run(card,JSON.stringify({notification_id:id,stage:'resend',state,reason,requestId}),Math.floor(Date.now()/1000),task.batchId)
    }
    result.push(db.prepare('SELECT id,batch_id,stage,state,reason,updated_at FROM dsh_task_notifications WHERE id=?').get(id))
  }
  return result
}
