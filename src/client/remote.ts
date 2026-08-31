import { CONSOLE_INVOCATIONS, PKG } from '../wire.ts'

/** Mounted through `ctx.remote.$mount` in the client plugin body. */
export const CONSOLE_REMOTE = Object.freeze({ package: PKG, descriptors: CONSOLE_INVOCATIONS })

export function unwrap<T>(result: { ok: boolean; value?: T; error?: { code: string; message: string } }, method: string): T {
  if (!result.ok) throw new Error(`${result.error?.message ?? result.error?.code ?? method}`)
  return result.value as T
}
