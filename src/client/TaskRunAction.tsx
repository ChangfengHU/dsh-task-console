import type { TaskSpec } from '../wire.ts'
import type { TasksApi } from './TasksView.tsx'
import { go } from './Console.tsx'

/** Each invocation supplies fresh inputs; never silently replay an old target/credential. */
export function TaskRunAction({ task, api, toast }: { task: TaskSpec; api: TasksApi; toast: (text: string) => void }) {
  const chat = task.origin?.source === 'task-chat'
  const external = Boolean(task.origin?.signalId) && !chat
  return <button className="dtc-btn pri" disabled={external || !task.enabled} title={external ? '从来源系统重新提交，由 Task Agent 核对目标与角色' : '复用工作流，新增独立执行记录'} onClick={async event => {
    event.stopPropagation()
    try {
      if (chat) {
        const text = window.prompt(`为「${task.title}」输入本次任务参数。不会复用上次的 IP 或登录凭据。`)
        if (!text?.trim()) return
        const next = await api.launchWorkflow(task.id, text.trim(), crypto.randomUUID())
        go(`tasks/${task.id}/runs/${next.batchId}`)
      } else { const next = await api.fireTask(task.id); go(`tasks/${task.id}/runs/${next.runId}`) }
      toast('已创建新执行，历史记录保留')
    } catch (error) { toast(error instanceof Error ? error.message : String(error)) }
  }}>{external ? '从来源重试' : chat ? '＋ 新执行' : '▶ 再跑一次'}</button>
}
