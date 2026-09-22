import type { TurnLedger } from './fold.ts'

/** Page model steps, not turns: a single long Agent turn must also stay bounded. */
export function ledgerPage(ledger: TurnLedger, requested: number): TurnLedger {
  if (!Number.isSafeInteger(requested) || requested < 1) throw new Error('Invalid Trace page')
  const rows = ledger.turns.flatMap(turn => turn.steps.length ? turn.steps.map(step => ({ turn, step })) : [{ turn, step: undefined }])
  const pages = Math.max(1, Math.ceil(rows.length / 10)), page = Math.min(requested, pages)
  const turns: TurnLedger['turns'] = []
  for (const { turn, step } of rows.slice((page - 1) * 10, page * 10)) {
    let current = turns.at(-1)
    if (!current || current.turn !== turn.turn) { current = { ...turn, steps: [] }; turns.push(current) }
    if (step) current.steps.push(step)
  }
  return { ...ledger, turns, pagination: { page, pages, total: rows.length } }
}
