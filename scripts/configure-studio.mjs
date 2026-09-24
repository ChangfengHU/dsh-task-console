#!/usr/bin/env node
/** Compose host path references only. Never read credentials or install dependencies. */
import {access,lstat,realpath,open,link,unlink} from 'node:fs/promises'
import {constants} from 'node:fs'
import {dirname,join,resolve,isAbsolute} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {randomUUID} from 'node:crypto'
import {verifyStudioPayload} from './package-studio.mjs'

const packageRoot=dirname(dirname(fileURLToPath(import.meta.url)))
const fail=code=>{throw Error('studio-config-'+code)}
const absolute=(path,field)=>{if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))fail(field+'-path-invalid');return resolve(path)}
async function local(path,field,directory=false,optional=false){
 path=absolute(path,field)
 try{
  const info=await lstat(path)
  if(info.isSymbolicLink()||!(directory?info.isDirectory():info.isFile()))fail(field+'-type-invalid')
  await access(path,constants.R_OK)
  return {path:await realpath(path),state:'present-unverified'}
 }catch(error){
  if(optional&&error.code==='ENOENT')return {path,state:'missing'}
  if(error.message?.startsWith('studio-config-'))throw error
  fail(field+'-unavailable')
 }
}

export async function composeStudioConfiguration(options,root=packageRoot){
 let manifest
 try{root=await realpath(absolute(root,'package'));manifest=await verifyStudioPayload(root)}catch{fail('package-invalid')}
 const runtime=await local(options.renderRuntime,'runtime',true)
 // Presence is not a successful render/launch. No executable is run here.
 for(const member of ['node_modules/hyperframes/package.json','node_modules/hyperframes/bin/hyperframes.mjs','node_modules/ffmpeg-static/ffmpeg'])await local(join(runtime.path,member),'runtime-member')
 const profile=await local(options.dshProfilePath,'profile')
 const token=await local(options.vaultTokenFile,'vault-reference')
 const cache=await local(options.observationCacheRoot,'cache',true)
 if(profile.path===token.path)fail('reference-conflict')
 const proofPaths=options.proofPaths??{}
 if(Object.keys(proofPaths).some(k=>!['calibrationPath','calibrationRegressionPath'].includes(k)))fail('proof-field-invalid')
 if((proofPaths.calibrationPath===undefined)!==(proofPaths.calibrationRegressionPath===undefined))fail('proof-pair-required')
 const proofs={}
 for(const field of ['calibrationPath','calibrationRegressionPath']){
  const p=proofPaths[field]===undefined?{state:'missing'}:await local(proofPaths[field],field,false,true)
  if(p.path===profile.path||p.path===token.path)fail('proof-reference-conflict')
  proofs[field]=p
 }
 if(proofs.calibrationPath.path&&proofs.calibrationPath.path===proofs.calibrationRegressionPath.path)fail('proof-reference-conflict')
 const helper=name=>join(root,'studio','helpers',name)
 const config={
  dshProfilePath:profile.path,renderRuntime:runtime.path,vaultTokenFile:token.path,observationCacheRoot:cache.path,
  preflightScript:helper('preflight_host.py'),audioScript:helper('audio_observe_host.py'),speechScript:helper('speech_check_host.py'),visionScript:helper('vision_observe_host.py'),
  storyboardCompilerScript:helper('compiler_host_bridge.py'),storyboardCompilerSha256:manifest.files['helpers/compiler_host_bridge.py'],
  assetDownloadScript:helper('download_existing_asset.py'),assetDownloadSha256:manifest.files['helpers/download_existing_asset.py'],
  renderJobScript:helper('render_job_host.py'),renderJobSha256:manifest.files['helpers/render_job_host.py'],
  ...Object.fromEntries(Object.entries(proofs).filter(([,v])=>v.path).map(([k,v])=>[k,v.path])),
 }
 return {schema:'studio-config-plan-v1',config,checks:{helperClosure:'verified',roleTemplates:'hash-verified',hostPaths:'present',proofs:Object.fromEntries(Object.entries(proofs).map(([k,v])=>[k,v.state]))},runtimeVerified:false,calibrationVerified:false,rolesInstalled:false,profileModified:false}
}

/** Atomic create via same-directory hard link: a concurrent destination is never replaced. */
export async function configureStudio(options,root=packageRoot){
 const plan=await composeStudioConfiguration(options,root)
 const output=absolute(options.outputPath,'output')
 const parent=await local(dirname(output),'output-parent',true)
 const target=join(parent.path,output.slice(dirname(output).length+1))
 if([plan.config.dshProfilePath,plan.config.vaultTokenFile,plan.config.calibrationPath,plan.config.calibrationRegressionPath].includes(target))fail('output-reference-conflict')
 try{await lstat(target);fail('output-exists')}catch(error){if(error.code!=='ENOENT')fail(error.message==='studio-config-output-exists'?'output-exists':'output-unavailable')}
 const result={...plan,outputPath:target,installed:false,dshConfig:{studioConfigPath:target}}
 if(options.install!==true)return result
 const temporary=join(parent.path,'.studio-config-'+randomUUID()+'.tmp')
 let handle
 try{
  handle=await open(temporary,'wx',0o600)
  await handle.writeFile(JSON.stringify(plan.config,null,2)+'\n');await handle.sync();await handle.close();handle=undefined
  await link(temporary,target)
  result.installed=true
 }catch(error){fail(error.code==='EEXIST'?'output-exists':'write-failed')}
 finally{await handle?.close().catch(()=>{});await unlink(temporary).catch(()=>{})}
 return result
}

const usage=`Usage: node scripts/configure-studio.mjs --output /private/studio-host.json --runtime /render-runtime --profile /dsh/profile.yml --vault-token-file /private/token --cache-root /private/cache [--calibration-path /proofs/calibration.json --regression-path /proofs/regression.json] [--install]
Default: read-only dry run. --install creates a new mode-0600 config; existing files are never replaced. Both proof paths must be provided together, or omitted; missing proofs remain unverified. No provider, role, dependency or profile installation is performed.`
export function parseArguments(args){
 const options={proofPaths:{}}
 const fields={'--output':'outputPath','--runtime':'renderRuntime','--profile':'dshProfilePath','--vault-token-file':'vaultTokenFile','--cache-root':'observationCacheRoot','--calibration-path':'calibrationPath','--regression-path':'calibrationRegressionPath'}
 const seen=new Set()
 for(let i=0;i<args.length;i++){
  const flag=args[i];if(seen.has(flag))fail('argument-duplicate');seen.add(flag)
  if(flag==='--install'){options.install=true;continue}
  if(flag==='--dry-run'){options.install=false;continue}
  if(!fields[flag]||!args[i+1]||args[i+1].startsWith('--'))fail('argument-invalid')
  const field=fields[flag];(field.startsWith('calibration')?options.proofPaths:options)[field]=args[++i]
 }
 if(seen.has('--install')&&seen.has('--dry-run'))fail('argument-conflict')
 return options
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 if(process.argv.slice(2).includes('--help'))console.log(usage)
 else try{console.log(JSON.stringify(await configureStudio(parseArguments(process.argv.slice(2))),null,2))}
 catch(error){console.error(JSON.stringify({ok:false,errorCode:error.message?.startsWith('studio-config-')?error.message:'studio-config-failed'}));process.exitCode=1}
}
