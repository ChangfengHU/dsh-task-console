import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {readStudioCharacterProfile,studioCharacterProfileSummary} from '../src/studio-character-profile.ts'
import {registerStudioTools,studioPath} from '../src/studio-tools.ts'
import {renderComposition,validateSpec} from '../src/presets.ts'
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex')
async function setup(t:any){
 const cwd=await mkdtemp(join(tmpdir(),'profile-lock-'));t.after(()=>rm(cwd,{recursive:true,force:true}));await mkdir(join(cwd,'.studio-host'))
 const path=join(cwd,'.studio-host/character.json'),data={character_id:'original',profile_version:3,profile:{personality:['害羞但喜欢交朋友'],scene_design_plan:[{scene:'大学宿舍',status:'design_only'}],expression_labels:['紧张','得意']},voice_recommendation:{voice_id:'sweet-voice'},selected_voice_asset_id:'voice-asset',warnings:['Design is not generation']},bytes=JSON.stringify(data)
 await writeFile(path,bytes);const lock={path,sha256:hash(bytes),characterId:'original',profileVersion:3},task={cwd,design:{studio:{characterId:'original'}}}
 return {cwd,path,data,lock,task}
}
test('exact host-locked full profile retains personality/scenes/voice with compact safe discovery',async t=>{
 const s=await setup(t),value=await readStudioCharacterProfile(s.task,s.lock);assert.deepEqual(value.data,s.data);assert.equal(value.frozen,true);assert.equal(value.qualityApproved,false)
 const summary=await studioCharacterProfileSummary(s.task,s.lock);assert.deepEqual(summary.read,{tool:'studio_character_profile',arguments:{}});assert.equal(summary.profileVersion,3);assert.equal(summary.sha256,s.lock.sha256);assert.ok(!JSON.stringify(summary).includes(s.cwd));assert.ok(!JSON.stringify(summary).includes('害羞'))
 await assert.rejects(studioPath(s.cwd,s.path,true),/sensitive-path/)
})
test('profile parser rejects changed bytes, wrong identity/version, invalid JSON/UTF8 and oversized bytes',async t=>{
 const s=await setup(t)
 await writeFile(s.path,'changed');await assert.rejects(readStudioCharacterProfile(s.task,s.lock),/sha256_mismatch/)
 for(const [bytes,reason] of [[Buffer.from([255]),'utf8_or_json'],[Buffer.from('{'),'utf8_or_json'],[Buffer.from(JSON.stringify({...s.data,character_id:'other'})),'character_json_identity'],[Buffer.from(JSON.stringify({...s.data,profile_version:4})),'profile_version'],[Buffer.alloc(2*1024*1024+1),'size_or_file_type']] as const){await writeFile(s.path,bytes);await assert.rejects(readStudioCharacterProfile(s.task,{...s.lock,sha256:hash(bytes)}),new RegExp(reason))}
})
test('profile tool cannot use arbitrary hidden paths or symlinked files/directories',async t=>{
 const s=await setup(t),other=join(s.cwd,'.private.json');await writeFile(other,JSON.stringify(s.data));await assert.rejects(readStudioCharacterProfile(s.task,{...s.lock,path:other}),/locked_path_only/)
 await rm(s.path);await symlink(other,s.path);await assert.rejects(readStudioCharacterProfile(s.task,s.lock),/locked_path_only/)
 await rm(join(s.cwd,'.studio-host'),{recursive:true});const target=join(s.cwd,'elsewhere');await mkdir(target);await writeFile(join(target,'character.json'),JSON.stringify(s.data));await symlink(target,join(s.cwd,'.studio-host'));await assert.rejects(readStudioCharacterProfile(s.task,s.lock),/locked_path_only/)
})
test('registered tool permits only studio roles; legacy lookup is explicit and never called by host',async t=>{
 const s=await setup(t),tools:any={},input:any={task:s.task,card:{role:'planner'},sessionId:'s'},workflow={preflight:()=>({ok:true}),status:()=>({candidate:null,preflight:{ok:true}})};let active=true,providerCalls=0
 const install=(role:string,lock:any=s.lock)=>registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}},{input:{...input,card:{role}},workflow,characterProfile:lock,isActive:()=>active,runCommand:async()=>{providerCalls++;throw Error('no provider call')}})
 for(const role of ['planner','executor','reviewer','studio-stage']){await install(role);assert.deepEqual((await tools.studio_character_profile.execute({path:'/etc/passwd'})).data,s.data)}
 await install('worker');await assert.rejects(tools.studio_character_profile.execute({}),/role-denied/)
 await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}},{input,workflow,isActive:()=>active})
 const status=await tools.studio_status.execute({});assert.equal(status.characterProfile.frozen,false);assert.deepEqual(status.characterProfile.lookup,{tool:'character_get',arguments:{character_id:'original'}})
 await assert.rejects(tools.studio_character_profile.execute({}),/lock-missing.*character_get/);assert.equal(providerCalls,0)
 active=false;await assert.rejects(tools.studio_character_profile.execute({}),/stale-run/)
})
test('refresh replaces the discoverable lock; a changed cached file never returns old content',async t=>{
 const s=await setup(t),tools:any={};let ready=false,refreshes=0
 const preflight=()=>({ok:ready,checks:[{status:ready?'passed':'missing'}]})
 await registerStudioTools({tools:{register:(v:any)=>{tools[v.name]=v;return()=>{}}}},{input:{task:s.task,card:{role:'planner'},sessionId:'s'},workflow:{preflight,status:()=>({candidate:null,preflight:preflight(),jobs:[{id:'render-1',status:'running'}],recovery:{action:'inspect-render-status'}})},isActive:()=>true,refreshPreflight:async()=>{refreshes++;ready=true;return {characterProfile:s.lock}}})
 assert.equal((await tools.studio_status.execute({})).characterProfile.available,true);assert.equal(refreshes,1);assert.deepEqual((await tools.studio_character_profile.execute({})).data,s.data)
 await writeFile(s.path,'{}');await assert.rejects(tools.studio_character_profile.execute({}),/sha256_mismatch/);const invalid=await tools.studio_status.execute({});assert.equal(invalid.characterProfile.available,false);assert.equal(invalid.characterProfile.hasFrozenLock,true);assert.equal(invalid.characterProfile.readable,false);assert.equal(invalid.characterProfile.frozen,false);assert.equal(invalid.characterProfile.qualityApproved,false);assert.equal(invalid.characterProfile.error.reason,'sha256_mismatch');assert.equal(invalid.characterProfile.lookup,undefined);assert.equal(invalid.state.jobs[0].id,'render-1');assert.equal(invalid.state.recovery.action,'inspect-render-status');assert.ok(!JSON.stringify(invalid.characterProfile).includes(s.cwd))
})

