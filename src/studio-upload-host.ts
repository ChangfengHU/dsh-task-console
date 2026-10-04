/** Host-only R2 preview bridge. This module never publishes to social platforms. */
import {createHash,randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {copyFile,mkdir,mkdtemp,open,readFile,realpath,rename,rm,stat} from 'node:fs/promises'
import {constants} from 'node:fs'
import {isAbsolute,join,relative,sep,extname,dirname} from 'node:path'
import {readStudioHostConfiguration} from './studio-config.js'
import {fileSha256,studioPath} from './studio-tools.js'
const HASH=/^[a-f0-9]{64}$/
const MAX_BYTES=500_000_000
export interface RegisteredStudioPreview {
 candidate:{sha256:string;manifestSha256:string;revision:number}
 location:{path:string;manifestPath:string;sha256:string}
}
export interface StudioPreviewUploadDependencies {
 config?:any;configPath?:string
 execute?:(script:string,args:string[])=>Promise<any>
 /** Re-check the active producer/session immediately before the durable reservation and dispatch. */
 assertActive:()=>void
}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
const inside=(root:string,path:string)=>{const r=relative(root,path);return !r||!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep)}
function unknown(intentId:string){return {ok:false,state:'unknown',intentId,qualityApproved:false,socialPublished:false,nextAction:'The original preview upload may have written R2 bytes. Preserve this intent; call this tool with the same SHA to perform read-only public reconciliation. A missing or temporarily unavailable object stays unknown. Do not rename files, change keys or resubmit to bypass this state.'}}
async function durableJson(path:string,value:any){const f=await open(path,'wx',0o600);try{await f.writeFile(JSON.stringify(value));await f.sync()}finally{await f.close()}}
async function syncDirectory(path:string){const f=await open(path,'r');try{await f.sync()}finally{await f.close()}}
function receipt(result:any,expected:{sha256:string;bytes:number},origins:string[]){
 if(result?.sha256!==expected.sha256||result?.bytes!==expected.bytes||result?.public_hash_verified!==true||!['single_put','multipart','verified_existing'].includes(result?.upload_mode))throw Error('studio-upload-receipt-invalid')
 let url:URL;try{url=new URL(result.url)}catch{throw Error('studio-upload-receipt-invalid')}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!origins.includes(url.origin)||!url.pathname.endsWith(`/studio-dsh/${expected.sha256}/preview.mp4`))throw Error('studio-upload-receipt-invalid')
 return {url:url.href,sha256:expected.sha256,bytes:expected.bytes,publicHashVerified:true,uploadMode:result.upload_mode}
}
async function execute(script:string,args:string[]):Promise<any>{
 return new Promise((resolve,reject)=>{
  const env:Record<string,string>={};for(const k of ['PATH','HOME','LANG','LC_ALL','TMPDIR'])if(process.env[k])env[k]=process.env[k]!
  const child=spawn('python3',[script,...args],{env,stdio:['ignore','pipe','ignore']});let output='',done=false
  const finish=(error?:Error,result?:any)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result)}
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('studio-upload-host-timeout'))},900_000)
  child.on('error',()=>finish(Error('studio-upload-host-unavailable')))
  child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>64_000){child.kill('SIGKILL');finish(Error('studio-upload-host-output-invalid'))}})
  child.on('close',code=>{try{const result=JSON.parse(output);if(code!==0&&result?.ok!==false)throw Error();finish(undefined,result)}catch{finish(Error('studio-upload-host-output-invalid'))}})
 })
}
/**
 * registered MUST be obtained from workflow.status().candidate + candidateLocation(),
 * never from model arguments. Caller enforces producer/card/round authorization.
 * Only candidateSha256 is model supplied; there is no arbitrary file/key/URL option.
 * uploadStateRoot must be durable host storage outside every model task workspace.
 * A durable reservation prevents automatic redispatch even after a host restart.
 */
