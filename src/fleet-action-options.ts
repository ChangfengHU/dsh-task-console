import { isAbsolute, dirname, join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ActionParameter } from './agent-actions.ts'
import type { ActionOption } from './action-options.ts'

const reads = new Map<string, { at: number; promise: Promise<any> }>()
function cachedRead(key: string, read: () => Promise<any>) {
  const previous = reads.get(key)
  if (previous && Date.now() - previous.at < 5000) return previous.promise
  const entry = { at: Infinity, promise: Promise.resolve().then(read).then(value => { entry.at = Date.now(); return value }) }
  reads.set(key, entry)
  if (reads.size > 60) reads.delete(reads.keys().next().value!)
  entry.promise.catch(() => { if (reads.get(key) === entry) reads.delete(key) })
  return entry.promise
}

/** Optional adapter to the deployed browser MCP's own read/policy modules.
 * Only host-owned composition paths are used. Action JSON cannot supply modules,
 * URLs, headers or tool names. No SSH, discovery refresh, verification or copy.
 */
export async function fleetActionOptions(config: Record<string, unknown>, p: ActionParameter, values: Record<string, unknown>, load?: (name: string) => Promise<any>): Promise<{ items: ActionOption[]; notice: string }> {
  const entry = (Array.isArray(config.args) ? config.args : []).find(v => typeof v === 'string' && isAbsolute(v) && basename(v) === 'server.mjs')
  if (!entry) throw Error('此部署尚未配置 Fleet 只读候选适配器；仍可手填机器 IP')
  const module = load ?? ((name: string) => import(pathToFileURL(join(dirname(entry), name + '.mjs')).href))
  const [{ request }, { policy }] = await Promise.all([module('transport'), module('runtime')])
  const grants = await policy()
  const get = (path: string, authenticated = false) => load ? request(path, null, authenticated) : cachedRead(`${entry}:${path}`, () => request(path, null, authenticated))
  if (p.source === 'fleet.nodes') {
    const [{ browserInventory }, data] = await Promise.all([module('inventory'), get('/api/fleet')])
    const inventory = browserInventory(data, grants)
    return { items: inventory.nodes.filter((n: any) => n.ip && n.readAuthorized).map((n: any) => ({ value: n.ip, label: n.ip, detail: `${n.nodeId} · ${n.reachable ? '在线' : '不可达'} · 浏览器 ${n.browsers.length}` })), notice: '只读名册；也可手填新机器 IP。选择不代表已有操作权限。' }
  }
  if (p.source !== 'fleet.gemini-accounts') throw Error('未注册的候选来源')
  const ip = String(values[p.dependsOn?.[0] ?? ''] ?? '')
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) || ip.split('.').some(v => Number(v) > 255)) throw Error('请先填写具体目标机器 IP')
  if (grants.nodes?.[ip]?.read !== true) throw Error('目标尚无浏览器只读授权；请保留自动分配方式，由 Agent 检查授权')
  const { rankLoginSources } = await module('login')
  // Reuse account exclusions/admission from the MCP. No invented target instance:
  // this is intent authoring, not a recommendation/authorization for a transfer.
  const accounts: any[] = []
  let pages = 1
  for (let page = 1; page <= pages; page++) {
    const data = await get(`/api/fleet/login-accounts?view=discovered&pageSize=100&page=${page}`, true)
    if (data.ok !== true || !Array.isArray(data.rows) || !Number.isInteger(data.pages) || data.pages < 0 || data.pages > 50) throw Error('账号发现记录暂不可用')
    pages = data.pages; accounts.push(...data.rows)
  }
  const ranked = rankLoginSources(accounts, grants, { ip })
  return {
    items: ranked.filter((c: any) => c.authorized && !c.reasons.includes('account-excluded') && c.label && c.sourceIp && Number.isInteger(c.sourceInstance)).map((c: any) => ({
      value: `${c.label} · ${c.sourceIp} / browser-${c.sourceInstance} · #${c.fingerprint}`,
      label: c.label, detail: `${c.sourceIp} · browser-${c.sourceInstance} · ${c.eligible ? '已验证' : c.reasons.length === 1 && c.reasons[0] === 'source-not-currently-verified' ? '待执行前复验' : c.reasons.join('、')}`,
      // A stale observation may express a requested account, never permission to
      // transfer it. Busy/sharing-limit/unknown identities remain unavailable.
      disabled: c.reasons.some((r: string) => r !== 'source-not-currently-verified'),
    })),
    notice: '读取既有发现记录，不主动刷新或复制。待复验账号也可指定为意图，不代表当前可用；执行时 Agent 必须重验来源和逐实例授权。',
  }
}