test('studio-runtime capability fence automatically includes the frozen profile reader',()=>{
 const spec=validateSpec({id:'profile-reader',name:'Reader',description:'',persona:'Read full frozen character',model:'p/m',tools:['studio-runtime'],skills:[],mcpTools:{}})
 const contract=renderComposition(spec,[]).capabilities!;assert.ok(contract.allowedTools.includes('studio_character_profile'));assert.ok(contract.native.find(n=>n.id==='studio-runtime')?.tools.includes('studio_character_profile'))
})

test('invalid profile status exposes bounded reason without raw paths, errors or secret payloads',async t=>{
 const s=await setup(t),privatePath=join(s.cwd,'SECRET-credential.json')
 const missing=await studioCharacterProfileSummary(s.task,{...s.lock,path:privatePath})
 assert.equal(missing.available,false);assert.equal(missing.error?.code,'studio-character-profile-invalid');assert.equal(missing.error?.reason,'locked_path_only');assert.equal('lookup' in missing,false)
 await writeFile(s.path,'SECRET raw provider body');const malformed=await studioCharacterProfileSummary(s.task,{...s.lock,sha256:hash('SECRET raw provider body')})
 assert.equal(malformed.error?.reason,'utf8_or_json')
 await rm(s.path);const unavailable=await studioCharacterProfileSummary(s.task,s.lock);assert.equal(unavailable.error?.reason,'locked_file_unavailable')
 for(const result of [missing,malformed,unavailable]){const text=JSON.stringify(result);assert.ok(!text.includes(s.cwd));assert.ok(!text.includes('SECRET'));assert.ok(!text.includes('ENOENT'));assert.equal(result.frozen,false);assert.equal(result.qualityApproved,false)}
})
