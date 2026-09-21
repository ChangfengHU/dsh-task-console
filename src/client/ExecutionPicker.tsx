import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Batch } from '../wire.ts'
import { executionCode, executionLabel, executionTime } from '../execution-label.ts'
import { go } from './Console.tsx'

const outcome = (batch: Batch) => batch.settled ? ({ done: '已结束 · 已通过', failed: '已结束 · 未通过', cancelled: '已取消' }[batch.settled.outcome] ?? batch.settled.outcome) : '未结束'

export function ExecutionPicker({ batches, value, onChange, onArchive }: { batches: Batch[]; value: string; onChange: (id: string) => void; onArchive?: (id: string, archived: boolean) => Promise<void> }) {
  const [showArchived, setShowArchived] = useState(false)
  const [open, setOpen] = useState<'history' | 'more' | null>(null)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 360, maxHeight: 400 })
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null), opener = useRef<HTMLButtonElement | null>(null)
  const selected = batches.find(batch => batch.id === value)
  const archivedCount = batches.filter(batch => batch.archivedAt).length
  const visible = batches.filter(batch => !batch.archivedAt || showArchived || batch.id === value)
  const taskId = selected?.taskId ?? batches[0]?.taskId
  const toggle = (next: 'history' | 'more', button: HTMLButtonElement) => {
    const box = button.getBoundingClientRect(), width = Math.min(next === 'more' ? 230 : 370, innerWidth - 32)
    const top = Math.max(16, Math.min(box.bottom + 7, innerHeight - 240))
    setPosition({ width, left: Math.max(16, Math.min(box.right - width, innerWidth - width - 16)), top, maxHeight: innerHeight - top - 16 })
    opener.current = button; setError(''); setOpen(open === next ? null : next)
  }
  useEffect(() => { setOpen(null); setError('') }, [value])
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(null) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(null); opener.current?.focus() } }
    const close = () => setOpen(null)
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', key); window.addEventListener('resize', close)
    panel.current?.querySelector<HTMLElement>('button,input')?.focus()
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', key); window.removeEventListener('resize', close) }
  }, [open])
  if (!batches.length) return null
  const container = root.current?.closest('.dtc-root')
  return <div className="dtc-execution-picker" ref={root}>
    <button className="dtc-btn sm dtc-execution-select" aria-label="选择执行记录" aria-haspopup="dialog" aria-expanded={open === 'history'} title={selected ? `${executionLabel(selected)} · 北京时间（UTC+8） · ${selected.id}` : '选择执行记录'} onClick={event => toggle('history', event.currentTarget)}>
      <span>{selected ? `${executionTime(selected.firedAt).slice(5, 16)} · ${outcome(selected)}${selected.archivedAt ? ' · 已归档' : ''}` : '选择执行记录'}</span><span aria-hidden="true">▾</span>
    </button>
    <button className="dtc-btn sm dtc-execution-more" aria-label="执行记录更多操作" aria-haspopup="dialog" aria-expanded={open === 'more'} onClick={event => toggle('more', event.currentTarget)}>⋯</button>
    {open && container ? createPortal(<div ref={panel} className="dtc-execution-popover" role="dialog" aria-label={open === 'history' ? '执行记录选择' : '执行记录操作'} style={position}>
      {open === 'history' ? <>
        <div className="dtc-execution-pophead"><b>执行记录</b><small>北京时间 · UTC+8</small></div>
        {archivedCount ? <label className="dtc-execution-filter"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />显示归档（{archivedCount}）</label> : null}
        <div className="dtc-execution-options">{visible.slice(0, 8).map(batch => <button type="button" key={batch.id} className={batch.id === value ? 'selected' : ''} aria-current={batch.id === value ? 'true' : undefined} title={batch.id} onClick={() => { setOpen(null); onChange(batch.id) }}>
          <span><b>{executionTime(batch.firedAt)}</b><small>{executionCode(batch.id)}{batch.archivedAt ? ' · 已归档' : ''}</small></span><em>{outcome(batch)}</em>
        </button>)}</div>
        {!visible.length ? <p className="dtc-muted">暂无可见执行</p> : null}
        <button className="dtc-btn sm" onClick={() => { setOpen(null); go(`tasks/executions?task=${encodeURIComponent(taskId)}${showArchived ? '&archived=1' : ''}`) }}>查看全部执行记录 →</button>
      </> : <>
        <button className="dtc-btn sm" onClick={() => go(`tasks/executions?task=${encodeURIComponent(taskId)}`)}>查看执行历史</button>
        {selected && onArchive ? <button className="dtc-btn sm" disabled={busy} onClick={async () => {
          if (!selected.archivedAt && !window.confirm('仅隐藏这条执行并停止其后续调度；原始状态、证据、会话和任务定义均保留。正在运行或仍有待执行角色时不能归档。')) return
          setBusy(true); setError('')
          try { await onArchive(selected.id, !selected.archivedAt); setOpen(null); opener.current?.focus() }
          catch (e) { setError(String((e as Error).message || e)) } finally { setBusy(false) }
        }}>{selected.archivedAt ? '恢复显示（不重跑）' : '归档当前执行'}</button> : null}
        {error ? <p role="alert" className="dtc-err">{error}</p> : null}
      </>}
    </div>, container) : null}
  </div>
}
