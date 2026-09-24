import test from 'node:test'
import assert from 'node:assert/strict'
import {classifyStudioTool} from '../src/studio-progress-fingerprint.js'
import {publicToolName} from '../src/filtered-mcp-client.js'
const call=(name:string,args:any={})=>({name,arguments:args})
const failure=(text:string)=>({content:[{type:'tool-result',isError:true,content:[{type:'text',text}]}]})
const envelope=(value:any)=>({data:{message:{content:[{type:'tool-result',isError:false,content:[{type:'text',text:JSON.stringify(value)}]}]}}})
test('arguments use stable deep canonical hashing, preserving real input distinctions and arrays',()=>{
 const a=classifyStudioTool(call('mcp__server-a__asset_search',{kind:'sfx',filters:{b:2,a:1},tags:['a','b']}))
 const b=classifyStudioTool(call('mcp__server-b__asset_search',JSON.stringify({tags:['a','b'],filters:{a:1,b:2},kind:'sfx'})))
 assert.equal(a.tool,'asset_search');assert.equal(a.inputSha256,b.inputSha256);assert.equal(a.search,true)
 assert.notEqual(a.inputSha256,classifyStudioTool(call('asset_search',{kind:'sfx',filters:{a:1,b:2},tags:['b','a']})).inputSha256)
 assert.equal(classifyStudioTool(call('character_search')).search,false)
})
test('field and path failures share fingerprints across incidental paths/indexes but different fields/reasons stay distinct',()=>{
 const result=(field:string,path:string,reason='File missing')=>failure('studio-stage-output-missing: '+JSON.stringify({error_code:'studio-stage-output-missing',field,reason:reason+' '+path,action:'PRIVATE_TOKEN should never be copied'}))
 const a=classifyStudioTool(call('studio_register_stage',{path:'a'}),result('outputs[0]','stages/r1/visual/a.png'))
 const b=classifyStudioTool(call('studio_register_stage',{path:'b'}),result('outputs[4]','stages/r2/visual/b.png'))
 assert.equal(a.errorFingerprint,b.errorFingerprint);assert.notEqual(a.inputSha256,b.inputSha256)
 assert.equal(a.errorSummary,'studio-stage-output-missing at outputs[]')
 assert.notEqual(a.errorFingerprint,classifyStudioTool(call('studio_register_stage'),result('board.scenes[0].duration','/private/x')).errorFingerprint)
 assert.notEqual(a.errorFingerprint,classifyStudioTool(call('studio_register_stage'),result('outputs[0]','/private/x','Permission denied')).errorFingerprint)
 assert.doesNotMatch(JSON.stringify(a),/PRIVATE_TOKEN|stages\/|private\/|a\.png/)
})
test('plain errors and unsafe error fields expose only bounded safe summaries',()=>{
 const error=new Error('ENOENT: missing file /private/secret.wav?token=PRIVATE_KEY')
 const out=classifyStudioTool(call('studio_register_stage'),error)
 assert.equal(out.errorSummary,'ENOENT');assert.match(out.errorFingerprint!,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(out),/PRIVATE_KEY|secret\.wav/)
 const unsafe=classifyStudioTool(call('studio_register_stage'),failure(JSON.stringify({error_code:'studio-stage-output-invalid',field:'Authorization.PRIVATE_SECRET',reason:'Bearer PRIVATE_BEARER'})))
 assert.equal(unsafe.errorSummary,'studio-stage-output-invalid');assert.doesNotMatch(JSON.stringify(unsafe),/PRIVATE|Bearer/)
 const warnings=classifyStudioTool(call('read'),{ok:true,message:'this document mentions an error'})
 assert.equal(warnings.errorFingerprint,undefined);assert.equal(warnings.acquired,false)
})
test('all original voice/image polling bypasses repeated error classification, including exact hashed public names',()=>{
 for(const name of ['vyibc-voice_status','vyibc-voice_result','vyibc-image_get_task','studio_render_status'])for(const server of ['media','vyibc-media-long-server-1234567890']){
  const out=classifyStudioTool(call(publicToolName(server,name),{job_id:'original-job'}),failure('studio-provider-timeout: PRIVATE_DETAILS'))
  assert.equal(out.tool,name);assert.equal(out.poll,true);assert.equal(out.errorFingerprint,undefined);assert.equal(out.errorSummary,undefined);assert.equal(out.acquired,false)
 }
 assert.equal(classifyStudioTool(call('vyibc-voice_synthesize')).poll,false)
 assert.equal(classifyStudioTool(call('other_status')).poll,false)
})
test('acquisition progress requires exact single asset inspection or a complete verified host download receipt',()=>{
 const id='a'.repeat(64),asset={id,kind:'bgm',object:null},get=call('mcp__library__asset_get',{id})
 assert.equal(classifyStudioTool(get,envelope({asset})).acquired,true,'source-card inspection is progress, not a download claim')
 for(const result of [{assets:[asset]},{asset:{...asset,id:'other'}},{asset:{id}},{isError:true,structuredContent:{asset}},envelope({ok:false,asset})])assert.equal(classifyStudioTool(get,result).acquired,false)
 assert.equal(classifyStudioTool(call('read',{id}),{asset}).acquired,false)
 const receipt={ok:true,assetId:id,path:'stages/r1/sound/voice.wav',sha256:'b'.repeat(64),bytes:20,kind:'voice',reused:false,newGeneration:0},download=call('studio_download_asset',{id,path:receipt.path})
 assert.equal(classifyStudioTool(download,envelope(receipt)).acquired,true)
 for(const field of ['sha256','bytes','assetId','path','kind','reused','newGeneration']){const invalid:any={...receipt};delete invalid[field];assert.equal(classifyStudioTool(download,invalid).acquired,false,field)}
 assert.equal(classifyStudioTool(download,{...receipt,ok:false}).acquired,false)
 assert.equal(classifyStudioTool(call('asset_search',{id}),{assets:[asset]}).acquired,false)
})

