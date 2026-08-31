/**
 * Host Typert manifest, exported as `./typert` so the harness registers the
 * `taskConsole` invocations when this plugin mounts.
 *
 * @module dsh-task-console/typert
 */

import { CONSOLE_INVOCATIONS, PKG } from './wire.ts'

export const TYPERT = Object.freeze({
  package: PKG,
  face: 'host',
  schemas: Object.freeze([]),
  invocations: CONSOLE_INVOCATIONS,
  model: Object.freeze({
    services: Object.freeze([]),
    events: Object.freeze([]),
    objects: Object.freeze([]),
  }),
})
