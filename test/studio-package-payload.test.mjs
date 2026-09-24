import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm,mkdir,cp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {HELPERS,packageStudio,verifyStudioPayload} from '../scripts/package-studio.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const env={...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH}

test('actual npm tarball contains verified isolated helper closure, no private payload; repacks without parent',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'studio-npm-payload-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const result=JSON.parse(execFileSync('npm',['pack','--json','--pack-destination',temp],{cwd:root,env,encoding:'utf8'}))[0]
 const paths=result.files.map(f=>f.path)
 assert.equal(paths.filter(p=>p.startsWith('studio/helpers/')).length,11)
 assert.ok(paths.includes('studio/manifest.json'))
 assert.ok(!paths.some(p=>/studio-host\.json|(^|\/)evidence\/|(^|\/)\.env|\.sqlite$|\.wav$/.test(p)))
 execFileSync('tar',['-xzf',join(temp,result.filename),'-C',temp])
 const installed=join(temp,'package'), manifest=await verifyStudioPayload(installed)
 assert.equal(manifest.runtimeVerified,false);assert.equal(manifest.proofsPackaged,false)
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
 await packageStudio(root)
 await mkdir(join(temp,'copy'));await cp(join(root,'studio'),join(temp,'copy/studio'),{recursive:true})
 const target=join(temp,'copy')
 await writeFile(join(target,'studio/helpers/audio_signals.py'),'# changed')
 await assert.rejects(verifyStudioPayload(target),/hash-mismatch/)
 await cp(join(root,'studio'),join(target,'studio'),{recursive:true})
 await writeFile(join(target,'studio/helpers/private.py'),'# must not ship')
 await assert.rejects(verifyStudioPayload(target),/unexpected-helper/)
 await assert.rejects(packageStudio(join(temp,'absent'),join(temp,'no-source')),/ENOENT/)
})

test('declared helper imports cannot silently acquire an unbundled dependency',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'studio-payload-import-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const source=join(temp,'sources');await mkdir(source)
 for(const n of HELPERS)await cp(join(root,'../autonomous-studio',n),join(source,n))
 await writeFile(join(source,'audio_signals.py'),'import omitted_local_helper\n')
 await assert.rejects(packageStudio(join(temp,'package'),source),/Undeclared Python dependency/)
})
