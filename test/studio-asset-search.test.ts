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

test('one invocation budgets exact and catalog separately, retains filters and both cursors',async()=>{
 const args={query:'cheerful comedy',kind:'bgm',limit:5,tags_all:['light'],license_status:'known',archive_allowed:false,character_id:'x',bpm_min:80,bpm_max:120,cursor:'exact-start'}
 const calls:any[]=[]
 const source={id:'source',kind:'bgm',object:null,license:{status:'not_verified_for_new_project',archive_allowed:false}}
 const r=assetSearchPage(await searchStudioAssets(args,async a=>{calls.push(a);return a.query?page([],'exact-'+calls.length):page([source],'catalog-next')},4))
 assert.equal(calls.length,3);assert.deepEqual(calls[0],args)
 const catalogArgs={...args};delete (catalogArgs as any).query;delete (catalogArgs as any).cursor
 assert.deepEqual(calls[2],catalogArgs);assert.equal(calls[2].limit,5)
 assert.deepEqual(r.assets,[]);assert.equal(r.next_cursor,'exact-2')
 assert.deepEqual(r.catalogDiscovery.assets,[source]);assert.equal(r.catalogDiscovery.next_cursor,'catalog-next')
 assert.equal(r.catalogDiscovery.availability[0].archiveState,'source_card');assert.equal(r.catalogDiscovery.availability[0].downloadVerified,false)
 assert.equal(r.catalogDiscovery.availability[0].rightsApproved,false)
 assert.equal(r.searchRecovery.continueCall.arguments.cursor,'exact-2')
 assert.equal(r.catalogDiscovery.continueCall.arguments.cursor,'catalog-next')
 assert.equal(r.studioSearch.totalRequests,3)
})
test('total budget never multiplies; query-free search has no second scan',async()=>{
 let n=0
 const r=assetSearchPage(await searchStudioAssets({kind:'bgm',query:'words'},async()=>page([],String(++n))))
 assert.equal(n,20);assert.equal(r.studioSearch.pages,10);assert.equal(r.catalogDiscovery.pages,10)
 assert.equal(r.next_cursor,'10');assert.equal(r.catalogDiscovery.next_cursor,'20')
 n=0
 const plain=assetSearchPage(await searchStudioAssets({kind:'bgm'},async()=>page([],String(++n)),4))
 assert.equal(n,4);assert.equal(plain.catalogDiscovery,undefined)
 const wrapped={structuredContent:{assets:[],next_cursor:'next',studioSearch:{pages:20}}}
 n=0;assert.equal(await searchStudioAssets({query:'q'},async()=>{n++;return wrapped}),wrapped);assert.equal(n,1)
})
test('total deadline returns original retry cursor, dispatches no discovery or late followups',async()=>{
 let calls=0,resolveLate:any
 const r=assetSearchPage(await searchStudioAssets({query:'q',kind:'bgm',cursor:'start'},()=>{calls++;return new Promise(resolve=>{resolveLate=resolve})},20,{timeoutMs:15}))
 assert.equal(r.studioSearch.timedOut,true);assert.equal(r.studioSearch.exhausted,false)
 assert.equal(r.next_cursor,'start');assert.equal(r.searchRecovery.continueCall.arguments.cursor,'start');assert.equal(calls,1)
 resolveLate(page([],'late'));await new Promise(resolve=>setTimeout(resolve,5));assert.equal(calls,1)
})
test('catalog failures retain exact continuation; archived and absent metadata remain unapproved',async()=>{
 const r=assetSearchPage(await searchStudioAssets({query:'q'},async a=>{if(!a.query)throw Error('upstream private diagnostic');return page([],'exact-next')},2))
 assert.equal(r.next_cursor,'exact-next');assert.equal(r.catalogDiscovery.available,false)
 assert.ok(!JSON.stringify(r).includes('private diagnostic'))
 const values=assetSearchPage(await searchStudioAssets({query:'q'},async a=>a.query?page([],null):page([{id:'archived',object:{sha256:'actual'},license:{status:'unknown'}},{id:'unknown'}],null),2))
 assert.deepEqual(values.catalogDiscovery.availability.map((a:any)=>a.archiveState),['archived','unknown'])
 assert.ok(values.catalogDiscovery.availability.every((a:any)=>a.rightsApproved===false&&a.downloadVerified===false))
})
test('host budget cannot exceed twenty requests or sixty seconds',async()=>{
 let calls=0;const invoke=async()=>{calls++;return page([],null)}
 await assert.rejects(searchStudioAssets({},invoke,21),/budget-invalid/)
 await assert.rejects(searchStudioAssets({},invoke,20,{timeoutMs:60_001}),/budget-invalid/)
 assert.equal(calls,0)
})
