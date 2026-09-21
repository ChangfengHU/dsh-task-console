/** Whether a stored event needs its original streamed tool identity. */
export function hasLegacyEmptyToolId(event) {
  const data = event?.data
  if (event?.type === 'tool/call') return data?.callId === ''
  if (event?.type === 'tool/result') return data?.message?.source?.callId === ''
  if (event?.type === 'assistant/message') return data?.message?.content?.some?.(block => block?.type === 'tool-call' && block.id === '') === true
  if (event?.type === 'assistant/chunk') return (data?.chunk?.type === 'tool-call-delta' && data.chunk.id === '')
    || (data?.chunk?.type === 'block-end' && data.chunk.block?.type === 'tool-call' && data.chunk.block.id === '')
  return false
}

/** Reconstruct empty IDs in a detached read, using stream IDs and explicit result links.
 * No log writes or guessed tool results. Unprovable identities still fail validation.
 */
export function restoreHistoryToolIds(events) {
  if (!events.some(hasLegacyEmptyToolId)) return events
  const steps = new Map()
  const calls = new Map()
  const fail = seq => { throw new Error(`Cannot restore empty tool identity at event ${seq}: missing or ambiguous stream/source evidence`) }
  return events.map(event => {
    const data = event?.data
    if (!data || !['assistant/chunk','assistant/message','tool/call','tool/result'].includes(event.type)) return event
    const key = JSON.stringify([data.turn, data.step])
    let step = steps.get(key)
    if (!step) { step = { blocks: new Map(), planned: [] }; steps.set(key, step) }
    if (event.type === 'assistant/chunk') {
      const chunk = data.chunk
      if (chunk?.type === 'block-start') step.blocks.set(chunk.index, { type: chunk.blockType, id: '', name: '', arguments: '' })
      if (chunk?.type === 'tool-call-delta') {
        const prior = step.blocks.get(chunk.index) ?? { type: 'tool-call', id: '', name: '', arguments: '' }
        const block = { ...prior, id: chunk.id || prior.id, name: chunk.name || prior.name, arguments: prior.arguments + (chunk.argumentsDelta ?? '') }
        step.blocks.set(chunk.index, block)
        if (chunk.id === '' && block.id) return { ...event, data: { ...data, chunk: { ...chunk, id: block.id } } }
      }
      if (chunk?.type === 'block-end') {
        let block = chunk.block
        if (block?.type === 'tool-call' && block.id === '') {
          const original = step.blocks.get(chunk.index)
          if (!original?.id || original.name !== block.name) fail(event.seq)
          block = { ...block, id: original.id }
        }
        step.blocks.set(chunk.index, block)
        if (block !== chunk.block) return { ...event, data: { ...data, chunk: { ...chunk, block } } }
      }
      return event
    }
    if (event.type === 'assistant/message') {
      const candidates = [...step.blocks.entries()].sort((a,b) => a[0]-b[0]).map(([,block]) => block).filter(block => block?.type === 'tool-call')
      const used = new Set()
      const message = data.message
      if (!Array.isArray(message?.content)) return event
      const content = message.content.map(block => {
        if (block?.type !== 'tool-call' || block.id !== '') return block
        const index = candidates.findIndex((candidate,i) => !used.has(i) && candidate.id && candidate.name === block.name && candidate.arguments === block.arguments)
        if (index < 0) fail(event.seq)
        used.add(index)
        return { ...block, id: candidates[index].id }
      })
      step.planned = content.filter(block => block?.type === 'tool-call').map(block => ({ ...block, claimed: false }))
      if (new Set(step.planned.map(block => block.id)).size !== step.planned.length) fail(event.seq)
      return content.some((block,i) => block !== message.content[i]) ? { ...event, data: { ...data, message: { ...message, content } } } : event
    }
    if (event.type === 'tool/call') {
      const planned = step.planned.find(block => !block.claimed && block.name === data.name && block.arguments === data.arguments && (data.callId === '' || block.id === data.callId))
      if (planned) planned.claimed = true
      if (data.callId !== '') return event
      if (!planned?.id) fail(event.seq)
      calls.set(event.seq, { id: planned.id, key })
      return { ...event, data: { ...data, callId: planned.id } }
    }
    if (data.message?.source?.callId !== '') return event
    const sources = event.sourceEventSeqs
    const call = sources?.length === 1 ? calls.get(sources[0]) : undefined
    const message = data.message
    const block = message.content?.[0]
    if (!call || call.key !== key || sources[0] >= event.seq || message.source.kind !== 'tool'
      || message.content?.length !== 1 || block?.type !== 'tool-result' || block.toolCallId !== '') fail(event.seq)
    return { ...event, data: { ...data, message: { ...message, source: { ...message.source, callId: call.id }, content: [{ ...block, toolCallId: call.id }] } } }
  })
}
