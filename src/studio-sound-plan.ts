import {posix} from 'node:path'
import type {FrozenDialogue} from './studio-storyboard-script.js'
const object=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v)
const HASH=/^[a-f0-9]{64}$/i
export function soundPlanError(field:string,reason:string):never {
 throw Error('studio-sound-plan-invalid: '+JSON.stringify({error_code:'studio-sound-plan-invalid',field,reason,retryAfterRepair:true,action:'Read studio_status.state.script. Register one sound-plan-v1 JSON with scriptSha256 and arrays lines, bgm, sfx. Preserve all frozen line ids/text/order. Copy every required audio source into this sound stage directory and list it in manifest.outputs. Use sourcePath (or path for music/effects) referencing that registered file. Measure real duration and hash; repair and register again. Do not remove required music/effects merely to pass validation. Binding is not listening or quality approval.'}))
}
/** Bind declared sources to host-probed files. Playback/mixing and licenses need separate QA. */
export function bindSoundPlan(plan:any,script:FrozenDialogue,outputs:any[],planFile:{path:string;sha256:string}) {
 if(!object(plan)||plan.schema!=='sound-plan-v1')soundPlanError('schema','Expected sound-plan-v1.')
 if(!script||!HASH.test(script.sha256??'')||!Array.isArray(script.lines)||!script.lines.length||new Set(script.lines.map(l=>l.id)).size!==script.lines.length)soundPlanError('frozen_script','A valid frozen script is required.')
 if(plan.scriptSha256!==script.sha256)soundPlanError('scriptSha256','Frozen script differs.')
 for(const key of ['lines','bgm','sfx'])if(!Array.isArray(plan[key]))soundPlanError(key,'Explicit array required; empty music/effects arrays mean none declared.')
 if(plan.lines.length!==script.lines.length||plan.lines.some((l:any,i:number)=>!object(l)||l.id!==script.lines[i].id||l.text!==script.lines[i].text))soundPlanError('lines','Frozen line ids, exact text and order must match.')
 const files=new Map(outputs.map(o=>[o.path,o])),tracks:any[]=[]
 for(const [key,role] of [['lines','voice'],['bgm','bgm'],['sfx','sfx']]) {
  if(plan[key].length>1000)soundPlanError(key,'Too many cues.')
  plan[key].forEach((cue:any,index:number)=>{
   const field=`${key}[${index}]`
   if(!object(cue)||typeof cue.id!=='string'||!cue.id.trim())soundPlanError(field,'Nonempty cue id required.')
   if(!Number.isFinite(cue.start)||!Number.isFinite(cue.end)||cue.start<0||cue.end<=cue.start)soundPlanError(field,'Require finite 0 <= start < end.')
   const source=cue.sourcePath??(role==='voice'?undefined:cue.path)
   if(typeof source!=='string'||!source||source.includes('\\')||source.includes('\0')||source.includes(':')||posix.isAbsolute(source)||source.split('/').includes('..'))soundPlanError(field,'Invalid local audio source reference.')
   // When sourcePath exists, path may be a later edit destination; only the source is delivered here.
   const file=files.get(posix.normalize(source))
   if(!file||file.media?.kind!=='audio'||!HASH.test(file.sha256??'')||!Number.isFinite(file.media.durationSeconds)||file.media.durationSeconds<=0)soundPlanError(field,'Source must match a registered, host-probed audio output of this stage.')
   if(role==='voice'&&(file.media.durationSeconds>8||cue.end-cue.start>8+1e-9))soundPlanError(field,'Speech source and final span must each be <= 8 seconds for the current observer. Request studio_request_preparation_revision with this plan as evidence if the frozen utterance needs restructuring; do not truncate words or silently rewrite it.')
   if(cue.sourceSha256!==undefined&&cue.sourceSha256!==file.sha256)soundPlanError(field,'Declared source hash differs from host hash.')
   // 50 ms allows container rounding; it does not assert cue playback coverage or spoken content.
   if(cue.sourceDurationSeconds!==undefined&&(!Number.isFinite(cue.sourceDurationSeconds)||cue.sourceDurationSeconds<=0||Math.abs(cue.sourceDurationSeconds-file.media.durationSeconds)>0.05))soundPlanError(field,'Declared source duration differs from probe by more than 50 ms.')
   tracks.push({role,index,id:cue.id,path:file.path,sha256:file.sha256,media:file.media})
  })
 }
 return {schema:'studio-sound-binding-v1',scriptSha256:script.sha256,plan:{path:planFile.path,sha256:planFile.sha256},tracks,qualityApproved:false}
}
