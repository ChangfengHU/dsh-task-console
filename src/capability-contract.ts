/** Configuration evidence, not an execution or aesthetic approval. No credentials. */
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {parse} from 'yaml'
export const CAPABILITY_LOCK='capabilities.lock.json'
export const CAPABILITY_SCHEMA='dsh-capability-contract-v1'
const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
export function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().filter(k=>(value as any)[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical((value as any)[k])).join(',')+'}'
 return JSON.stringify(value)
}
export function compositionTools(yml:string):string[]{
 const mark='- id: inherited-tool-fence\n',at=yml.lastIndexOf(mark)
 if(at<0)throw Error('capability-fence-missing')
 const rows=parse(yml.slice(at)),selected=rows?.[0]?.config?.selected
 if(!Array.isArray(selected)||selected.some((s:unknown)=>typeof s!=='string'))throw Error('capability-fence-invalid')
 return [...new Set<string>(selected)].sort()
}
export interface CapabilityContract {
 schema:typeof CAPABILITY_SCHEMA;agentId:string;specSha256:string;compositionSha256:string;contractSha256:string
 native:{id:string;tools:string[]}[];mcp:{server:string;sourceEntryId?:string;tools:string[];available:boolean}[]
 skills:string[];allowedTools:string[];missing:string[];scope:'configuration-only';requiresNewSession:true
}
/** Called by the same render that emits the actual Agent fence. */
export function capabilityContract(spec:any,yml:string,nativeRows:readonly any[],hosts:readonly any[]):CapabilityContract {
 const native=spec.tools.map((id:string)=>({id,tools:[...(nativeRows.find(n=>n.id===id)?.schemaNames??[])].sort()}))
 const missing:string[]=[]
 const mcp=Object.entries(spec.mcpTools as Record<string,string[]>).sort(([a],[b])=>a.localeCompare(b)).map(([server,selected])=>{
  const host=hosts.find(h=>h.serverName===server),tools=[...new Set(selected.includes('*')?(host?.tools??[]):selected)].sort() as string[]
  const available=host?.live===true&&tools.length>0&&tools.every(t=>host?.tools?.includes(t))
  if(!available)missing.push(`mcp:${server}:${!host?'missing':!host.live?'disabled':!tools.length?'no-tools':tools.filter(t=>!host.tools?.includes(t)).join(',')}`)
  return {server,...(host?.sourceEntryId?{sourceEntryId:host.sourceEntryId}:{}),tools,available}
 })
 const content={schema:CAPABILITY_SCHEMA,agentId:spec.id,specSha256:hash(canonical(spec)),native,mcp,skills:[...spec.skills].sort(),allowedTools:compositionTools(yml)}
 return {...content,compositionSha256:hash(yml),contractSha256:hash(canonical(content)),missing,scope:'configuration-only',requiresNewSession:true}
}
export async function inspectCapabilityContract(dir:string,expected:CapabilityContract){
 let yml:string
 try{yml=await readFile(join(dir,'agent.cordis.yml'),'utf8')}catch{return {ready:false,status:'composition-missing',missingTools:expected.allowedTools,unexpectedTools:[],scope:'configuration-only',liveVerified:false}}
 let actual:string[]=[];try{actual=compositionTools(yml)}catch{}
 let saved:CapabilityContract|undefined;try{saved=JSON.parse(await readFile(join(dir,CAPABILITY_LOCK),'utf8'))}catch{}
 const missingTools=expected.allowedTools.filter(t=>!actual.includes(t)),unexpectedTools=actual.filter(t=>!expected.allowedTools.includes(t))
 const currentSha256=hash(yml),locallyModified=!!saved&&saved.compositionSha256!==currentSha256
 const status=locallyModified?'local-edit':missingTools.length||unexpectedTools.length?'tool-drift':expected.missing.length?'dependency-missing':!saved?'unverified-legacy':saved.schema!==CAPABILITY_SCHEMA||saved.contractSha256!==expected.contractSha256?'contract-drift':'in-sync'
 return {ready:status==='in-sync',status,missingTools,unexpectedTools,missingDependencies:expected.missing,compositionSha256:currentSha256,expectedContractSha256:expected.contractSha256,savedContractSha256:saved?.contractSha256??null,scope:'configuration-only',liveVerified:false,requiresNewSession:status!=='in-sync',repair:status==='local-edit'?'Review and merge local composition edits before regeneration.':'Regenerate from the current authored spec; then verify in a new real Agent session.'}
}
