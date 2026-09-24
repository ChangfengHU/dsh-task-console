/** Portable authored role definitions. Loading does not install, grant tools or probe providers. */
import {readFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {readSpec,validateSpec} from './presets.js'
import type {AgentSpec} from './wire.js'
import {canonical} from './capability-contract.js'
import {REQUIRED_PLANNING_SKILLS,REQUIRED_PRODUCTION_SKILLS,REQUIRED_REVIEW_SKILLS,REQUIRED_STAGE_SKILLS} from './studio-skill-gate.js'
import {STUDIO_TOOL_NAMES} from './studio-tools.js'
import {STUDIO_SPEECH_TOOL_NAMES} from './studio-speech-tools.js'
import {STUDIO_BOARD_TOOL_NAMES} from './studio-board-tools.js'
export const STUDIO_ROLE_IDS=['director','storyboard','visual','sound','editor','quality'] as const
export type StudioPackRole=typeof STUDIO_ROLE_IDS[number]
const TASK_ROLES={director:'planner',storyboard:'studio-stage',visual:'studio-stage',sound:'studio-stage',editor:'executor',quality:'reviewer'} as const
const REQUIRED_SKILLS={director:REQUIRED_PLANNING_SKILLS,storyboard:REQUIRED_STAGE_SKILLS.storyboard,visual:REQUIRED_STAGE_SKILLS.visual,sound:REQUIRED_STAGE_SKILLS.sound,editor:REQUIRED_PRODUCTION_SKILLS,quality:REQUIRED_REVIEW_SKILLS}
const NATIVE:Record<StudioPackRole,string[]>={director:['fs-text','fs-search','web','studio-runtime'],storyboard:['fs-text','fs-search','studio-runtime'],visual:['bash','fs-text','fs-search','jobs','studio-runtime'],sound:['bash','fs-text','fs-search','jobs','web','studio-runtime'],editor:['bash','fs-text','fs-search','jobs','studio-runtime'],quality:['studio-runtime']}
const ASSET_READ=['library_info','character_get','character_assets','character_search','asset_search','asset_get']
const IMAGE=['vyibc-image_generate_image','vyibc-image_get_task','vyibc-image_list_results']
const VOICE=['vyibc-voice_resolve_voice','vyibc-voice_capabilities','vyibc-voice_list_voices','vyibc-voice_get_voice','vyibc-voice_check_config','vyibc-voice_synthesize','vyibc-voice_status','vyibc-voice_result','vyibc-voice_retry_segments']
const sorted=(values:string[])=>[...new Set(values)].sort()
const fail=(code:string):never=>{throw Error('studio-role-pack-invalid:'+code)}
export interface StudioRoleTemplate {role:StudioPackRole;taskRole:typeof TASK_ROLES[StudioPackRole];spec:AgentSpec;sha256:string;requiredHostTools:string[]}
export interface StudioRolePack {schema:'studio-role-pack-v1';version:string;roles:StudioRoleTemplate[];requiredSkills:string[];requiredMcp:Record<string,string[]>;requiredHostCapabilities:string[];installed:false;runtimeVerified:false;publishingGranted:false}
export async function loadStudioRolePack(root=fileURLToPath(new URL('../studio/roles',import.meta.url))):Promise<StudioRolePack>{
 const bytes=await readFile(join(root,'manifest.json'));if(bytes.length>64*1024)fail('manifest-size')
 let m:any;try{m=JSON.parse(bytes.toString('utf8'))}catch{fail('manifest-json')}
 if(m?.schema!=='studio-role-pack-v1'||m.version!=='1.0.0'||!Array.isArray(m.roles)||m.roles.length!==6||m.installed!==false||m.runtimeVerified!==false||m.publishingGranted!==false)fail('manifest-contract')
 const knownHost=new Set<string>([...STUDIO_TOOL_NAMES,...STUDIO_SPEECH_TOOL_NAMES,...STUDIO_BOARD_TOOL_NAMES]),roles:StudioRoleTemplate[]=[],seen=new Set<string>(),agentIds=new Set<string>()
 for(const row of m.roles){
  const role=row.role as StudioPackRole
  if(!STUDIO_ROLE_IDS.includes(role)||seen.has(role)||row.taskRole!==TASK_ROLES[role]||row.path!==role+'/task-console.json'||!/^[a-f0-9]{64}$/.test(row.sha256??''))fail('role-entry')
  seen.add(role);const path=join(root,row.path),bytes=await readFile(path)
  if(bytes.length>64*1024||createHash('sha256').update(bytes).digest('hex')!==row.sha256)fail('template-integrity')
  let raw:any;try{raw=JSON.parse(bytes.toString('utf8'))}catch{fail('template-json')}
  const spec=validateSpec(raw),read=await readSpec(dirname(path))
  if(!read||canonical(spec)!==canonical(raw)||canonical(read)!==canonical(spec)||spec.id!==row.agentId||agentIds.has(spec.id))fail('authored-spec')
  agentIds.add(spec.id)
  if(spec.model!==''||spec.effort!==''||spec.permissionPreset!=='workspace-write'||Object.keys(spec.mcpPolicy).length||canonical(sorted(spec.tools))!==canonical(sorted(NATIVE[role])))fail('public-grants')
  if(REQUIRED_SKILLS[role].some(s=>!spec.skills.includes(s))||!Array.isArray(row.requiredHostTools)||!row.requiredHostTools.length||row.requiredHostTools.some((t:any)=>typeof t!=='string'||!knownHost.has(t)))fail('required-contract')
  const expectedMcp:Record<string,string[]>={}
  if(!['editor','quality'].includes(role))expectedMcp['vyibc-cartoon-assets']=ASSET_READ.filter(t=>role==='director'||t!=='character_search')
  if(role==='visual')expectedMcp['vyibc-image']=IMAGE
  if(role==='sound')expectedMcp['vyibc-voice']=VOICE
  const ordered=(m:Record<string,string[]>)=>Object.fromEntries(Object.entries(m).map(([server,tools])=>[server,sorted(tools)]))
  if(canonical(ordered(spec.mcpTools))!==canonical(ordered(expectedMcp)))fail('mcp-grants')
  roles.push({role,taskRole:row.taskRole,spec,sha256:row.sha256,requiredHostTools:[...row.requiredHostTools]})
 }
 const requiredSkills=sorted(roles.flatMap(r=>r.spec.skills)),requiredMcp:Record<string,string[]>={}
 for(const role of roles)for(const [server,tools] of Object.entries(role.spec.mcpTools))requiredMcp[server]=sorted([...(requiredMcp[server]??[]),...tools])
 if(canonical(requiredSkills)!==canonical(m.requiredSkills)||canonical(requiredMcp)!==canonical(m.requiredMcp)||!Array.isArray(m.requiredHostCapabilities)||!m.requiredHostCapabilities.length||m.requiredHostCapabilities.some((x:any)=>typeof x!=='string'||!/^[a-z][a-z-]+$/.test(x)))fail('dependency-manifest')
 return {schema:m.schema,version:m.version,roles,requiredSkills,requiredMcp,requiredHostCapabilities:[...m.requiredHostCapabilities],installed:false,runtimeVerified:false,publishingGranted:false}
}
export interface StudioDependencyInventory {skills?:string[];mcpTools?:Record<string,string[]>;hostTools?:string[];hostCapabilities?:string[];defaultModelAvailable?:boolean}
/** A supplied inventory is a discovery observation only, never credentials or a live smoke test. */
export function inspectStudioRoleDependencies(pack:StudioRolePack,inventory:StudioDependencyInventory={}){
 const checks:{kind:string;id:string;status:'present-in-inventory'|'missing'|'unverified'}[]=[]
 const check=(kind:string,id:string,list?:string[])=>checks.push({kind,id,status:list===undefined?'unverified':list.includes(id)?'present-in-inventory':'missing'})
 for(const id of pack.requiredSkills)check('skill',id,inventory.skills)
 for(const [server,tools] of Object.entries(pack.requiredMcp))for(const tool of tools)check('mcp-tool',server+'/'+tool,inventory.mcpTools===undefined?undefined:(inventory.mcpTools[server]??[]).map(t=>server+'/'+t))
 for(const id of sorted(pack.roles.flatMap(r=>r.requiredHostTools)))check('host-tool',id,inventory.hostTools)
 for(const id of pack.requiredHostCapabilities)check('host-capability',id,inventory.hostCapabilities)
 checks.push({kind:'model',id:'inherited-default-or-private-setup-binding',status:inventory.defaultModelAvailable===undefined?'unverified':inventory.defaultModelAvailable?'present-in-inventory':'missing'})
 return {checks,missing:checks.filter(c=>c.status==='missing'),unverified:checks.filter(c=>c.status==='unverified'),inventoryComplete:checks.every(c=>c.status==='present-in-inventory'),installed:false,runtimeVerified:false,qualityApproved:false,notice:'Inventory presence does not prove authorization, provider health, current Task tool registration or film quality. Setup must resolve private transport/model bindings and verify host dependencies; no installation or overwrite has occurred.'}
}
