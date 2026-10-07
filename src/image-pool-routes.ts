import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {homedir} from 'node:os'
import {ImageUnavailable} from './image-jobs.ts'

export interface ImagePoolRoute {id:string;origin:string;apiKeyEnv:string}
export interface ImagePoolConfig {geminiImagePoolDir?:string;geminiImageRoutes?:ImagePoolRoute[];geminiImageFallback?:ImagePoolRoute|null}
/** Host services only: these are not Tool parameters or Agent configuration. */
export interface ImagePoolHost {
 settings?:{get(namespace:string):unknown}
 credentials?:{resolve(ref:string):Promise<{value:string}|undefined>}
 llm?:{listProviders():{id:string}[]}
}
// Public address only. Each host receives its scoped capability separately;
// no Google or Cloudflare administrator credential is packaged in this plugin.
export const DEFAULT_IMAGE_SERVICE:ImagePoolRoute={id:'cf-image-service',origin:'https://image-api.vyibc.com',apiKeyEnv:'DSH_IMAGE_SERVICE_TOKEN'}
const REF=/^[_A-Z][_A-Z0-9]{0,100}$/
const ID=/^[A-Za-z0-9._-]{1,60}$/
const POOL_ID=/^ag-pool(?:$|[._-][A-Za-z0-9._-]+$)/
type Candidate={id:string;origin:string;key?:string;apiKeyEnv?:string;fallback?:boolean;discovered?:boolean}
function isLoopback(origin:string){return ['127.0.0.1','[::1]'].includes(new URL(origin).hostname)}

function safeOrigin(value:unknown,providerBase=false):string {
 if(typeof value!=='string')throw new ImageUnavailable('账号池通道地址无效')
 let url:URL;try{url=new URL(value)}catch{throw new ImageUnavailable('账号池通道地址无效')}
 const loopback=['127.0.0.1','[::1]'].includes(url.hostname)
 // Model Console stores the model transport base. Only known AG Pool protocol
 // prefixes may be reduced to its origin; arbitrary reverse-proxy paths are not
 // enough evidence that the origin exposes the same authenticated image API.
 const paths=providerBase?['/','/v1','/v1/','/anthropic','/anthropic/','/gemini/v1beta','/gemini/v1beta/']:['/']
 if(url.username||url.password||url.search||url.hash||!paths.includes(url.pathname)||!(url.protocol==='https:'||loopback&&url.protocol==='http:'))throw new ImageUnavailable('远程账号池需要 HTTPS 或私有 loopback 隧道，不接受内嵌凭据或未知 API 路径')
 return url.origin
}

/**
 * Reuse the same host-owned settings/credential seam as the model adapter.
 * Nothing is read from an Agent, session messages, project files, or model
 * output. A named but unresolved credential NEVER falls back to an env value
 * when a credential service exists, matching llm-pi-ai's fail-closed behavior.
 */
function discoverHostPools(host:ImagePoolHost):Candidate[] {
 let section:any,live:Set<string>|undefined
 try{
  section=host.settings?.get('llm-pi-ai')
  if(host.llm)live=new Set(host.llm.listProviders().map(p=>p.id))
 }catch{return []}
 const profiles=section?.providers
 if(!profiles||typeof profiles!=='object'||Array.isArray(profiles))return []
 const routes:Candidate[]=[]
 // Sort for stable precedence, independent of Settings object's insertion order.
 for(const id of Object.keys(profiles).sort()){
  if(routes.length===10)break
  if(!ID.test(id)||!POOL_ID.test(id)||live&&!live.has(id))continue
  const profile=profiles[id]
  if(!profile||typeof profile.apiKeyEnv!=='string'||!REF.test(profile.apiKeyEnv))continue
  try{routes.push({id,origin:safeOrigin(profile.baseURL,true),apiKeyEnv:profile.apiKeyEnv,discovered:true})}catch{/* Unsupported host profiles are not image routes. */}
 }
 return routes
}

