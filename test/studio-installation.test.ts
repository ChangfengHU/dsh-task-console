import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm,chmod} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import contract from '../src/studio-installation-contract.json'
import {inspectStudioInstallation,studioInstallationBlock} from '../src/studio-installation.ts'

const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'studio-installation-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const config:any={uploadPublicOrigins:['https://cdn.example.test']}
 await mkdir(join(root,'helpers'))
 for(const [field,rule] of Object.entries(contract.helpers)){
  config[field]=join(root,'helpers',rule.file);await writeFile(config[field],field)
  if('hashField' in rule)config[rule.hashField]=sha(field)
 }
 for(const [field,rule] of Object.entries(contract.libraries)){
  await writeFile(join(dirname(config[rule.parentField]),rule.file),field);config[field]=sha(field)
 }
 for(const field of contract.hostFiles){config[field]=join(root,field);await writeFile(config[field],'private-sentinel-do-not-report')}
 for(const field of contract.hostDirectories){config[field]=join(root,field);await mkdir(config[field],{mode:0o700})}
 for(const member of contract.rendererFiles){const path=join(config.renderRuntime,member);await mkdir(dirname(path),{recursive:true});await writeFile(path,'fixture renderer')}
 return {config,root}
}

test('complete local installation is not represented as a provider or quality pass',async t=>{
 const {config}=await fixture(t),result=await inspectStudioInstallation(config)
 assert.equal(result.ready,true);assert.equal(result.providerVerified,false);assert.equal(result.qualityApproved,false)
 assert.equal(await studioInstallationBlock({config}),undefined)
})

test('actual six-key deployment regression reports all missing capabilities in one block',async t=>{
 const {config}=await fixture(t)
 const broken=Object.fromEntries(['audioScript','speechScript','preflightScript','vaultTokenFile','calibrationPath','calibrationRegressionPath'].map(k=>[k,config[k]]))
 const result=await studioInstallationBlock({config:broken})
 assert.equal(result?.kind,'capability')
 for(const field of ['visionScript','storyboardCompilerScript','assetDownloadScript','renderJobScript','uploadScript'])assert.ok(result!.reason.includes(field))
 assert.ok(!result!.reason.includes('private-sentinel'))
})

test('configured but absent vision helper is rejected; no provider probe is needed',async t=>{
 const {config}=await fixture(t);await rm(config.visionScript)
 const result=await inspectStudioInstallation(config)
 assert.ok(result.issues.includes('visionScript:unavailable'));assert.equal(result.ready,false)
})

test('modified compiler and upload library are detected before production',async t=>{
 const {config}=await fixture(t);await writeFile(config.storyboardCompilerScript,'changed')
 await writeFile(join(dirname(config.uploadScript),'studio_upload.py'),'changed')
 const result=await inspectStudioInstallation(config)
 assert.ok(result.issues.includes('storyboardCompilerScript:hash-mismatch'))
 assert.ok(result.issues.includes('uploadLibrarySha256:hash-mismatch'))
})

test('state directories and render executable must exist, not just have configuration names',async t=>{
 const {config}=await fixture(t);await chmod(config.uploadStateRoot,0o755)
 await rm(join(config.renderRuntime,'node_modules/ffmpeg-static/ffmpeg'))
 const result=await inspectStudioInstallation(config)
 assert.ok(result.issues.includes('uploadStateRoot:not-private'))
 assert.ok(result.issues.some(x=>x.startsWith('renderRuntime/')&&x.endsWith(':unavailable')))
})

test('broken explicit host config produces a sanitized capability block',async t=>{
 const {root}=await fixture(t),configPath=join(root,'broken.json');await writeFile(configPath,'private-sentinel')
 const result=await studioInstallationBlock({configPath})
 assert.equal(result?.kind,'capability');assert.equal(result?.reason,'studio-host-config-unavailable')
})
