import { createHash } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { hasLegacyEmptyToolId, restoreHistoryToolIds } from './restore-history-tool-ids.mjs'

/** Display-only identity for old empty IDs; raw log values remain untouched. */
export function legacyToolContextId(event, callId, result = false) {
  if (callId !== '') return String(callId)
  if (!result) return `legacy-empty-tool:${event.seq}`
  const sources = event.sourceEventSeqs
  if (sources?.length === 1 && Number.isSafeInteger(sources[0]) && sources[0] >= 0 && sources[0] < event.seq) {
    return `legacy-empty-tool:${sources[0]}`
  }
  // Missing or ambiguous evidence stays an orphan result, never a guessed pair.
  return `legacy-empty-result:${event.seq}`
}

function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Unrecognized DSH history/stream bundle; no patch applied')
  return source.replace(before, after)
}

export function patchToolHistoryBundle(source, trajectory = false) {
  if (source.includes('function legacyToolContextId(')
    && source.includes('id: legacyToolContextId(event, event.data.callId)')
    && source.includes('id: legacyToolContextId(event, event.data.message.source.callId, true)')) return source
  const anchor = trajectory ? 'const trajectoryToolDefinition = {' : 'const toolDefinition = {'
  let next = replaceOne(source, anchor, `${legacyToolContextId.toString()}\n\t\t${anchor}`)
  next = replaceOne(next, 'id: String(event.data.callId),\n\t\t\t\t\trole: "start"', 'id: legacyToolContextId(event, event.data.callId),\n\t\t\t\t\trole: "start"')
  return replaceOne(next, 'id: String(event.data.message.source.callId),\n\t\t\t\t\trole: "update"', 'id: legacyToolContextId(event, event.data.message.source.callId, true),\n\t\t\t\t\trole: "update"')
}

export function patchDeepseekStream(source) {
  const guard = 'if (typeof call.id === "string" && call.id.length > 0) block.callId = call.id;'
  const reject = 'if (block.kind === "tool-call" && !block.callId) throw new LlmError("tool response ended without a call id", "MALFORMED_RESPONSE");'
  if (source.includes(guard) && source.includes(reject)) return source
  const next = replaceOne(source, 'if (call.id !== void 0) block.callId = call.id;', guard)
  return replaceOne(next, 'function closeBlock(block) {\n', `function closeBlock(block) {\n\t${reject}\n`)
}

export function patchHistoryPersistence(source) {
  if (source.includes('function restoreHistoryToolIds(') && source.includes('if (hasLegacyEmptyToolId(event)) return true;')) return source
  let next = replaceOne(source, 'function needsLegacyPrefix(event) {', `${hasLegacyEmptyToolId.toString()}\n${restoreHistoryToolIds.toString()}\nfunction needsLegacyPrefix(event) {\n\tif (hasLegacyEmptyToolId(event)) return true;`)
  for (const name of ['snapshotStoredEvents', 'adoptStoredEvents']) {
    next = replaceOne(next, `function ${name}(events, id) {`, `function ${name}(events, id) {\n\tevents = restoreHistoryToolIds(events);`)
  }
  return next
}

/** Validate every target before writes. Backups contain code only, never sessions. */
export async function patchHistoryIds(dshRoot, { dryRun = false } = {}) {
  const manifest = JSON.parse(await readFile(join(dshRoot, 'package.json'), 'utf8'))
  if (manifest.version !== '0.1.1-rc.2') throw new Error(`Unsupported DSH history patch version: ${manifest.version}`)
  const packages = join(dshRoot, 'node_modules', '@deepseek-ai')
  const specs = [
    ['dsh-client-ui-conversation', 'client.js', source => patchToolHistoryBundle(source)],
    ['dsh-client-ui-trajectory', 'client.js', source => patchToolHistoryBundle(source, true)],
    ['dsh-llm-deepseek', 'index.js', patchDeepseekStream],
    ['dsh-session-persistence', 'index.js', patchHistoryPersistence],
  ]
  const changes = []
  for (const [name, file, transform] of specs) {
    const path = join(packages, name, 'lib', file)
    const original = await readFile(path, 'utf8')
    const next = transform(original)
    if (next !== original) changes.push({ name, path, original, next })
  }
  if (!dryRun) for (const { path, original, next } of changes) {
    const hash = createHash('sha256').update(original).digest('hex').slice(0,16)
    try { await writeFile(`${path}.history-ids-${hash}.bak`, original, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    await writeFile(`${path}.history-ids-next`, next)
    await rename(`${path}.history-ids-next`, path)
  }
  return changes.map(change => change.name)
}
