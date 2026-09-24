import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm,mkdir,cp,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {HELPERS,packageStudio,verifyStudioPayload} from '../scripts/package-studio.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const env={...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH}

test('actual npm tarball contains verified isolated helper closure, no private payload; repacks without parent',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'studio-npm-payload-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 // Pack a disposable checkout so prepack never replaces the working tree's lib.
 const checkout=join(temp,'checkout');await mkdir(join(checkout,'scripts'),{recursive:true})
 for(const name of ['src','studio','lib','presets','docs'])await cp(join(root,name),join(checkout,name),{recursive:true})
 for(const name of ['build.mjs','package-studio.mjs','prepare-package.mjs','configure-studio.mjs'])await cp(join(root,'scripts',name),join(checkout,'scripts',name))
 await cp(join(root,'package.json'),join(checkout,'package.json'));await symlink(join(root,'node_modules'),join(checkout,'node_modules'),'dir')
 const result=JSON.parse(execFileSync('npm',['pack','--json','--pack-destination',temp],{cwd:checkout,env,encoding:'utf8'}))[0]
 const paths=result.files.map(f=>f.path)
 assert.equal(paths.filter(p=>p.startsWith('studio/helpers/')).length,HELPERS.length)
 assert.ok(paths.includes('studio/manifest.json'))
 assert.ok(paths.includes('scripts/configure-studio.mjs'));assert.ok(paths.includes('scripts/prepare-package.mjs'))
 assert.ok(paths.includes('docs/studio-configuration.md'))
 assert.equal(paths.filter(p=>/^studio\/roles\/[^/]+\/task-console.json$/.test(p)).length,6)
 assert.ok(!paths.some(p=>/studio-host\.json|(^|\/)evidence\/|(^|\/)\.env|\.sqlite$|\.wav$/.test(p)))
 execFileSync('tar',['-xzf',join(temp,result.filename),'-C',temp])
 const installed=join(temp,'package'), manifest=await verifyStudioPayload(installed)
 assert.equal(manifest.runtimeVerified,false);assert.equal(manifest.proofsPackaged,false);assert.equal(manifest.rolesPackaged,true)
 for(const n of HELPERS)assert.deepEqual(await readFile(join(installed,'studio/helpers',n)),await readFile(join(root,'../autonomous-studio',n)))
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
 // Invokes the shipped prepack hook, with no source checkout in the temp parent.
 execFileSync('npm',['pack','--json','--pack-destination',temp],{cwd:installed,env,stdio:'pipe'})
})

test('hash mutation, unexpected helper, and absent payload fail closed',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'studio-payload-invalid-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await verifyStudioPayload(root)
 await mkdir(join(temp,'copy'));await cp(join(root,'studio'),join(temp,'copy/studio'),{recursive:true})
 const target=join(temp,'copy')
 await writeFile(join(target,'studio/helpers/audio_signals.py'),'# changed')
 await assert.rejects(verifyStudioPayload(target),/hash-mismatch/)
 await cp(join(root,'studio'),join(target,'studio'),{recursive:true})
 await writeFile(join(target,'studio/helpers/private.py'),'# must not ship')
 await assert.rejects(verifyStudioPayload(target),/unexpected-helper/)
 await assert.rejects(packageStudio(join(temp,'absent'),join(temp,'no-source')),/ENOENT/)
})

test('role mutation, omitted manifest coverage and extra private files cannot pass payload verification',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'studio-role-payload-invalid-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await cp(join(root,'studio'),join(temp,'studio'),{recursive:true})
 await writeFile(join(temp,'studio/roles/quality/task-console.json'),'{}');await assert.rejects(verifyStudioPayload(temp),/role-integrity/)
 await cp(join(root,'studio'),join(temp,'studio'),{recursive:true})
 const path=join(temp,'studio/manifest.json'),manifest=JSON.parse(await readFile(path,'utf8'));delete manifest.files['roles/quality/task-console.json'];await writeFile(path,JSON.stringify(manifest))
 await assert.rejects(verifyStudioPayload(temp),/manifest-invalid/)
 await cp(join(root,'studio'),join(temp,'studio'),{recursive:true})
 await writeFile(join(temp,'studio/roles/private.json'),'{}');await assert.rejects(verifyStudioPayload(temp),/roles-invalid/)
})

test('declared helper imports cannot silently acquire an unbundled dependency',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'studio-payload-import-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const source=join(temp,'sources');await mkdir(source)
 await mkdir(join(temp,'package/studio'),{recursive:true});await cp(join(root,'studio/roles'),join(temp,'package/studio/roles'),{recursive:true})
 for(const n of HELPERS)await cp(join(root,'../autonomous-studio',n),join(source,n))
 await writeFile(join(source,'audio_signals.py'),'import omitted_local_helper\n')
 await assert.rejects(packageStudio(join(temp,'package'),source),/Undeclared Python dependency/)
})
