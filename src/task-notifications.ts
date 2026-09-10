import { createHash } from 'node:crypto'
import type { EventStore } from './tasks.ts'
import type { CompletionCheck } from './runner.ts'

export type NotificationStage = 'started' | 'findings' | 'rework' | 'restored' | 'unresolved'
const labels = { started: '开始巡查', findings: '巡查发现', rework: '继续返工', restored: '独立验收通过', unresolved: '仍有未解决项' }

/** Durable, recipient-pinned outbox. Delegated cards reuse the same MCP transport. */
export class TaskNotifications {
  constructor(private store: EventStore) {
    store.kernel.db.exec(`CREATE TABLE IF NOT EXISTS dsh_task_notifications(
      id TEXT PRIMARY KEY,task_id TEXT NOT NULL,batch_id TEXT NOT NULL,card_id TEXT NOT NULL,stage TEXT NOT NULL,
      chat_id TEXT NOT NULL,markdown TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,reason TEXT,session_id TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_dsh_notifications_batch ON dsh_task_notifications(batch_id,updated_at);`)
  }

  job(input: CompletionCheck) {
    if (input.card.role !== 'notifier' || input.profileId !== input.task.design?.notifications?.agentId) throw new Error('不是本任务已审查的通知员')
    const row = this.store.kernel.listEvents(input.card.id).find(e => e.kind === 'notification_requested')
    if (!row?.payload) throw new Error('没有冻结的通知交接')
    return JSON.parse(row.payload) as {stage:NotificationStage;report:any;source_card_id:string}
  }

  async request(input: CompletionCheck, stage: NotificationStage, report: any) {
    if (input.card.role !== 'planner' || !Object.hasOwn(labels,stage)) throw new Error('只有规划者可交接通知')
    if (stage === 'restored' && !report.ready || stage === 'unresolved' && report.ready) throw new Error('通知阶段与真实验收结果不一致')
    const cardId = await this.store.createNotification(input.task,input.batch,input.card,stage,report)
    return { state:'queued', cardId, agentId:input.task.design?.notifications?.agentId, notice:'通知员将在规划者交接后独立执行；尚未发送，不阻塞浏览器主流程。' }
  }

  complete(input: CompletionCheck) {
    const job = this.job(input), rows = this.rows(input.batch.id).filter((r:any)=>r.card_id===input.card.id && r.stage===job.stage) as any[]
    if (rows.length !== input.task.design!.notifications!.chatIds.length || rows.some(r=>['pending','sending'].includes(r.state))) throw new Error('先 task_notify 留下真实发送回执')
    return {summary:`企微 ${labels[job.stage]}：${rows.map(r=>`${r.state} (${r.id})`).join('、')}。不代表用户已阅读。`,metadata:{notifications:rows,...(rows.some(r=>r.state!=='sent')?{workflowOutcome:'unresolved'}:{})}}
  }

