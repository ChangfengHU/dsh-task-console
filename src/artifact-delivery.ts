import type { Artifact, Batch, Card } from './fold.ts'

export interface ArtifactActor {
  cardId: string
  role?: Card['role']
  round?: number
  name: string
  decision?: 'approved' | 'changes'
}

export type DeliveryArtifact = Omit<Artifact, 'storagePath'> & { storagePath?: string }

export interface ArtifactGroup {
  sha256: string
  primary: DeliveryArtifact
  entries: DeliveryArtifact[]
  actors: ArtifactActor[]
  round?: number
  final: boolean
  finalSource?: Artifact['finalSource']
  decision?: ArtifactActor['decision']
  publicUrl?: string
}

const byTime = (a: DeliveryArtifact, b: DeliveryArtifact) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

/**
 * Old completed batches predate artifact/finalized. Give them one clearly
 * labelled compatibility selection, preferring the latest executor delivery
 * over the reviewer's byte-identical verification snapshot.
 */
export function withFinalArtifact(artifacts: Artifact[], cards: Iterable<Card>, batch?: Batch): Artifact[] {
  const rows = artifacts.map(artifact => ({ ...artifact }))
  if (rows.some(artifact => artifact.final) || batch?.settled?.outcome !== 'done') return rows
  const cardById = new Map([...cards].map(card => [card.id, card]))
  const ranked = [...rows].sort((a, b) => {
    const ac = cardById.get(a.cardId); const bc = cardById.get(b.cardId)
    const ar = ac?.role === 'executor' ? 1 : 0; const br = bc?.role === 'executor' ? 1 : 0
    return ar - br || (ac?.round ?? 0) - (bc?.round ?? 0) || byTime(a, b)
  })
  const selected = ranked.at(-1)
  if (selected) { selected.final = true; selected.finalSource = 'compatibility'; selected.finalizedAt = batch.settled.at }
  return rows
}

/** One card per immutable byte version; repeated reviewer registration becomes verification metadata. */
export function groupArtifacts(artifacts: DeliveryArtifact[], actors: ArtifactActor[]): ArtifactGroup[] {
  const actorByCard = new Map(actors.map(actor => [actor.cardId, actor]))
  const buckets = new Map<string, DeliveryArtifact[]>()
  for (const artifact of artifacts) buckets.set(artifact.sha256, [...(buckets.get(artifact.sha256) ?? []), artifact])
  return [...buckets.values()].map(entries => {
    entries.sort(byTime)
    const actorRows = entries.map(entry => actorByCard.get(entry.cardId)).filter(Boolean) as ArtifactActor[]
    const final = entries.find(entry => entry.final)
    const executor = [...entries].reverse().find(entry => actorByCard.get(entry.cardId)?.role === 'executor')
    const primary = final ?? executor ?? entries.at(-1)!
    const decision = [...actorRows].reverse().find(actor => actor.role === 'reviewer' && actor.decision)?.decision
    return {
      sha256: primary.sha256,
      primary,
      entries,
      actors: actorRows,
      round: Math.max(0, ...actorRows.map(actor => actor.round ?? 0)) || undefined,
      final: entries.some(entry => entry.final),
      finalSource: final?.finalSource,
      decision,
      publicUrl: [...entries].reverse().find(entry => entry.publicUrl)?.publicUrl,
    }
  }).sort((a, b) => byTime(a.primary, b.primary))
}

export function finalArtifact(groups: ArtifactGroup[]): ArtifactGroup | undefined {
  return groups.find(group => group.final)
}
