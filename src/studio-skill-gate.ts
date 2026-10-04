import {createHash} from 'node:crypto'
import {studioStageFor,type StudioStageId} from './studio-stages.js'

export const REQUIRED_PRODUCTION_SKILLS=['hyperframes','hyperframes-core','studio-character-workflow'] as const
/** Matches the authored Taskbook specialists; not every stage installs HyperFrames
 * or vyibc-image. Character design supplies the visual generation instructions. */
export const REQUIRED_STAGE_SKILLS:Record<StudioStageId,readonly string[]>={
 storyboard:['studio-director','studio-character-workflow'],
 visual:['studio-character-workflow','vyibc-character-design'],
 sound:['voice-production','studio-music','studio-materials'],
}
export function requiredStudioSkills(input:any):readonly string[]{
 if(input.task?.design?.evidenceContract!=='studio-video-v1')return []
 if(input.card?.role==='executor')return REQUIRED_PRODUCTION_SKILLS
 if(input.card?.role!=='studio-stage')return []
 const stage=studioStageFor(input)
 if(!stage)throw Error('studio-skill-stage-identity-required')
 return REQUIRED_STAGE_SKILLS[stage.id]
}
const READ_ONLY=new Set(['skill','read','glob','grep','studio_status','studio_read_text','studio_character_image','studio_reference_frames','studio_reference_audio','studio_preview_image','studio_preview_frames','studio_preview_audio','session_capabilities','environment_capabilities','job_list','job_output','job_kill','task_block','task_notify'])
const READ_MCP=/(?:^|__|_)(?:character_get|character_assets|character_search|asset_get|asset_search|library_info|project_get|get_task|list_results)$/

/** Workflow guard, not an OS sandbox or proof of comprehension/film quality. */
export function registerStudioSkillGate(ctx:any,options:{input:any;isActive:()=>boolean;record:(receipt:any)=>void}){
 const {input}=options
 const required=requiredStudioSkills(input)
 if(!required.length)return()=>{}
 if(typeof ctx.tools?.guard!=='function'||typeof ctx.on!=='function')throw Error('studio-skill-gate-capability-required')
 const loaded=new Set<string>()
 const sameSession=(exec:any)=>exec.agent?.session?.id===input.sessionId
 const stopResult=ctx.on('tools/result',(exec:any,result:any)=>{
  if(!options.isActive()||!sameSession(exec)||exec.name!=='skill'||result?.isError===true)return
  const name=exec.arguments?.name
  if(!required.includes(name)||typeof exec.callId!=='string'||!exec.callId)return
  const text=(result?.content??[]).filter((b:any)=>b.type==='text'&&typeof b.text==='string').map((b:any)=>b.text).join('\n')
  // A catalog entry, failed lookup, or model assertion is not loaded instructions.
  if(!text.includes('<skill_instructions>')||!text.includes('</skill_instructions>')||!text.includes(`<skill_content name="${name}">`))return
  options.record({name,sha256:createHash('sha256').update(text).digest('hex'),bytes:Buffer.byteLength(text),callId:exec.callId})
  loaded.add(name)
 })
 const stopGuard=ctx.tools.guard((exec:any)=>{
  if(!sameSession(exec))return 'studio-skill-gate-session-mismatch'
  if(!options.isActive())return 'studio-skill-gate-stale-run'
  if(READ_ONLY.has(exec.name)||READ_MCP.test(exec.name))return
  const missing=required.filter(name=>!loaded.has(name))
  if(missing.length)return `studio-required-skills-not-loaded: before production or shell execution, actually call skill with each JSON argument ${missing.map(name=>JSON.stringify({name})).join(', ')}. These installed instructions must be returned successfully in this session. Do not invent another path or treat this as permission denial. Loading is not quality approval.`
 })
 return()=>{stopGuard();stopResult()}
}
