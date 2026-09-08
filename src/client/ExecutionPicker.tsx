import type { Batch } from '../wire.ts'
import { executionLabel } from '../execution-label.ts'

export function ExecutionPicker({ batches, value, onChange }: { batches: Batch[]; value: string; onChange: (id: string) => void }) {
  if (batches.length < 2) return null
  return <label className="dtc-execution-picker"><span>执行记录 · 北京时间（UTC+8）</span>
    <select aria-label="执行记录（北京时间）" value={value} title={`完整执行 ID：${value}`} onChange={event => onChange(event.target.value)}>
      {batches.map(batch => <option key={batch.id} value={batch.id} title={batch.id}>{executionLabel(batch)}</option>)}
    </select>
  </label>
}
