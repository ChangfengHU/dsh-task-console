import {constants} from 'node:fs'
import {lstat,open,realpath} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
export interface StudioCharacterProfileLock {path:string;sha256:string;characterId:string;profileVersion?:number}
const MAX_BYTES=2*1024*1024
const repairAction='Request host preflight repair of the saved character profile. Do not read arbitrary hidden files or relabel a live character_get response as the frozen profile.'
class CharacterProfileError extends Error {constructor(readonly reason:string){super('studio-character-profile-invalid: '+JSON.stringify({reason,action:repairAction}))}}
const failure=(reason:string):never=>{throw new CharacterProfileError(reason)}
export function characterProfileFallback(characterId:unknown){return {available:false,frozen:false,characterId:typeof characterId==='string'?characterId:null,lookup:typeof characterId==='string'&&characterId?{tool:'character_get',arguments:{character_id:characterId}}:null,notice:'Legacy/missing host profile lock. Use the granted character_get MCP with the exact character_id shown, resolving its actual namespaced tool name from current schemas. That live response is not the host-frozen profile; primary-image asset ID is not the personality profile.'}}
export async function readStudioCharacterProfile(task:any,lock:StudioCharacterProfileLock){
 if(!lock||typeof lock.path!=='string'||!/^[a-f0-9]{64}$/i.test(lock.sha256??'')||typeof lock.characterId!=='string'||lock.characterId!==task.design?.studio?.characterId)failure('lock_or_character_identity')
 if(lock.profileVersion!==undefined&&(!Number.isInteger(lock.profileVersion)||lock.profileVersion<1))failure('profile_version')
 let handle:Awaited<ReturnType<typeof open>>|undefined
 try{
  const root=await realpath(task.cwd),directory=join(root,'.studio-host'),path=join(directory,'character.json')
  if(resolve(lock.path)!==path||await realpath(directory)!==directory||(await lstat(directory)).isSymbolicLink()||await realpath(path)!==path||(await lstat(path)).isSymbolicLink())failure('locked_path_only')
  handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  const stat=await handle.stat();if(!stat.isFile()||stat.size<1||stat.size>MAX_BYTES)failure('size_or_file_type')
  const bytes=Buffer.alloc(MAX_BYTES+1);let length=0
  while(length<bytes.length){const chunk=await handle.read(bytes,length,bytes.length-length,null);if(!chunk.bytesRead)break;length+=chunk.bytesRead}
  if(length<1||length>MAX_BYTES)failure('size_or_file_type')
  const body=bytes.subarray(0,length),sha256=createHash('sha256').update(body).digest('hex')
  if(sha256!==lock.sha256)failure('sha256_mismatch')
  let data:any;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body))}catch{failure('utf8_or_json')}
  if(!data||typeof data!=='object'||Array.isArray(data)||data.character_id!==lock.characterId||!data.profile||typeof data.profile!=='object'||Array.isArray(data.profile))failure('character_json_identity_or_profile')
  if(data.profile_version!==undefined&&(!Number.isInteger(data.profile_version)||data.profile_version<1)||lock.profileVersion!==undefined&&data.profile_version!==lock.profileVersion)failure('profile_version')
  const after=await handle.stat();if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)failure('file_changed_during_read')
  return {characterId:lock.characterId,profileVersion:data.profile_version??null,sha256,bytes:length,data,frozen:true,scope:'host-locked-character-profile',qualityApproved:false}
 }catch(error:any){if(error instanceof CharacterProfileError)throw error;failure('locked_file_unavailable')}finally{await handle?.close()}
}
export async function studioCharacterProfileSummary(task:any,lock?:StudioCharacterProfileLock){
 if(!lock)return characterProfileFallback(task.design?.studio?.characterId)
 try{
 const value=await readStudioCharacterProfile(task,lock)
 return {available:true,frozen:true,characterId:value.characterId,profileVersion:value.profileVersion,sha256:value.sha256,bytes:value.bytes,read:{tool:'studio_character_profile',arguments:{}},notice:'Read the complete locked character_get JSON for personality, scenes, expressions and voice recommendation. This is the current verified host lock, not a claim of batch-wide immutable versioning or generated-asset coverage.'}
 }catch(error){return {available:false,hasFrozenLock:true,readable:false,frozen:false,qualityApproved:false,error:{code:'studio-character-profile-invalid',reason:error instanceof CharacterProfileError?error.reason:'locked_file_unavailable',action:repairAction}}}
}