export async function uploadStudioPreview(task:{id:string;cwd:string},registered:RegisteredStudioPreview,args:{candidateSha256:string},deps:StudioPreviewUploadDependencies){
 deps.assertActive()
 if(!args||Object.keys(args).some(k=>k!=='candidateSha256')||!HASH.test(args.candidateSha256??''))throw Error('studio-upload-candidate-sha-required')
 const c=registered?.candidate,l=registered?.location
 if(!c||!l||c.sha256!==args.candidateSha256||l.sha256!==c.sha256||!HASH.test(c.manifestSha256??'')||!Number.isInteger(c.revision)||c.revision<1||typeof task.id!=='string'||!task.id)throw Error('studio-upload-current-candidate-required')
 const config={...(deps.config??await readStudioHostConfiguration(deps.configPath))}
 if(!isAbsolute(config.uploadScript??'')||!HASH.test(config.uploadScriptSha256??'')||!HASH.test(config.uploadLibrarySha256??'')||!isAbsolute(config.vaultTokenFile??'')||!isAbsolute(config.uploadStateRoot??'')||!Array.isArray(config.uploadPublicOrigins)||!config.uploadPublicOrigins.length||config.uploadPublicOrigins.some((s:any)=>{try{return typeof s!=='string'||new URL(s).origin!==s||!s.startsWith('https://')}catch{return true}}))throw Error('studio-upload-host-not-configured')
 const root=await realpath(task.cwd)
 // Configuration and credentials are host inputs, not project files.
 for(const configured of [config.uploadScript,config.vaultTokenFile])if(inside(root,await realpath(configured)))throw Error('studio-upload-host-path-inside-task')
 if(await fileSha256(config.uploadScript)!==config.uploadScriptSha256)throw Error('studio-upload-helper-changed')
 const library=join(dirname(config.uploadScript),'studio_upload.py')
 if(inside(root,await realpath(library))||await fileSha256(library)!==config.uploadLibrarySha256)throw Error('studio-upload-library-changed')
 await mkdir(config.uploadStateRoot,{recursive:true,mode:0o700});const stateRoot=await realpath(config.uploadStateRoot)
 if(inside(root,stateRoot))throw Error('studio-upload-host-path-inside-task')
 const path=await studioPath(root,l.path,true),manifest=await studioPath(root,l.manifestPath,true),info=await stat(path)
 if(extname(path).toLowerCase()!=='.mp4'||!info.isFile()||info.size<1||info.size>MAX_BYTES||await fileSha256(path)!==c.sha256||await fileSha256(manifest)!==c.manifestSha256)throw Error('studio-upload-registered-file-changed')
 const expected={sha256:c.sha256,bytes:info.size},intentId=sha(JSON.stringify({taskId:task.id,root,sha256:c.sha256})),directory=join(stateRoot,intentId)
 await mkdir(directory,{recursive:true,mode:0o700})
 const requestPath=join(directory,'request.json'),resultPath=join(directory,'result.json')
 const commonArgs=['--vault-token-file',config.vaultTokenFile,'--library-sha256',config.uploadLibrarySha256,'--expected-sha256',c.sha256,'--expected-bytes',String(info.size),...config.uploadPublicOrigins.flatMap((origin:string)=>['--allowed-public-origin',origin])]
 async function saveResult(result:any,reused:boolean){
  const verified=receipt(result,expected,config.uploadPublicOrigins)
  const temporary=join(directory,`result-${randomUUID()}.tmp`)
  await durableJson(temporary,{state:'completed',receipt:{url:verified.url,sha256:verified.sha256,bytes:verified.bytes,public_hash_verified:true,upload_mode:verified.uploadMode}})
  await rename(temporary,resultPath);await syncDirectory(directory)
  return {ok:true,state:'completed',intentId,...verified,reused,qualityApproved:false,socialPublished:false}
 }
 let saved:any
 try{saved=JSON.parse(await readFile(requestPath,'utf8'))}catch(error:any){if(error?.code!=='ENOENT')throw Error('studio-upload-saved-receipt-invalid')}
 if(saved){
  if(saved.schema!=='studio-preview-upload-v2'||saved.intentId!==intentId||saved.sha256!==c.sha256||saved.bytes!==info.size||saved.key!==`studio-dsh/${c.sha256}/preview.mp4`||saved.helperSha256!==config.uploadScriptSha256||saved.librarySha256!==config.uploadLibrarySha256)throw Error('studio-upload-intent-invalid')
  let result:any;try{result=JSON.parse(await readFile(resultPath,'utf8'))}catch{}
  if(result?.state==='completed'){
   const verified=receipt(result.receipt,expected,config.uploadPublicOrigins)
   return {ok:true,state:'completed',intentId,...verified,reused:true,qualityApproved:false,socialPublished:false}
  }
  deps.assertActive()
  try{
   // A durable pending request can only GET its fixed public object. Never PUT again.
   const verified=await(deps.execute??execute)(config.uploadScript,['verify',...commonArgs])
   return await saveResult(verified,true)
  }catch{return unknown(intentId)}
 }
 const snapshot=await mkdtemp(join(stateRoot,'snapshot-'))
 let reserved=false
 try{
  const frozen=join(snapshot,'preview.mp4')
  await copyFile(path,frozen,constants.COPYFILE_EXCL)
  if((await stat(frozen)).size!==info.size||await fileSha256(frozen)!==c.sha256||await fileSha256(manifest)!==c.manifestSha256)throw Error('studio-upload-registered-file-changed')
  deps.assertActive()
  try{await durableJson(requestPath,{schema:'studio-preview-upload-v2',intentId,sha256:c.sha256,bytes:info.size,helperSha256:config.uploadScriptSha256,librarySha256:config.uploadLibrarySha256,key:`studio-dsh/${c.sha256}/preview.mp4`,state:'pending'});reserved=true;await syncDirectory(directory)}catch(error:any){if(error?.code==='EEXIST')return unknown(intentId);throw error}
  deps.assertActive()
  // Never forward helper/provider bodies. Even a failed PUT is ambiguous.
  const result=await(deps.execute??execute)(config.uploadScript,['upload','--file',frozen,'--project-root',snapshot,...commonArgs])
  return await saveResult(result,false)
 }catch(error){if(reserved)return unknown(intentId);throw error}
 finally{await rm(snapshot,{recursive:true,force:true}).catch(()=>{})}
}
