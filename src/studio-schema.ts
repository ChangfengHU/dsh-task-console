/** Explicit typed RPC registration for an absolute-path, isolated deployment.
 * Schema only: this plugin never creates another TaskRunner or database.
 */
import { TYPERT } from './typert.host.js'
export const name='studio-task-schema'
export const inject=['typert']
export function apply(ctx:any){ ctx.typert.register(TYPERT) }
