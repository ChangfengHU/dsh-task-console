import {test} from 'node:test'
import assert from 'node:assert/strict'
import {searchStudioAssets,assetSearchPage} from '../src/studio-asset-search.js'
const page=(assets:any[],next_cursor:string|null,scanned=5)=>({content:[{type:'text',text:JSON.stringify({assets,next_cursor,scanned})}]})
test('empty storage pages advance with identical scope; first matches keep continuation',async()=>{
 const calls:any[]=[];const args={kind:'bgm',query:'轻快',character_id:'x',limit:5,tags_all:['campus']}
 const result=await searchStudioAssets(args,async a=>{calls.push(a);return calls.length<3?page([],String(calls.length)):page([{id:'music'}],'3')})
 assert.deepEqual(calls,[args,{...args,cursor:'1'},{...args,cursor:'2'}]);assert.deepEqual(args,{kind:'bgm',query:'轻快',character_id:'x',limit:5,tags_all:['campus']})
 assert.equal(assetSearchPage(result).scanned,15);assert.equal(assetSearchPage(result).next_cursor,'3');assert.equal(assetSearchPage(result).studioSearch.exhausted,false)
})
test('exhaustion is explicit; finite empty scan exposes original continuation',async()=>{
 assert.equal(assetSearchPage(await searchStudioAssets({},async()=>page([],null))).studioSearch.exhausted,true)
 let n=0;const value=assetSearchPage(await searchStudioAssets({cursor:'prior'},async()=>page([],String(++n)),2))
 assert.equal(n,2);assert.equal(value.next_cursor,'2');assert.equal(value.studioSearch.partial,true)
})
test('repeated provider cursor stops; provider errors and unrecognized schema are not fabricated',async()=>{
 let n=0;const r=await searchStudioAssets({cursor:'same'},async()=>{n++;return page([],'same')})
 assert.equal(n,1);assert.equal(assetSearchPage(r).studioSearch.cursorRepeated,true)
 const error={isError:true,content:[{type:'text',text:'denied'}]};assert.equal(await searchStudioAssets({},async()=>error),error)
 const unknown={other:1};assert.equal(await searchStudioAssets({},async()=>unknown),unknown)
})

test('empty multiword search exposes actionable continuation and explicitly separate catalog discovery',async()=>{
 const args={kind:'bgm',query:'college cheerful light hearted',character_id:'x',tags_all:['campus'],limit:5,cursor:'old'}
 const r=assetSearchPage(await searchStudioAssets(args,async()=>page([],'next'),1))
 assert.deepEqual(r.searchRecovery.continueCall.arguments,{...args,cursor:'next'})
 assert.deepEqual(r.searchRecovery.catalogDiscovery.arguments,{kind:'bgm',character_id:'x',tags_all:['campus'],limit:5})
 assert.deepEqual(r.assets,[]);assert.equal(r.studioSearch.exhausted,false)
 assert.equal(args.query,'college cheerful light hearted');assert.match(r.searchRecovery.catalogDiscovery.scope,/not matches/)
})
