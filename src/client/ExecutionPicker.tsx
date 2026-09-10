import { useState } from 'react'
import type { Batch } from '../wire.ts'
import { executionLabel } from '../execution-label.ts'

export function ExecutionPicker({ batches, value, onChange, onArchive }: { batches: Batch[]; value: string; onChange: (id: string) => void; onArchive?: (id: string, archived: boolean) => Promise<void> }) {
  const [showArchived, setShowArchived] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const archivedCount = batches.filter(batch => batch.archivedAt).length
  const selected = batches.find(batch => batch.id === value)
  if (!batches.length) return null
  return <div className="dtc-execution-picker"><span>执行记录 · 北京时间（UTC+8）</span>
    <select aria-label="执行记录（北京时间）" value={value} title={`完整执行 ID：${value}`} onChange={event => onChange(event.target.value)}>
      {!value ? <option value="" disabled>没有当前执行</option> : null}
      {batches.filter(batch => !batch.archivedAt || showArchived || batch.id === value).map(batch => <option key={batch.id} value={batch.id} title={batch.id}>{executionLabel(batch)}{batch.archivedAt ? ' · 已归档' : ''}</option>)}
    </select>
    {archivedCount ? <button className="dtc-btn sm" onClick={() => setShowArchived(!showArchived)}>{showArchived ? '隐藏归档' : `显示归档（${archivedCount}）`}</button> : null}
    {selected && onArchive ? <button className="dtc-btn sm" disabled={busy} onClick={async () => {
      if (!selected.archivedAt && !window.confirm('仅隐藏这条执行并停止其后续调度；原始状态、证据、会话和任务定义均保留。正在运行或仍有待执行角色时不能归档。')) return
      setBusy(true); setError('')
      try { await onArchive(selected.id, !selected.archivedAt) } catch (e) { setError(String((e as Error).message || e)) } finally { setBusy(false) }
    }}>{selected.archivedAt ? '恢复显示（不重跑）' : '归档此执行'}</button> : null}
    {error ? <small role="alert" className="dtc-err">{error}</small> : null}
  </div>
}
