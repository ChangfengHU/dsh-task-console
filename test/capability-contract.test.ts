import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {CAPABILITY_LOCK,inspectCapabilityContract} from '../src/capability-contract.ts'
import {renderComposition,validateSpec,writePreset} from '../src/presets.ts'
const base=validateSpec({id:'specialist',name:'Specialist',persona:'Keep user text',description:'',model:'p/m',tools:['studio-runtime'],skills:[],mcpTools:{}})
test('generated manifest and fence share native tool definitions; stale stage permissions are detected',async t=>{
 const root=await mkdtemp(join(tmpdir(),'capabilities-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const {path,preview}=await writePreset(base,[],[],root);const expected=preview.capabilities!
 assert.ok(expected.allowedTools.includes('studio_register_stage'))
 assert.equal((await inspectCapabilityContract(path,expected)).status,'in-sync')
 assert.equal((await inspectCapabilityContract(path,expected)).liveVerified,false)
 await rm(join(path,CAPABILITY_LOCK));await writeFile(join(path,'agent.cordis.yml'),preview.yml.replace(/^\s+- studio_register_stage\n/m,''))
 const stale=await inspectCapabilityContract(path,expected)
 assert.equal(stale.ready,false);assert.deepEqual(stale.missingTools,['studio_register_stage']);assert.equal(stale.status,'tool-drift')
})
test('author edits are distinguished and never auto-overwritten by inspection',async t=>{
 const root=await mkdtemp(join(tmpdir(),'capabilities-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const {path,preview}=await writePreset(base,[],[],root);const edit=preview.yml.replace('Keep user text','User customization')
 await writeFile(join(path,'agent.cordis.yml'),edit)
 assert.equal((await inspectCapabilityContract(path,preview.capabilities!)).status,'local-edit')
 assert.equal(await readFile(join(path,'agent.cordis.yml'),'utf8'),edit)
})
test('disabled or missing MCP tools fail readiness; credentials never enter capability manifest',()=>{
 const spec=validateSpec({...base,mcpTools:{images:['create','status']}})
 const host={serverName:'images',sourceEntryId:'source-images',tools:['status'],live:true,config:{url:'https://secret-url',headers:{Authorization:'secret'}}}
 const contract=renderComposition(spec,[host]).capabilities!
 assert.deepEqual(contract.missing,['mcp:images:create'])
 assert.doesNotMatch(JSON.stringify(contract),/secret|https:/)
 assert.deepEqual(renderComposition(spec,[{...host,live:false}]).capabilities!.missing,['mcp:images:disabled'])
})
test('legacy matching config remains unverified; model/spec changes invalidate existing lock',async t=>{
 const root=await mkdtemp(join(tmpdir(),'capabilities-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const {path,preview}=await writePreset(base,[],[],root)
 const changed=renderComposition({...base,model:'p/other'},[]).capabilities!
 assert.equal((await inspectCapabilityContract(path,changed)).status,'contract-drift')
 await rm(join(path,CAPABILITY_LOCK))
 assert.equal((await inspectCapabilityContract(path,preview.capabilities!)).status,'unverified-legacy')
})

test('studio download permission reaches sound/executor manifests and a legacy missing fence is detected',async t=>{
 const root=await mkdtemp(join(tmpdir(),'download-capabilities-'));t.after(()=>rm(root,{recursive:true,force:true}))
 for(const id of ['sound-specialist','video-executor']){
  const spec=validateSpec({...base,id}),{path,preview}=await writePreset(spec,[],[],root),expected=preview.capabilities!
  assert.ok(expected.native.find(n=>n.id==='studio-runtime')?.tools.includes('studio_download_asset'))
  assert.ok(expected.allowedTools.includes('studio_download_asset'));assert.equal((await inspectCapabilityContract(path,expected)).ready,true)
  await rm(join(path,CAPABILITY_LOCK));await writeFile(join(path,'agent.cordis.yml'),preview.yml.replace(/^\s+- studio_download_asset\n/m,''))
  const drift=await inspectCapabilityContract(path,expected);assert.equal(drift.ready,false);assert.equal(drift.status,'tool-drift');assert.deepEqual(drift.missingTools,['studio_download_asset'])
 }
 const plain=renderComposition(validateSpec({...base,id:'non-studio-agent',tools:[]}),[]).capabilities!
 assert.equal(plain.allowedTools.includes('studio_download_asset'),false)
})
