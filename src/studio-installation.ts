/** Startup installation checks; no provider requests or credential reads. */
import {access,lstat,readFile,realpath} from 'node:fs/promises'
import {constants} from 'node:fs'
import {isAbsolute,dirname,join} from 'node:path'
import {createHash} from 'node:crypto'
import contract from './studio-installation-contract.json'
import {readStudioHostConfiguration,STUDIO_HOST_EXECUTABLES,studioAudioObserverModel} from './studio-config.js'

const absolute=(v:unknown):v is string=>typeof v==='string'&&isAbsolute(v)&&!v.includes('\0')
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')

export async function inspectStudioInstallation(config:any){
 const issues:string[]=[]
 const file=async(field:string,path:unknown,expected?:unknown)=>{
  if(!absolute(path)){issues.push(field+':missing-or-invalid-path');return}
  try{
   const info=await lstat(path)
   if(!info.isFile()||info.isSymbolicLink())throw Error('not-regular')
   await access(path,constants.R_OK)
   if(expected!==undefined&&(!digest(expected)||sha(await readFile(path))!==expected))issues.push(field+':hash-mismatch')
  }catch{issues.push(field+':unavailable')}
 }
 config=config&&typeof config==='object'&&!Array.isArray(config)?config:{}
 try{studioAudioObserverModel(config)}catch{issues.push('audioObserverModel:invalid')}
 for(const [field,rule] of Object.entries(contract.helpers)){
  const hashField='hashField' in rule?rule.hashField:undefined
  if(hashField&&!digest(config[hashField]))issues.push(hashField+':missing-or-invalid-hash')
  await file(field,config[field],hashField?config[hashField]:undefined)
 }
 for(const [field,rule] of Object.entries(contract.libraries)){
  if(!digest(config[field]))issues.push(field+':missing-or-invalid-hash')
  if(absolute(config[rule.parentField]))await file(field,join(dirname(config[rule.parentField]),rule.file),config[field])
 }
 // Metadata/read permission only. Never read token or profile contents.
 for(const field of contract.hostFiles)await file(field,config[field])
 if(config.assetTokenFile!==undefined){
  await file('assetTokenFile',config.assetTokenFile)
  if(absolute(config.assetTokenFile))try{const info=await lstat(config.assetTokenFile);if((info.mode&0o077)||info.size>4096||process.getuid&&info.uid!==process.getuid())issues.push('assetTokenFile:not-private')}catch{}
 }
 for(const field of contract.hostDirectories){
  const path=config[field]
  if(!absolute(path)){issues.push(field+':missing-or-invalid-path');continue}
  try{
   const info=await lstat(path)
   if(!info.isDirectory()||info.isSymbolicLink())throw Error('not-directory')
   await access(path,constants.R_OK|(field==='renderRuntime'?0:constants.W_OK))
   if(field!=='renderRuntime'&&(info.mode&0o077))issues.push(field+':not-private')
  }catch{issues.push(field+':unavailable')}
 }
 if(absolute(config.renderRuntime))for(const member of contract.rendererFiles){
  if(member==='node_modules/ffmpeg-static/ffmpeg'&&config.ffmpegExecutable!==undefined)continue
  await file('renderRuntime/'+member,join(config.renderRuntime,member))
 }
 // Trusted system executable symlinks are normal on macOS. Resolve only these
 // host-owned paths; project files and credential references remain strict.
 for(const field of Object.keys(STUDIO_HOST_EXECUTABLES))if(config[field]!==undefined){
  if(!absolute(config[field])){issues.push(field+':missing-or-invalid-path');continue}
  try{const path=await realpath(config[field]);if(!(await lstat(path)).isFile())throw Error('not-file');await access(path,constants.R_OK|constants.X_OK)}
  catch{issues.push(field+':unavailable')}
 }
 const origins=config.uploadPublicOrigins
 if(!Array.isArray(origins)||!origins.length||origins.some((v:unknown)=>{
  try{const u=new URL(v as string);return typeof v!=='string'||u.protocol!=='https:'||u.origin!==v||!!(u.username||u.password)}catch{return true}
 }))issues.push('uploadPublicOrigins:missing-or-invalid')
 return {ready:issues.length===0,issues,scope:'local-installation-only',providerVerified:false,qualityApproved:false}
}

/** Return an actionable capability block before session/model creation. */
export async function studioInstallationBlock(deps:{config?:any;configPath?:string}={}){
 try{
  const result=await inspectStudioInstallation(deps.config??await readStudioHostConfiguration(deps.configPath))
  if(!result.ready)return {kind:'capability' as const,reason:'studio-host-installation-incomplete: '+result.issues.join('; ')}
 }catch(error){
  const code=error instanceof Error&&/^studio-host-config-[a-z-]+$/.test(error.message)?error.message:'studio-host-installation-check-failed'
  return {kind:'capability' as const,reason:code}
 }
}
