import { resolve } from 'node:path'

/** Serialize API writes to a preset, including directory replacement and sidecars. */
const pending = new Map<string, Promise<unknown>>()
export async function withPresetLock<T>(dir: string, write: () => Promise<T>): Promise<T> {
  const key = resolve(dir)
  const next = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(write)
  pending.set(key, next)
  try { return await next } finally { if (pending.get(key) === next) pending.delete(key) }
}
