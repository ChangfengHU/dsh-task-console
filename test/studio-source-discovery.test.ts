import {test} from 'node:test'
import assert from 'node:assert/strict'
import {resolveStudioSources} from '../src/studio-source-discovery.js'
const id='a'.repeat(64),profileId='b'.repeat(64),sha='c'.repeat(64),characterId='campus'
const profile={character_id:characterId,profile_asset_id:profileId,profile_version:'v1',lifecycle:'active',profile:{approval:'user_approved_visual_design'}}
const asset=()=>({id,kind:'reference',character_ids:[characterId],source_url:'https://cdn.vyibc.com/baseline.mp4',technical:{asset_kind:'video-quality-baseline',studio_reference:{schema:'studio-reference-v1',character_id:characterId,sha256:sha}},license:{status:'unknown'}})
function fixture(change?:(a:any)=>void){const calls:any[]=[];return {calls,invoke:async(tool:any,args:any)=>{calls.push([tool,args]);if(tool==='character_get')return profile;if(tool==='character_assets')return {character_id:characterId,profile_asset_id:profileId,assets:{other:[{id,kind:'reference',lifecycle:'active'}]}};const a=asset();change?.(a);return {asset:a,download:null}}}}
test('name lookup returns candidates without selecting or reading profiles',async()=>{
 const calls:any[]=[];const r=await resolveStudioSources({query:'campus'},async(t,a)=>{calls.push([t,a]);return {characters:[{character_id:'a',name:'Campus A'},{character_id:'b',name:'Campus B'}],total:2}})
 assert.equal(r.status,'character_candidates');assert.equal(r.selectionRequired,true);assert.equal(calls.length,1);assert.equal(calls[0][0],'character_search')
 const empty=await resolveStudioSources({query:'missing'},async()=>({characters:[],total:0}));assert.equal(empty.status,'no_match')
})
test('explicit character reads current grouped reference then details, never assumes approval',async()=>{
 const f=fixture(),r=await resolveStudioSources({characterId},f.invoke)
 assert.equal(r.status,'metadata_unverified');assert.equal(r.references?.[0].sha256,sha);assert.equal(r.references?.[0].sourceUrl,asset().source_url)
 assert.equal(r.qualityApproved,false);assert.equal(r.references?.[0].qualityApproved,false);assert.equal(r.references?.[0].downloadVerified,false)
 assert.deepEqual(f.calls.map(c=>c[0]),['character_get','character_assets','asset_get']);assert.equal(f.calls[1][1].categories,undefined)
})
test('missing current references explicitly reported; profile-only approval insufficient',async()=>{
 const r=await resolveStudioSources({characterId},async t=>t==='character_get'?profile:{character_id:characterId,profile_asset_id:profileId,assets:{other:[]}})
 assert.equal(r.status,'missing_reference');assert.equal(r.qualityApproved,false)
})
test('reject cross-character, image, guessed object hash and unsafe URL metadata',async()=>{
 const changes=[(a:any)=>a.character_ids=['other'],(a:any)=>a.technical.studio_reference.character_id='other',(a:any)=>a.kind='image',(a:any)=>{delete a.technical.studio_reference.sha256;a.object={sha256:sha}},...['http://cdn.vyibc.com/x','https://cdn.vyibc.com/x?token=secret','https://cdn.vyibc.com/x#fragment','https://user@cdn.vyibc.com/x','https://cdn.vyibc.com:443/x','https://evil.example/x'].map(url=>(a:any)=>a.source_url=url)]
 for(const change of changes){const f=fixture(change),r=await resolveStudioSources({characterId},f.invoke);assert.equal(r.status,'reference_metadata_invalid');assert.deepEqual(r.references,[])}
})
test('fixed total call limit preserves remaining IDs and no arbitrary tool dispatch',async()=>{
 const ids=Array.from({length:10},(_,i)=>i.toString(16).repeat(64));let calls=0
 const r=await resolveStudioSources({characterId},async(t,a)=>{calls++;if(t==='character_get')return profile;if(t==='character_assets')return {character_id:characterId,profile_asset_id:profileId,assets:{other:ids.map(id=>({id,kind:'reference'}))}};return {asset:{...asset(),id:a.id}}})
 assert.equal(calls,8);assert.equal(r.status,'partial');assert.deepEqual(r.unresolvedAssetIds,ids.slice(6))
})
test('timeout stops followups, hides upstream errors, rejects changed profile binding',async()=>{
 let calls=0;const timeout=await resolveStudioSources({characterId},async()=>{calls++;return new Promise(()=>{})},{timeoutMs:5})
 assert.equal(timeout.reason,'timeout');assert.equal(calls,1)
 const bad=await resolveStudioSources({characterId},async()=>{throw Error('private diagnostic secret')});assert.equal(bad.reason,'provider_error');assert.ok(!JSON.stringify(bad).includes('secret'))
 const changed=await resolveStudioSources({characterId},async t=>t==='character_get'?profile:{character_id:characterId,profile_asset_id:'d'.repeat(64),assets:{}});assert.equal(changed.reason,'current_profile_changed_or_invalid')
})
test('MCP text envelopes work; malformed current groups and invalid input fail explicitly',async()=>{
 const f=fixture();const r=await resolveStudioSources({characterId},async(t,a)=>({content:[{type:'text',text:JSON.stringify(await f.invoke(t,a))}]}))
 assert.equal(r.status,'metadata_unverified')
 const bad=await resolveStudioSources({characterId},async t=>t==='character_get'?profile:{character_id:characterId,profile_asset_id:profileId,assets:{other:null}})
 assert.equal(bad.reason,'current_profile_changed_or_invalid')
 let calls=0
 await assert.rejects(resolveStudioSources({query:'',characterId:undefined},async()=>{calls++}),/input-invalid/)
 await assert.rejects(resolveStudioSources({characterId,tenant:'other'} as any,async()=>{calls++}),/input-invalid/)
 assert.equal(calls,0)
})
