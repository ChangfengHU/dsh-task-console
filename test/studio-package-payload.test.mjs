import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm,mkdir,cp,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {HELPERS,RUNTIME_ASSETS,packageStudio,verifyStudioPayload} from '../scripts/package-studio.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const helperSource=n=>n==='studio_upload.py'?join(root,'../studio_upload.py'):join(root,'../autonomous-studio',n)
const env={...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH}

async function fixture(base){
 await mkdir(join(base,'studio'),{recursive:true});await cp(join(root,'studio/roles'),join(base,'studio/roles'),{recursive:true});await packageStudio(base,join(root,'../autonomous-studio'));return base
}

test('actual npm tarball contains verified isolated helper closure, no private payload; repacks without parent',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'studio-npm-payload-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 // Pack only the payload in a disposable checkout; --ignore-scripts deliberately avoids any build.
 // Full prepack/bundle lifecycle is covered separately by package-bundle.test.mjs.
 const checkout=join(temp,'checkout');await mkdir(join(checkout,'scripts'),{recursive:true})
 for(const name of ['docs'])await cp(join(root,name),join(checkout,name),{recursive:true})
 await fixture(checkout)
 for(const name of ['package-studio.mjs','prepare-package.mjs','configure-studio.mjs'])await cp(join(root,'scripts',name),join(checkout,'scripts',name))
 await cp(join(root,'package.json'),join(checkout,'package.json'));await symlink(join(root,'node_modules'),join(checkout,'node_modules'),'dir')
 const result=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',temp],{cwd:checkout,env,encoding:'utf8'}))[0]
 const paths=result.files.map(f=>f.path)
 assert.equal(paths.filter(p=>p.startsWith('studio/helpers/')).length,HELPERS.length)
 assert.ok(paths.includes('studio/manifest.json'))
 assert.deepEqual(paths.filter(p=>p.startsWith('studio/runtime-assets/')).sort(),RUNTIME_ASSETS.map(n=>'studio/runtime-assets/'+n).sort())
 assert.ok(paths.includes('scripts/configure-studio.mjs'));assert.ok(paths.includes('scripts/prepare-package.mjs'))
 assert.ok(paths.includes('docs/studio-configuration.md'))
 assert.equal(paths.filter(p=>/^studio\/roles\/[^/]+\/task-console.json$/.test(p)).length,6)
 assert.ok(!paths.some(p=>/studio-host\.json|(^|\/)evidence\/|(^|\/)\.env|\.sqlite$|\.wav$/.test(p)))
 execFileSync('tar',['-xzf',join(temp,result.filename),'-C',temp])
 const installed=join(temp,'package'), manifest=await verifyStudioPayload(installed)
 assert.equal(manifest.runtimeVerified,false);assert.equal(manifest.proofsPackaged,false);assert.equal(manifest.rolesPackaged,true);assert.equal(manifest.runtimeAssetsPackaged,true)
 for(const n of RUNTIME_ASSETS)assert.deepEqual(await readFile(join(installed,'studio/runtime-assets',n)),await readFile(join(root,'../runtime-assets',n)))
 for(const n of HELPERS)assert.deepEqual(await readFile(join(installed,'studio/helpers',n)),await readFile(helperSource(n)))
 // Isolated import execution with network and subprocess execution forbidden.
 const code=String.raw`
import sys,pathlib,importlib,socket,subprocess,json
root=pathlib.Path(sys.argv[1]);sys.path.insert(0,str(root/'studio/helpers'))
def guard(event,args):
 if event.startswith('socket.') or event=='subprocess.Popen':raise RuntimeError('Import attempted external effect')
sys.addaudithook(guard)
for n in json.loads(sys.argv[2]):
 m=importlib.import_module(pathlib.Path(n).stem)
 assert pathlib.Path(m.__file__).is_relative_to(root)
from compiler_host_bridge import COMPILER_SHA256
import hashlib
assert COMPILER_SHA256==hashlib.sha256((root/'studio/helpers/compile_storyboard.py').read_bytes()).hexdigest()
`
 execFileSync('python3',['-I','-B','-c',code,installed,JSON.stringify(HELPERS)],{cwd:temp,env:{PATH:env.PATH},stdio:'pipe'})
 // The payload verifier works without any source checkout in the temp parent.
 await packageStudio(installed,join(temp,'absent-parent'))
 const project=join(temp,'different home with spaces','project');await mkdir(project,{recursive:true})
 const prepared=JSON.parse(execFileSync('python3',['-I','-B',join(installed,'studio/helpers/prepare_execution_assets.py'),'--project-root',project],{cwd:temp,env:{PATH:env.PATH},encoding:'utf8'}))
 assert.equal(prepared.ok,true);assert.equal(prepared.qualityApproved,false);assert.equal(prepared.compilerRuntimeVerified,false)
 assert.deepEqual(await readFile(join(project,prepared.gsap.path)),await readFile(join(installed,'studio/runtime-assets/gsap.min.js')))
 assert.deepEqual(await readFile(join(project,prepared.font.path)),await readFile(join(installed,'studio/runtime-assets/Chinese.ttf')))
 execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',temp],{cwd:installed,env,stdio:'pipe'})
})

