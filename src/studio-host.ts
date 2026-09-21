import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type { StudioWorkflow } from './studio-workflow.js'

// Deployment-owned evidence, never a model-supplied task field or per-film QA file.
async function configuration(): Promise<any> {
  try { return JSON.parse(await readFile(new URL('../studio-host.json',import.meta.url),'utf8')) }
  catch { return {} }
}
export async function refreshStudioCapabilities(workflow:StudioWorkflow, task:any) {
  const config=await configuration(), entry=config.tasks?.[task.id]
  if(!entry || entry.referenceSha256!==task.design?.studio?.referenceSha256 || entry.characterId!==task.design?.studio?.characterId) return
  for(const proof of entry.capabilities??[]) workflow.recordCapability(task,proof)
}
export async function observeStudioAudio(task:any, args:{wavPath:string,start:number,end:number}) {
  const config=await configuration()
  if(!config.audioScript || !config.vaultTokenFile) throw Error('studio-audio-host-not-configured')
  return new Promise<any>((resolve,reject)=>{
    const child=spawn('python3',[config.audioScript,args.wavPath,'--start-seconds',String(args.start),'--end-seconds',String(args.end)],{env:{...process.env,STUDIO_PROJECT_ROOT:task.cwd,STUDIO_VAULT_TOKEN_FILE:config.vaultTokenFile},stdio:['ignore','pipe','ignore']})
    let output='',overflow=false
    const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('studio-audio-observation-timeout'))},180000)
    child.stdout.on('data',b=>{output+=b.toString();if(output.length>100000){overflow=true;child.kill('SIGTERM')}})
    child.on('error',()=>{clearTimeout(timer);reject(Error('studio-audio-subprocess-unavailable'))})
    child.on('close',code=>{clearTimeout(timer);if(code!==0||overflow)return reject(Error('studio-audio-observation-failed'));try { const result=JSON.parse(output);if(!result.ok||result.input_modality!=='input_audio')throw Error();resolve(result) } catch {reject(Error('studio-audio-observation-invalid'))}})
  })
}
