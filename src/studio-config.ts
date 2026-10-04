/** Host-owned configuration binding. Never accept a path from Task/model input. */
import {readFile} from 'node:fs/promises'
import {isAbsolute} from 'node:path'

export interface StudioPreviewUploadConfiguration {uploadScript:string;uploadScriptSha256:string;uploadLibrarySha256:string;vaultTokenFile:string;uploadStateRoot:string;uploadPublicOrigins:string[]}
export interface StudioConfigBinding {studioConfigPath?:string}
export const STUDIO_AUDIO_OBSERVER_MODELS=['qwen3-omni-flash','qwen3.8-omni-flash'] as const
/** Audio observation is a host transport choice, not the planner/Task model. */
export function studioAudioObserverModel(config:any):string{
 const model=config.audioObserverModel===undefined?STUDIO_AUDIO_OBSERVER_MODELS[0]:config.audioObserverModel
 if(!STUDIO_AUDIO_OBSERVER_MODELS.includes(model))throw Error('studio-host-config-audio-observer-model-invalid')
 return model
}
/** These paths belong to deployment configuration, never Task/tool arguments. */
export const STUDIO_HOST_EXECUTABLES={
 pythonExecutable:{flag:'--python-executable',environment:'STUDIO_PYTHON_EXECUTABLE'},
 nodeExecutable:{flag:'--node-executable',environment:'STUDIO_NODE_EXECUTABLE'},
 chromeExecutable:{flag:'--chrome-executable',environment:'STUDIO_CHROME_EXECUTABLE'},
 ffmpegExecutable:{flag:'--ffmpeg-executable',environment:'FFMPEG_PATH'},
 ffprobeExecutable:{flag:'--ffprobe-executable',environment:'FFPROBE_PATH'},
} as const
export function studioHostExecutables(config:any):Record<string,string>{
 const selected:Record<string,string>={}
 for(const field of Object.keys(STUDIO_HOST_EXECUTABLES))if(config[field]!==undefined){
  const path=config[field]
  if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))throw Error('studio-host-config-executable-invalid')
  selected[field]=path
 }
 return selected
}
export async function readStudioHostConfiguration(path?:string,legacyUrl=new URL('../studio-host.json',import.meta.url)):Promise<any>{
 const explicit=path!==undefined
 if(explicit&&(typeof path!=='string'||!isAbsolute(path)||path.includes('\0')))throw Error('studio-host-config-path-invalid')
 let value:any
 try{value=JSON.parse(await readFile(explicit?path!:legacyUrl,'utf8'))}
 catch{if(!explicit)return {};throw Error('studio-host-config-unavailable')}
 if(!value||typeof value!=='object'||Array.isArray(value)){
  if(!explicit)return {}
  throw Error('studio-host-config-invalid')
 }
 for(const field of ['dshProfilePath','renderRuntime','assetTokenFile'])if(value[field]!==undefined&&(typeof value[field]!=='string'||!isAbsolute(value[field])||value[field].includes('\0')))throw Error('studio-host-config-binding-invalid')
 studioHostExecutables(value)
 studioAudioObserverModel(value)
 const uploadFields=['uploadScript','uploadScriptSha256','uploadLibrarySha256','uploadStateRoot','uploadPublicOrigins']
 if(uploadFields.some(field=>value[field]!==undefined)){
  const absolute=(v:any)=>typeof v==='string'&&isAbsolute(v)&&!v.includes('\0')
  const hash=(v:any)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
  const origins=value.uploadPublicOrigins
  if(!absolute(value.uploadScript)||!absolute(value.vaultTokenFile)||!absolute(value.uploadStateRoot)||!hash(value.uploadScriptSha256)||!hash(value.uploadLibrarySha256)||!Array.isArray(origins)||!origins.length||origins.some((v:any)=>{try{const u=new URL(v);return typeof v!=='string'||u.protocol!=='https:'||u.origin!==v||Boolean(u.username||u.password)}catch{return true}}))throw Error('studio-host-config-upload-invalid')
 }
 return value
}