test('real ToolExecutionFailure error.message is authoritative with empty or multiple rendered blocks',()=>{
 const message='studio-stage-output-invalid: '+JSON.stringify({error_code:'studio-stage-output-invalid',field:'outputs[1]',reason:'Outside stage: /private/local/image.png'})
 const outputs=[[],[{type:'text',text:'generic failure'},{type:'text',text:'see diagnostics'}],[{type:'text',text:'generic failure'}]].map(content=>classifyStudioTool(call('studio_register_stage'),{isError:true,error:{message,info:{private:'NEVER_ECHO'}},content}))
 assert.equal(new Set(outputs.map(result=>result.errorFingerprint)).size,1)
 for(const result of outputs){assert.equal(result.errorSummary,'studio-stage-output-invalid at outputs[]');assert.doesNotMatch(JSON.stringify(result),/private|NEVER_ECHO|image.png/)}
 const one=classifyStudioTool(call('studio_compile_storyboard'),failure('studio-board-invalid: '+JSON.stringify({error_code:'studio-board-invalid',issues:[{field:'scenes[0].duration',expected:'positive number'}]})))
 const two=classifyStudioTool(call('studio_compile_storyboard'),failure('studio-board-invalid: '+JSON.stringify({error_code:'studio-board-invalid',issues:[{field:'scenes[1].width',expected:'positive number'}]})))
 assert.notEqual(one.errorFingerprint,two.errorFingerprint)
})
test('repair progress requires a complete successful host stage receipt, never an arbitrary read or superficial ok',()=>{
 const receipt={stage:'visual',round:1,batchId:'batch',sessionId:'session',cardId:'card',configSha256:'a'.repeat(64),manifest:{path:'stages/r1/visual/manifest.json',sha256:'b'.repeat(64)},outputs:[{path:'stages/r1/visual/pose.png',sha256:'c'.repeat(64),bytes:123}],qualityApproved:false}
 assert.equal(classifyStudioTool(call('studio_register_stage'),envelope(receipt)).repaired,true)
 for(const field of ['outputs','manifest','configSha256','batchId','round','qualityApproved']){const incomplete:any={...receipt};delete incomplete[field];assert.notEqual(classifyStudioTool(call('studio_register_stage'),incomplete).repaired,true,field)}
 for(const result of [{ok:true},{...receipt,isError:true}])assert.notEqual(classifyStudioTool(call('studio_register_stage'),result).repaired,true)
 assert.notEqual(classifyStudioTool(call('studio_status'),receipt).repaired,true)
})