test('hash mutation, unexpected helper, and absent payload fail closed',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'studio-payload-invalid-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const baseline=await fixture(join(temp,'baseline'))
 await verifyStudioPayload(baseline)
 await mkdir(join(temp,'copy'));await cp(join(baseline,'studio'),join(temp,'copy/studio'),{recursive:true})
 const target=join(temp,'copy')
 await writeFile(join(target,'studio/helpers/audio_signals.py'),'# changed')
 await assert.rejects(verifyStudioPayload(target),/hash-mismatch/)
 await cp(join(baseline,'studio'),join(target,'studio'),{recursive:true})
 await writeFile(join(target,'studio/helpers/private.py'),'# must not ship')
 await assert.rejects(verifyStudioPayload(target),/unexpected-helper/)
 await assert.rejects(packageStudio(join(temp,'absent'),join(temp,'no-source')),/ENOENT/)
})

test('role mutation, omitted manifest coverage and extra private files cannot pass payload verification',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'studio-role-payload-invalid-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const baseline=await fixture(join(temp,'baseline'));await cp(join(baseline,'studio'),join(temp,'studio'),{recursive:true})
 await writeFile(join(temp,'studio/roles/quality/task-console.json'),'{}');await assert.rejects(verifyStudioPayload(temp),/role-integrity/)
 await cp(join(baseline,'studio'),join(temp,'studio'),{recursive:true})
 const path=join(temp,'studio/manifest.json'),manifest=JSON.parse(await readFile(path,'utf8'));delete manifest.files['roles/quality/task-console.json'];await writeFile(path,JSON.stringify(manifest))
 await assert.rejects(verifyStudioPayload(temp),/manifest-invalid/)
 await cp(join(baseline,'studio'),join(temp,'studio'),{recursive:true})
 await writeFile(join(temp,'studio/roles/private.json'),'{}');await assert.rejects(verifyStudioPayload(temp),/roles-invalid/)
})

test('declared helper imports cannot silently acquire an unbundled dependency',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'studio-payload-import-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const source=join(temp,'sources');await mkdir(source)
 await mkdir(join(temp,'package/studio'),{recursive:true});await cp(join(root,'studio/roles'),join(temp,'package/studio/roles'),{recursive:true})
 for(const n of HELPERS)await cp(helperSource(n),n==='studio_upload.py'?join(temp,n):join(source,n))
 await writeFile(join(source,'audio_signals.py'),'import omitted_local_helper\n')
 await assert.rejects(packageStudio(join(temp,'package'),source),/Undeclared Python dependency/)
})

test('vendor closure rejects symlink files/directories, missing/extra files, bytes and unsealed manifest',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'studio-runtime-payload-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const baseline=await fixture(join(temp,'baseline')),target=join(temp,'target')
 for(const mode of ['file-symlink','directory-symlink','missing','extra','bytes','manifest','resealed-manifest','coverage']){
  await rm(target,{recursive:true,force:true});await cp(baseline,target,{recursive:true})
  const assets=join(target,'studio/runtime-assets')
  if(mode==='file-symlink'){await rm(join(assets,'Chinese.ttf'));await symlink(join(baseline,'studio/runtime-assets/Chinese.ttf'),join(assets,'Chinese.ttf'))}
  if(mode==='directory-symlink'){await rm(assets,{recursive:true});await symlink(join(baseline,'studio/runtime-assets'),assets,'dir')}
  if(mode==='missing')await rm(join(assets,'GSAP-LICENSE.txt'))
  if(mode==='extra')await writeFile(join(assets,'private.json'),'{}')
  if(mode==='bytes')await writeFile(join(assets,'gsap.min.js'),'changed')
  if(mode==='manifest')await writeFile(join(assets,'manifest.json'),(await readFile(join(assets,'manifest.json'),'utf8'))+'\n')
  if(mode==='resealed-manifest'){const p=join(assets,'manifest.json'),bytes=(await readFile(p,'utf8'))+'\n';await writeFile(p,bytes);const outer=join(target,'studio/manifest.json'),m=JSON.parse(await readFile(outer,'utf8'));m.files['runtime-assets/manifest.json']=createHash('sha256').update(bytes).digest('hex');await writeFile(outer,JSON.stringify(m))}
  if(mode==='coverage'){const p=join(target,'studio/manifest.json'),m=JSON.parse(await readFile(p,'utf8'));delete m.files['runtime-assets/manifest.json'];await writeFile(p,JSON.stringify(m))}
  await assert.rejects(verifyStudioPayload(target),/runtime-asset|hash-mismatch|manifest-invalid|Runtime asset manifest pin mismatch/,mode)
 }
 const readme=await readFile(join(baseline,'studio/README.md'),'utf8');assert.match(readme,/excluded from that MIT grant/);assert.match(readme,/GSAP Standard No Charge License/);assert.match(readme,/Apache-2.0/)
})
