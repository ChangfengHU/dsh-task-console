import type { GraphSnapshot } from '../graph-data.ts'

/** Append canonical pages; never fill gaps with inferred events or another run. */
export function appendGraphPage(previous: GraphSnapshot | null, page: GraphSnapshot): GraphSnapshot {
  if (!page.eventPage) return page // older host
  const cursor = previous?.events.at(-1)?.id ?? 0
  if (page.eventPage.after !== cursor || (previous && previous.graphId !== page.graphId)) throw new Error('Graph event cursor mismatch')
  if (page.events.some((e, i) => e.graph_id !== page.graphId || e.id <= (i ? page.events[i - 1].id : cursor))) throw new Error('Graph events out of order')
  if (page.eventPage.hasMore && page.eventPage.next <= cursor) throw new Error('Graph event cursor did not advance')
  return { ...page, events: [...(previous?.events ?? []), ...page.events] }
}
