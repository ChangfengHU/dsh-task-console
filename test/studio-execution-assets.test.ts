import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {studioExecutionAssets} from '../src/studio-execution-assets.ts'
test('status discovers actual scaffold file paths and hashes without editing or installing dependencies',async t=>{
 const cwd=await mkdtemp(join(tmpdir(),'studio-execution-assets-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 await mkdir(join(cwd,'assets/vendor'),{recursive:true});const js='/*! GSAP 3.14.2 */\n// inert discovery fixture',font=Buffer.from('font fixture')
 await writeFile(join(cwd,'assets/vendor/gsap.min.js'),js);await writeFile(join(cwd,'assets/Chinese.ttf'),font)
 const r=await studioExecutionAssets(cwd);assert.equal(r.gsap[0].path,'assets/vendor/gsap.min.js');assert.equal(r.gsap[0].headerVersion,'3.14.2');assert.equal(r.gsap[0].sha256,createHash('sha256').update(js).digest('hex'))
 assert.equal(r.fonts[0].path,'assets/Chinese.ttf');assert.deepEqual(await readFile(join(cwd,'assets/Chinese.ttf')),font);assert.match(r.scope,/not an exhaustive/)
})
test('resource discovery excludes direct and parent symlinks outside the project and never scans arbitrary files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'studio-execution-boundary-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const cwd=join(root,'project'),outside=join(root,'outside');await mkdir(cwd);await mkdir(outside)
 await writeFile(join(outside,'Chinese.ttf'),'not in project');await writeFile(join(outside,'gsap.min.js'),'outside');await symlink(outside,join(cwd,'assets'));await symlink(join(outside,'gsap.min.js'),join(cwd,'gsap.min.js'))
 await writeFile(join(cwd,'credentials.json'),'must never read');const r=await studioExecutionAssets(cwd);assert.deepEqual(r.gsap,[]);assert.deepEqual(r.fonts,[])
})
