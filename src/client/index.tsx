/**
 * Browser half: one sidebar footer button that opens the console as a
 * full-page overlay; the URL hash carries which screen is open.
 *
 * @module dsh-task-console/client
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentRow, AgentSpec, Catalog, Preview, TryRunResult } from '../wire.ts'
import { Console, HASH_PREFIX, go, readRoute, type Api } from './Console.tsx'
import { CONSOLE_REMOTE, unwrap } from './remote.ts'
import { installStyles } from './styles.ts'

export const name = 'dsh-task-console'
export const inject = ['slots', 'remote']

export async function apply(ctx: any): Promise<void> {
  ctx.effect(() => installStyles(), 'task-console: stylesheet')
  await ctx.remote.$mount(CONSOLE_REMOTE)

  const call = async <T,>(method: string, payload?: unknown): Promise<T> => {
    const service = ctx.get('remote.taskConsole')
    const result = payload === undefined ? await service[method]() : await service[method](JSON.stringify(payload))
    return JSON.parse(unwrap<string>(result, method)) as T
  }
  const api: Api = {
    catalog: () => call<Catalog>('catalog'),
    agents: () => call<AgentRow[]>('agents'),
    previewAgent: (spec: AgentSpec) => call<Preview>('previewAgent', spec),
    saveAgent: (spec: AgentSpec) => call<{ path: string; preview: Preview }>('saveAgent', spec),
    deleteAgent: async (id: string) => { await call('deleteAgent', { id }) },
    tryRun: (id: string) => call<TryRunResult>('tryRun', { id }),
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'task-console',
    order: 30,
    inject: () => ({ api }),
  }, FooterEntry))
}

/** The sidebar button plus the overlay it opens (portaled to body). */
function FooterEntry({ api, wide }: { api: Api; wide?: boolean }) {
  const [open, setOpen] = useState(readRoute().length > 0 || window.location.hash.startsWith(HASH_PREFIX))
  useEffect(() => {
    const on = () => setOpen(window.location.hash.startsWith(HASH_PREFIX))
    window.addEventListener('hashchange', on)
    on()
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const narrow = wide === false
  return (
    <>
      <button type="button" className={`dtc-foot ${narrow ? 'narrow' : ''}`} title="任务台" aria-label="任务台" onClick={() => go('agents')}>
        <span className="ic">▦</span>{narrow ? null : <span>任务台</span>}
      </button>
      {open ? createPortal(<Console api={api} />, document.body) : null}
    </>
  )
}
