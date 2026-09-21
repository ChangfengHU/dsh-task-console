import assert from 'node:assert/strict'
import { test } from 'node:test'
import { patchTaskMentions } from '../scripts/patch-task-mentions.mjs'
test('history @ suppression is conditional, idempotent and rejects unknown host code', () => {
  const before = 'const sessions = quoted === true ? Promise.resolve([]) : ctx.remote.sessionReferenceResolver.candidates(session, query);'
  const after = patchTaskMentions(before)
  assert.match(after, /data-dsh-task-entry/)
  assert.equal(patchTaskMentions(after), after)
  assert.throws(() => patchTaskMentions('different host'), /Unsupported/)
  assert.match(after, /sessionReferenceResolver\.candidates/)
})
