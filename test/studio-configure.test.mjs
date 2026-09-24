import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,readdir,lstat,rm,cp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync,spawnSync} from 'node:child_process'
import {composeStudioConfiguration,configureStudio,parseArguments} from '../scripts/configure-studio.mjs'
const source=resolve(dirname(fileURLToPath(import.meta.url)),'..')
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'studio 安装 home '));t.after(()=>rm(root,{recursive:true,force:true}))
 const pkg=join(root,'package'),renderRuntime=join(root,'render 运行'),observationCacheRoot=join(root,'cache'),dshProfilePath=join(root,'web profile.yml'),vaultTokenFile=join(root,'token reference'),outputPath=join(root,'studio config.json')
 await mkdir(pkg);await cp(join(source,'studio'),join(pkg,'studio'),{recursive:true})
 await mkdir(join(pkg,'scripts'));for(const name of ['configure-studio.mjs','package-studio.mjs'])await cp(join(source,'scripts',name),join(pkg,'scripts',name))
 for(const name of ['node_modules/hyperframes/package.json','node_modules/hyperframes/bin/hyperframes.mjs','node_modules/ffmpeg-static/ffmpeg']){
  const path=join(renderRuntime,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,'fixture')
 }
 await mkdir(observationCacheRoot);await writeFile(dshProfilePath,'PRIVATE_PROFILE_CONTENT');await writeFile(vaultTokenFile,'PRIVATE_TOKEN_CONTENT')
 return {root,pkg,options:{renderRuntime,observationCacheRoot,dshProfilePath,vaultTokenFile,outputPath}}
}
test('isolated package composes exact host contract with no original home, credentials, or fabricated proofs',async t=>{
 const s=await fixture(t),result=await configureStudio(s.options,s.pkg)
 assert.equal(result.installed,false);assert.equal(result.runtimeVerified,false);assert.equal(result.calibrationVerified,false)
 assert.deepEqual(result.checks.proofs,{calibrationPath:'missing',calibrationRegressionPath:'missing'})
 assert.equal(result.config.dshProfilePath,s.options.dshProfilePath);assert.equal(result.config.renderRuntime,s.options.renderRuntime)
 assert.equal(result.config.storyboardCompilerScript,join(s.pkg,'studio/helpers/compiler_host_bridge.py'))
 const manifest=JSON.parse(await readFile(join(s.pkg,'studio/manifest.json'),'utf8'))
 assert.equal(result.config.renderJobSha256,manifest.files['helpers/render_job_host.py'])
 assert.equal(result.config.assetDownloadSha256,manifest.files['helpers/download_existing_asset.py'])
 assert.equal(result.config.calibrationPath,undefined)
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PROFILE_CONTENT|PRIVATE_TOKEN_CONTENT|\/home\/claude/)
 await assert.rejects(lstat(s.options.outputPath),{code:'ENOENT'})
})
test('proof presence stays unverified and missing explicit paths are retained without fake files',async t=>{
 const s=await fixture(t),proofPaths={calibrationPath:join(s.root,'genuine calibration.json'),calibrationRegressionPath:join(s.root,'not yet produced.json')}
 await writeFile(proofPaths.calibrationPath,'not a passing calibration')
 const result=await composeStudioConfiguration({...s.options,proofPaths},s.pkg)
 assert.deepEqual(result.checks.proofs,{calibrationPath:'present-unverified',calibrationRegressionPath:'missing'})
 assert.equal(result.config.calibrationRegressionPath,proofPaths.calibrationRegressionPath);assert.equal(result.calibrationVerified,false)
 await assert.rejects(composeStudioConfiguration({...s.options,proofPaths:{calibrationPath:proofPaths.calibrationPath}},s.pkg),/proof-pair-required/)
 await assert.rejects(composeStudioConfiguration({...s.options,proofPaths:{...proofPaths,calibrationPath:s.options.vaultTokenFile}},s.pkg),/proof-reference-conflict/)
})
test('changed helper closure and missing required paths fail without writes',async t=>{
 const s=await fixture(t)
 await assert.rejects(configureStudio({...s.options,dshProfilePath:join(s.root,'missing')},s.pkg),/profile-unavailable/)
 await rm(join(s.options.renderRuntime,'node_modules/ffmpeg-static/ffmpeg'))
 await assert.rejects(configureStudio(s.options,s.pkg),/runtime-member-unavailable/)
 await writeFile(join(s.pkg,'studio/helpers/audio_signals.py'),'changed')
 await assert.rejects(configureStudio(s.options,s.pkg),/package-invalid/)
 await assert.rejects(lstat(s.options.outputPath),{code:'ENOENT'})
})
test('explicit install atomically creates mode 0600 and never replaces concurrent or conflicting output',async t=>{
 const s=await fixture(t),options={...s.options,install:true}
 const results=await Promise.allSettled([configureStudio(options,s.pkg),configureStudio(options,s.pkg)])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
 assert.match(results.find(r=>r.status==='rejected').reason.message,/output-exists/)
 assert.equal((await lstat(options.outputPath)).mode&0o777,0o600)
 const original=await readFile(options.outputPath,'utf8');assert.equal(JSON.parse(original).vaultTokenFile,options.vaultTokenFile)
 await assert.rejects(configureStudio(options,s.pkg),/output-exists/)
 assert.equal(await readFile(options.outputPath,'utf8'),original)
 assert.ok(!(await readdir(s.root)).some(n=>n.startsWith('.studio-config-')))
 assert.equal(await readFile(options.dshProfilePath,'utf8'),'PRIVATE_PROFILE_CONTENT')
 assert.equal(await readFile(options.vaultTokenFile,'utf8'),'PRIVATE_TOKEN_CONTENT')
})
test('shipped CLI defaults to dry run and rejects conflicting flags with safe diagnostics',async t=>{
 const s=await fixture(t),args=['--output',s.options.outputPath,'--runtime',s.options.renderRuntime,'--profile',s.options.dshProfilePath,'--vault-token-file',s.options.vaultTokenFile,'--cache-root',s.options.observationCacheRoot]
 const script=join(s.pkg,'scripts/configure-studio.mjs')
 const result=JSON.parse(execFileSync(process.execPath,[script,...args],{encoding:'utf8'}))
 assert.equal(result.installed,false);assert.deepEqual(result.dshConfig,{studioConfigPath:s.options.outputPath})
 await assert.rejects(lstat(s.options.outputPath),{code:'ENOENT'})
 assert.throws(()=>parseArguments([...args,'--install','--dry-run']),/argument-conflict/)
 const failed=spawnSync(process.execPath,[script,...args,'--unknown','SECRET_VALUE'],{encoding:'utf8'})
 assert.equal(failed.status,1);assert.doesNotMatch(failed.stderr,/SECRET_VALUE|PRIVATE_/)
})
