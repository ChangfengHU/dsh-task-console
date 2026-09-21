/** Serial polling: hidden tabs pause; teardown never schedules another request. */
export function serialPoll(load: () => Promise<boolean | void>, interval: number, env = {
  hidden: () => document.hidden,
  schedule: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
  cancel: (id: number) => window.clearTimeout(id),
}) {
  let stopped = false
  let timer: number | undefined
  const tick = async () => {
    if (stopped) return
    let again = true
    try { if (!env.hidden()) again = (await load()) !== false }
    finally { if (!stopped && again) timer = env.schedule(() => { void tick() }, interval) }
  }
  void tick()
  return () => { stopped = true; if (timer !== undefined) env.cancel(timer) }
}
