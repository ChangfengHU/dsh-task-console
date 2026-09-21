/** Host-owned policy. Tool arguments cannot choose credentials, commands or endpoints. */
import { readFile, lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

export const proxyIp = z.string().regex(/^(?:[1-9]\d{0,2}|0)(?:\.(?:[1-9]\d{0,2}|0)){3}$/).refine(value => {
  const [a,b,...rest] = value.split('.').map(Number)
  return [a,b,...rest].every(n=>n<=255) && ![0,10,127].includes(a) && a<224 &&
    !(a===169&&b===254) && !(a===172&&b>=16&&b<=31) && !(a===192&&b===168) && !(a===100&&b>=64&&b<=127)
}, 'public-ip-required')
const path = z.string().refine(isAbsolute, 'absolute-path-required')
export const proxyPolicySchema = z.object({
  version: z.literal(1), principal: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  stateDir: path, knownHostsFile: path,
  vaultOrigin: z.string().url().refine(s=>{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'}, 'https-origin-required'),
  vaultTokenFile: path, sshResolveTokenFile: path,
  sshResolveTokenKey: z.literal('FLEET_ONBOARD_VAULT_RESOLVE_TOKEN').optional(),
  nodes: z.array(z.object({ ip: proxyIp, lineId: z.string().regex(/^line-[a-zA-Z0-9_-]{1,48}$/),
    repair: z.boolean().default(false) }).strict()).max(1000),
}).strict().refine(p=>new Set(p.nodes.map(n=>n.ip)).size===p.nodes.length, 'duplicate-node')
export type ProxyPolicy = z.infer<typeof proxyPolicySchema>
export async function privateFile(path: string): Promise<string> {
  const s=await lstat(path)
  if(!s.isFile() || s.isSymbolicLink() || s.uid!==process.getuid?.() || (s.mode&0o077)) throw new Error('private-file-required')
  return readFile(path,'utf8')
}
export async function loadProxyPolicy(path: string): Promise<ProxyPolicy> {
  if(!isAbsolute(path)) throw new Error('absolute-policy-path-required')
  return proxyPolicySchema.parse(JSON.parse(await privateFile(path)))
}
export function authorizeProxy(policy: ProxyPolicy|undefined, ip: string, repair=false) {
  const node=policy?.nodes.find(n=>n.ip===ip)
  if(!node || (repair&&!node.repair)) throw new Error('proxy-scope-denied')
  return node
}
