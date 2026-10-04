import type { TaskSpec } from '../wire.ts'
import type { TasksApi } from './TasksView.tsx'
import { go } from './Console.tsx'
import { taskRunMode } from './task-run-mode.ts'

/** Each invocation supplies fresh inputs; never silently replay an old target/credential. */
export function TaskRunAction({ task, api, toast }: { task: TaskSpec; api: TasksApi; toast: (text: string) => void }) {
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  if (task.archivedAt) return <button className="dtc-btn" disabled title="历史记录保留；恢复任务后才可再次执行">已归档</button>
  const chat = task.origin?.source === 'task-chat'
  const mode = taskRunMode(task)
  const external = mode === 'external'
  const scheduled = task.trigger.kind === 'cron'
  return <button className="dtc-btn pri" disabled={busy || external || (!task.enabled && !scheduled)} title={external ? '从来源系统重新提交，由 Task Agent 核对目标与角色' : '复用工作流，新增独立执行记录'} onClick={async event => {
    event.stopPropagation()
    if (submitting.current) return
    submitting.current = true; setBusy(true)
    try {
      if (mode === 'parameters') {
        const text = window.prompt(`为「${task.title}」输入本次任务参数。不会复用上次的 IP 或登录凭据。`)
        if (!text?.trim()) return
        const next = await api.launchWorkflow(task.id, text.trim(), crypto.randomUUID())
        go(`tasks/${task.id}/runs/${next.batchId}`)
      } else {
        // Keep an ambiguous submission identity across reloads; retry reads the same batch.
        const key='dsh-task-submit:'+task.id
        let requestId=sessionStorage.getItem(key)
        if(!requestId){requestId=crypto.randomUUID();sessionStorage.setItem(key,requestId)}
        const next = await api.fireTask(task.id,'manual',requestId)
        sessionStorage.removeItem(key)
        go(`tasks/${task.id}/runs/${next.runId}`)
      }
      toast('已创建新执行，历史记录保留')
    } catch (error) { toast(error instanceof Error ? error.message : String(error)) }
    finally { submitting.current = false; setBusy(false) }
  }}>{busy ? '正在提交…' : external ? '从来源重试' : scheduled ? '立即执行' : chat ? '＋ 新执行' : '▶ 再跑一次'}</button>
}
import { useRef, useState } from 'react'