async function routeKey(route:Candidate,host:ImagePoolHost):Promise<string|undefined>{
 if(route.key)return route.key
 if(!route.apiKeyEnv)return
 const key=host.credentials?(await host.credentials.resolve(route.apiKeyEnv))?.value:process.env[route.apiKeyEnv]
 return typeof key==='string'&&key.length>0&&key.length<=8192&&!/[\r\n]/.test(key)?key:undefined
}
async function readCatalog(response:Response){
 const reader=response.body?.getReader();if(!reader)throw Error('Empty model catalog')
 const decoder=new TextDecoder();let size=0,text=''
 try{
  while(true){const {done,value}=await reader.read();if(done)break
   size+=value.byteLength;if(size>1024*1024)throw Error('Model catalog too large')
   text+=decoder.decode(value,{stream:true})
  }
  return JSON.parse(text+decoder.decode())
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
}
export async function selectImagePool(config:ImagePoolConfig,model:string,signal:AbortSignal,fetcher:typeof fetch=fetch,host:ImagePoolHost={}){
 signal.throwIfAborted()
 const candidates:Candidate[]=[]
 const dir=config.geminiImagePoolDir||join(homedir(),process.platform==='darwin'?'Library/Application Support/AG Account Pool':'.local/share/ag-account-pool')
 try{
  const runtime=JSON.parse(await readFile(join(dir,'runtime.json'),'utf8'))
  const key=(await readFile(join(dir,'proxy-key'),'utf8')).trim()
  if(Number.isInteger(runtime.port)&&runtime.port>0&&runtime.port<65536&&key&&key.length<=8192&&!/[\r\n]/.test(key))candidates.push({id:'local',origin:`http://127.0.0.1:${runtime.port}`,key})
 }catch{}
 const routes=config.geminiImageRoutes||[]
 if(!Array.isArray(routes)||routes.length>10)throw new ImageUnavailable('账号池通道配置无效')
 const ids=new Set(['local'])
 const fallback=config.geminiImageFallback||DEFAULT_IMAGE_SERVICE
 for(const route of [...routes,fallback]){
  if(!route||typeof route.id!=='string'||!ID.test(route.id)||ids.has(route.id)||typeof route.apiKeyEnv!=='string'||!REF.test(route.apiKeyEnv))throw new ImageUnavailable('账号池通道身份或凭据引用无效')
  ids.add(route.id)
  candidates.push({id:route.id,origin:safeOrigin(route.origin),apiKeyEnv:route.apiKeyEnv,fallback:route===fallback})
 }
 // Explicit operator routes override an identically named discovered profile;
 // the built-in fallback remains last, even when remote auth was configured
 // only through the Models page and no image-specific config was added.
 const last=candidates.pop()!
 for(const route of discoverHostPools(host))if(!ids.has(route.id)){ids.add(route.id);candidates.push(route)}
 candidates.push(last)
 // Host-profile loopback auth is also usable when the pool uses a custom data
 // directory. Prefer loopback transport before remote transport; do not claim
 // that a configured loopback tunnel necessarily runs on this physical host.
 const rank=(route:Candidate)=>route.fallback?5:route.id==='local'?0:isLoopback(route.origin)?route.discovered?2:1:route.discovered?4:3
 candidates.sort((a,b)=>rank(a)-rank(b))
 const probed=new Set<string>()
 for(const route of candidates){
  signal.throwIfAborted()
  try{
   const key=await routeKey(route,host)
   signal.throwIfAborted()
   if(!key)continue
   // This dedup identity is operation-local, never persisted or exposed.
   const identity=route.origin+'\0'+key
   if(probed.has(identity))continue
   probed.add(identity)
   const probe=AbortSignal.any([signal,AbortSignal.timeout(route.fallback?30000:5000)])
   // Discovery authenticates/read-probes only. Generation pins this chosen
   // backend; an uncertain submitted request is never retried on another one.
   for(const protocol of route.fallback?['images-v1'] as const:['images-v1','gemini-v1beta'] as const){
    const response=await fetcher(route.origin+(protocol==='images-v1'?'/images/v1/models':'/gemini/v1beta/models'),{headers:{'x-goog-api-key':key,authorization:'Bearer '+key},signal:probe,redirect:'error'})
    if(!response.ok){await response.body?.cancel();continue}
    const catalog=await readCatalog(response)
    if(Array.isArray(catalog.models)&&catalog.models.some((m:any)=>m?.name==='models/'+model))return {id:route.id,origin:route.origin,key,fallback:route.fallback,protocol,reason:route.fallback?'cf-fallback-authenticated':route.id==='local'?'local-authenticated-model-available':isLoopback(route.origin)?'host-loopback-authenticated-model-available':route.discovered?'remote-provider-authenticated-model-available':'remote-authenticated-model-available'}
   }
  }catch{signal.throwIfAborted()}
 }
 throw new ImageUnavailable('没有已认证且提供指定图片模型的账号池通道')
}
