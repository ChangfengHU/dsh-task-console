/** An explicit, reviewable Agent decision contract; not executable JavaScript. */
export interface TaskDesign {
  scope: string
  branches: { id: string; when: string; action: string; evidence: string }[]
  coordination: string
  failurePolicy: { isolateItems: boolean; maxAttempts: number; stopConditions: string[] }
  acceptance: string[]
}

export function validateDesign(value: unknown): TaskDesign {
  const d = value as TaskDesign
  const text = (v: unknown, name: string) => {
    if (typeof v !== 'string' || !v.trim() || v.length > 4000) throw new Error(`计划 ${name} 必须是非空文本（最多4000字符）`)
    return v.trim()
  }
  const list = (v: unknown, name: string) => {
    if (!Array.isArray(v) || !v.length || v.length > 16) throw new Error(`计划 ${name} 需要1至16项`)
    return v.map(x => text(x, name))
  }
  if (!d || !Array.isArray(d.branches) || !d.branches.length || d.branches.length > 16) throw new Error('计划 design.branches 需要1至16个有证据要求的条件分支')
  const branches = d.branches.map(b => {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(b?.id)) throw new Error('分支 id 需使用短英文编码')
    return { id: b.id, when: text(b.when, 'when'), action: text(b.action, 'action'), evidence: text(b.evidence, 'evidence') }
  })
  if (new Set(branches.map(b => b.id)).size !== branches.length) throw new Error('分支 id 不能重复')
  if (typeof d.failurePolicy?.isolateItems !== 'boolean' || !Number.isInteger(d.failurePolicy.maxAttempts) || d.failurePolicy.maxAttempts < 1 || d.failurePolicy.maxAttempts > 3)
    throw new Error('failurePolicy 需要 isolateItems 和 1至3 的 maxAttempts；它不授权重复有副作用的操作')
  return { scope: text(d.scope, 'scope'), branches, coordination: text(d.coordination, 'coordination'),
    failurePolicy: { isolateItems: d.failurePolicy.isolateItems, maxAttempts: d.failurePolicy.maxAttempts, stopConditions: list(d.failurePolicy.stopConditions, 'stopConditions') },
    acceptance: list(d.acceptance, 'acceptance') }
}