  async send(input: CompletionCheck, stage: NotificationStage, report: any, deliver: (args: { markdown: string; chatids: string[] }) => Promise<any>) {
    const config = input.task.design?.notifications
    if (!config?.chatIds.length) throw new Error('未明确配置收件群，禁止默认广播')
    if (config.agentId) {
      const job = this.job(input)
      if (stage !== job.stage) throw new Error('通知员只能发送本卡冻结的阶段')
      report = job.report
    } else if (input.card.role !== 'planner') throw new Error('只有已审查的规划者可发送通知')
    if (!Object.hasOwn(labels,stage) || stage === 'restored' && !report.ready || stage === 'unresolved' && report.ready) throw new Error('通知阶段与真实验收结果不一致')
    const db = this.store.kernel.db, results: any[] = []
    for (const chatId of config.chatIds) {
      const id = createHash('sha256').update(JSON.stringify([input.batch.id, input.card.round, stage, chatId])).digest('hex').slice(0, 24)
      const markdown = [`## 浏览器巡查 · ${labels[stage]}`, `Task: ${input.task.id}`, `执行: ${input.batch.id} · 第 ${input.card.round} 轮`,
        report.summary || report.reason, ...(report.items ?? []).map((r: any) => `- ${r.ip}/browser-${r.instance}: ${r.accepted ? '已验收' : r.state}；修复尝试 ${r.attempts}；${r.reason}`),
        ...(report.uncovered ?? []).map((r: any) => `- ${r.nodeId}: 无法确认覆盖`), `通知编号: ${id}`].filter(Boolean).join('\n')
      db.prepare("INSERT OR IGNORE INTO dsh_task_notifications VALUES (?,?,?,?,?,?,?,'pending',0,?,NULL,?)").run(id,input.task.id,input.batch.id,input.card.id,stage,chatId,markdown,Date.now(),input.sessionId)
      const claim = this.store.kernel.write(() => {
        const row = db.prepare('SELECT * FROM dsh_task_notifications WHERE id=?').get(id) as any
        if (row.state === 'sending' && Date.now() - row.updated_at > 120_000) {
          db.prepare("UPDATE dsh_task_notifications SET state='unknown',reason='上次发送中断；需核对通知编号，不盲目重发' WHERE id=?").run(id)
          return false
        }
        if (!['pending','failed'].includes(row.state) || row.attempts >= 3) return false
        db.prepare("UPDATE dsh_task_notifications SET state='sending',attempts=attempts+1,updated_at=? WHERE id=?").run(Date.now(),id)
        return true
      })
      if (claim) {
        let state = 'unknown', reason = '发送结果未知；保留编号等待核对，不自动重发'
        try {
          const row = db.prepare('SELECT markdown FROM dsh_task_notifications WHERE id=?').get(id) as any
          const result = await deliver({ markdown: row.markdown, chatids: [chatId] })
          const failure = result?.detail ?? result
          if (result?.ok !== false && !result?.error && result?.sent === 1) { state = 'sent'; reason = 'MCP 确认送达1个群，不代表用户已阅读' }
          // Only definite pre-send refusals are safely retryable. Network failures are ambiguous.
          else if (failure?.ok === false && failure?.code === 'wecom_connection_unavailable' && failure?.delivery === 'not_sent' && failure?.sent === 0) {
            state = 'failed'
            reason = '企业微信连接恢复未通过，消息尚未发送；最多重试3次通知，不重复浏览器操作'
          }
          else if (/^(no subscribers|指定的 chatid 不在已订阅列表里|no alerter designated|alerter node [\w-]+ unavailable|this node is not the connected alerter|wecom bridge not loaded)$/.test(String(failure?.error))) {
            state = 'failed'
            reason = /connected alerter|bridge not loaded/.test(failure.error)
              ? '企业微信发送节点未连接，服务在发送前拒绝；恢复后仅重试通知，不重复浏览器操作'
              : '发送前被服务拒绝；配置恢复后最多重试3次，仅重试通知'
          }
        } catch { /* Never expose transport credentials or replay an ambiguous send. */ }
        db.prepare('UPDATE dsh_task_notifications SET state=?,reason=?,updated_at=? WHERE id=?').run(state,reason,Date.now(),id)
        this.store.kernel.recordEvent(input.card.id, 'notification_delivery', { notification_id: id, stage, state, reason })
      }
      results.push(db.prepare('SELECT id,stage,state,attempts,reason FROM dsh_task_notifications WHERE id=?').get(id))
    }
    return { notifications: results, notice: '通知失败不撤销已完成的浏览器动作；unknown 须按编号核对，不能宣称送达。' }
  }

  rows(batchId: string) {
    return this.store.kernel.db.prepare('SELECT id,card_id,stage,state,attempts,reason,updated_at FROM dsh_task_notifications WHERE batch_id=? ORDER BY updated_at').all(batchId)
  }

  requireStage(input: CompletionCheck, stage: NotificationStage) {
    if (!input.task.design?.notifications) return []
    if (input.task.design.notifications.agentId) {
      const cardId = `${input.batch.id}#n${input.card.round}-${stage}`
      const exists = this.store.kernel.listEvents(cardId).some(e=>e.kind==='notification_requested')
      if (!exists) throw new Error(`先 task_notify(stage="${stage}") 将真实报告交给通知员`)
      return [{card_id:cardId,stage,state:'queued'}]
    }
    const rows = this.rows(input.batch.id).filter((r: any) => r.card_id === input.card.id && r.stage === stage) as any[]
    if (rows.length !== input.task.design.notifications.chatIds.length || rows.some(r => ['pending','sending'].includes(r.state))) throw new Error(`先调用 task_notify(stage="${stage}") 留下发送回执；只重试通知，不重复浏览器操作`)
    return rows
  }
}
