import type { GraphEventRow } from '../graph-data.ts'
import { ArtifactDelivery } from './ArtifactDelivery.tsx'
import { PatrolEvidence } from './PatrolEvidence.tsx'

/** A separate route, using the same execution/projection as the workflow. */
export function ExecutionReport({ title, label, historicalStep, events, delivery, onBack }: {
  title: string; label: string; historicalStep: number | null; events: GraphEventRow[]
  delivery: Parameters<typeof ArtifactDelivery>[0]; onBack: () => void
}) {
  return <section className="dtc-execution-report" aria-label="执行报告页面">
    <header><button className="dtc-btn sm" onClick={onBack}>← 返回工作流</button><div><span>执行报告</span><h1>{title}</h1><small>{label} · 北京时间</small></div></header>
    <main className="dtc-report-body">
      {historicalStep !== null ? <p role="status" className="dtc-report-snapshot">正在查看回放第 {historicalStep} 步的报告和证据，不包含后续结果。返回工作流可继续回放或切回实时。</p> : null}
      <ArtifactDelivery {...delivery} />
      <PatrolEvidence events={events} />
    </main>
  </section>
}
