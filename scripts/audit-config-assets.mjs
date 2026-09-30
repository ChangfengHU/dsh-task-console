/** Read-only source audit. Does not load a live SQLite store or execute an Agent.
 * Run with the source host's DSH_HOME and node --import tsx. No configuration
 * bodies, transport credentials or generated transfer keys are printed. */
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import YAML from 'yaml'
import {TaskConsoleService} from '../src/service.ts'
import {encodeEnvelope,parseEnvelope,sealConfig,openConfig} from '../src/config-migration.ts'

const base=process.env.DSH_AUDIT_URL??'http://127.0.0.1:3080'
async function rpc(method,payload){
 const r=await fetch(`${base}/api/taskConsole/${method}`,{method:'POST',headers:{'content-type':'application/json',origin:new URL(base).origin},signal:AbortSignal.timeout(30000),body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:`taskConsole/${method}`,payload:{args:payload?{payload:JSON.stringify(payload)}:{}}})})
 const b=await r.json();if(!r.ok||!b.result?.ok)throw Error(`Audit RPC ${method} failed`)
 return typeof b.result.value==='string'?JSON.parse(b.result.value):b.result.value
}
const agents=await rpc('agents'),listing=await rpc('tasks'),catalog=await rpc('catalog')
const taskActions=new Map()
for(let offset=0;offset<listing.tasks.length;offset+=6)await Promise.all(listing.tasks.slice(offset,offset+6).map(async t=>taskActions.set(t.id,(await rpc('taskActions',{taskId:t.id})).actions)))
const profile=join(process.env.DSH_HOME??'/home/claude/.dsh','profiles','web','cordis.patch.yml')
const patch=YAML.parse(await readFile(profile,'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:s=>s}]})
const entries=[]
function walk(rows){for(const e of rows??[]){if(e.id&&e.name)entries.push({options:e,disabled:e.disabled===true});walk(e.insert)}}walk(patch)
const ctx={loader:{entries:()=>entries},tools:{schemas:()=>[]},get:key=>key==='agentPresets'?{list:async()=>agents}:key==='llm'?{listProviders:()=>[],listModels:async()=>[]}:key==='agentDefaultModel'?{currentSelection:()=>catalog.defaultModel}:undefined}
const service=Object.create(TaskConsoleService.prototype)
Object.defineProperty(service,'ctx',{value:ctx});service.ready=Promise.resolve()
service.runner={store:{tasks:new Map(listing.tasks.map(t=>[t.id,t]))}}
service.creator={actions:{exportDefinition:id=>taskActions.get(id)??[]}}
service.hostMcp=()=>catalog.mcp.map(m=>({...m,config:entries.find(e=>e.options.id===(m.sourceEntryId??m.entryId))?.options.config??{},live:!m.disabled}))
const envelope=await service.configurationEnvelope(),bytes=encodeEnvelope(envelope)
const sealed=sealConfig(envelope),restored=openConfig(JSON.parse(sealed.data.toString()),sealed.fragment)
if(restored.digest.value!==envelope.digest.value||parseEnvelope(JSON.parse(bytes.toString())).digest.value!==envelope.digest.value)throw Error('Configuration audit round-trip mismatch')
console.log(JSON.stringify({readOnly:true,version:envelope.source.version,agents:envelope.payload.agents.length,tasks:envelope.payload.tasks.length,agentActions:envelope.payload.agents.reduce((n,a)=>n+a.actions.length,0),taskActions:envelope.payload.tasks.reduce((n,t)=>n+t.actions.length,0),skillBindings:envelope.payload.assets.skills.length,hostConfigs:envelope.payload.assets.hostConfigs.length,plaintextBytes:bytes.length,encryptedBytes:sealed.data.length,digest:envelope.digest.value,roundTrip:true}))
