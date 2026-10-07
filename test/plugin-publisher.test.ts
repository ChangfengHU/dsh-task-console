import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile,stat} from 'node:fs/promises'
import {PluginPublisher,PACKAGE_ID,publisherToken,validateSource,publisherRuntimeConfig,verifyUploadInvocation,uploadTurnRequest,verifyReadback,ownedTarFiles,publisherSafeDiagnostic,PublisherDiagnosticError,openPluginCreator} from '../src/plugin-publisher.ts'
import {gzipSync} from 'node:zlib'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {registerPluginPublisher} from '../src/plugin-publisher-tools.ts'
import {validateSpec,NATIVE_TOOLS} from '../src/presets.ts'
import {validateTaskIntakeDecision} from '../src/task-intake.ts'
import {intakeContextForModel} from '../src/task-intake-agent.ts'
const id='12345678-1234-1234-1234-123456789abc'
const appId='asdk_app_6ac1f14048b88191a1aa282f102f65f6'
test('native upload discovers the callable name and carries only approved arguments',()=>{
 const text=uploadTurnRequest('/tmp/approved/release.zip','pluginrel_before')
 assert.match(text,/ALL_TOOLS\.filter/)
 assert.match(text,/matches\.length !== 1/)
 assert.ok(text.includes('tools[matches[0].name]('+JSON.stringify({plugin_id:PACKAGE_ID,archive:'/tmp/approved/release.zip',expected_release_id:'pluginrel_before'})+')'))
 assert.ok(!text.includes('tools.mcp__plugin_creator__'))
})
test('native upload turn excludes ambient Apps, MCP, shell and browsing',()=>{
 const config=publisherRuntimeConfig({apps:{other:{enabled:true}},mcp_servers:{vault:{url:'unused'},browser:{url:'unused'}}})
 assert.equal(config['apps.other.enabled'],false)
 assert.equal(config['mcp_servers.vault.enabled'],false)
 assert.equal(config['mcp_servers.browser.enabled'],false)
 assert.equal(config['apps.connector_openai_plugin_creator.default_tools_enabled'],false)
 assert.equal(config['apps.connector_openai_plugin_creator.tools.update_plugin.enabled'],true)
 assert.equal(config['features.shell_tool'],false)
 assert.equal(config['features.unified_exec'],false)
 assert.equal(config.web_search,'disabled')
})
test('native upload receipt must match the exact approved invocation and succeed',()=>{
 const item={type:'mcpToolCall',server:'codex_apps',tool:'plugin_creator.update_plugin',status:'completed',arguments:{plugin_id:PACKAGE_ID,archive:'/tmp/release.zip',expected_release_id:'pluginrel_before'},result:{isError:false}}
 assert.doesNotThrow(()=>verifyUploadInvocation(item,'/tmp/release.zip','pluginrel_before'))
 for(const changed of [{...item,status:'failed'},{...item,tool:'plugin_creator.create_plugin'},{...item,arguments:{...item.arguments,plugin_id:'other'}},{...item,result:{isError:true}},{...item,arguments:{...item.arguments,archive:'/tmp/other.zip'}}])assert.throws(()=>verifyUploadInvocation(changed,'/tmp/release.zip','pluginrel_before'))
})
test('native failure diagnostics retain only typed categories and numeric error metadata',()=>{
 const secret='Bearer secret-token https://signed.example/archive?secret=credential /tmp/private/archive.zip'
 const diagnostic=publisherSafeDiagnostic('native_upload',{code:-32602,httpStatus:422,message:secret,data:{password:secret},content:[{text:secret}]})
 assert.deepEqual(diagnostic,{stage:'native_upload',category:'invalid_arguments',errorCode:-32602,httpStatus:422})
 const item={type:'mcpToolCall',server:'codex_apps',tool:'plugin_creator.update_plugin',status:'failed',arguments:{plugin_id:PACKAGE_ID,archive:'/tmp/release.zip',expected_release_id:'pluginrel_before'},error:{message:'Unauthorized '+secret},result:null}
 assert.throws(()=>verifyUploadInvocation(item,'/tmp/release.zip','pluginrel_before'),(error:any)=>{
  assert.ok(error instanceof PublisherDiagnosticError)
  assert.equal(error.message,'publisher_unavailable')
  assert.deepEqual(error.diagnostic,{stage:'native_upload',category:'authorization',event:'tool_failed'})
  for(const sensitive of ['secret-token','signed.example','credential','/tmp/private'])assert.ok(!JSON.stringify(error).includes(sensitive));return true
 })
 for(const [source,category] of [[{code:'file_upload_failed'},'file_upload'],[{code:'release_conflict'},'release_conflict'],[{codexErrorInfo:'usageLimitExceeded'},'rate_limit'],[{codexErrorInfo:{httpConnectionFailed:{httpStatusCode:503}}},'upstream'],[{message:'file upload failed '+secret},'file_upload'],[{code:'__proto__',httpStatus:999,errorCode:secret,message:secret},'unknown']] as const){
  const safe=publisherSafeDiagnostic('native_upload',source)
  assert.equal(safe.category,category);for(const sensitive of ['secret-token','signed.example','credential','/tmp/private'])assert.ok(!JSON.stringify(safe).includes(sensitive))
 }
 const forged=new PublisherDiagnosticError({stage:secret,category:secret,event:secret,errorCode:secret,httpStatus:secret,message:secret} as any)
 assert.deepEqual(forged.diagnostic,{stage:'publisher',category:'unknown'})
})
test('official turn variants and message-only MCP errors retain safe fixed diagnostics',()=>{
 const secret='Bearer classified-secret https://signed.example/?token=hidden /tmp/private/archive.zip'
 for(const [source,expected] of [
  [{message:secret,codexErrorInfo:{responseStreamConnectionFailed:{httpStatusCode:429}}},{category:'rate_limit',httpStatus:429}],
  [{message:secret,codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:504}}},{category:'timeout',httpStatus:504}],
  [{message:secret,codexErrorInfo:{responseTooManyFailedAttempts:{httpStatusCode:502}}},{category:'upstream',httpStatus:502}],
  [{message:secret,codexErrorInfo:{responseStreamConnectionFailed:{httpStatusCode:null}}},{category:'transport'}],
  [{message:secret,codexErrorInfo:'internalServerError'},{category:'upstream'}],
  [{message:'Tool call failed: MCP error: -32602: Invalid parameters '+secret},{category:'invalid_arguments',errorCode:-32602}],
  [{message:'Mcp error -32603: '+secret},{category:'upstream',errorCode:-32603}],
  [{message:'MCP error -32000: '+secret},{category:'unknown',errorCode:-32000}],
  [{message:'Invalid arguments '+secret},{category:'invalid_arguments'}],
  [{message:'MCP error -3260200000: '+secret},{category:'unknown'}],
  [{message:'unrecognized '+secret},{category:'unknown'}],
 ] as const){
  const safe=publisherSafeDiagnostic('native_upload',source)
  assert.deepEqual(safe,{stage:'native_upload',...expected})
  for(const sensitive of ['classified-secret','signed.example','token=hidden','/tmp/private'])assert.ok(!JSON.stringify(safe).includes(sensitive))
 }
})
test('native uploader failures and public archive codes retain fixed safe reasons',()=>{
 const secret='Bearer uploader-secret https://signed.example/?token=hidden /tmp/private/archive.zip'
 const uploadReasons=[
  ['failed to open OpenAI file upload contents','local_file_open_failed'],
  ['failed to parse OpenAI file response from','upload_response_parse_failed'],
  ['OpenAI file blob upload attempt failed','blob_upload_failed'],
  ['upload finalization returned an error','upload_finalization_failed'],
  ['missing download_url','upload_download_url_missing'],
 ] as const
 const archiveReasons=['archive_empty','archive_too_large','archive_format_not_zip','archive_member_path_empty','archive_member_path_has_outer_whitespace','archive_member_path_has_backslash','archive_member_path_absolute','archive_member_path_has_empty_segment','archive_member_path_has_parent_segment','archive_member_path_too_deep','archive_member_path_too_long','archive_member_path_normalization_collision','archive_member_type_unsupported','archive_member_too_large','archive_member_path_duplicate','archive_member_path_type_conflict','archive_too_many_entries','archive_uncompressed_too_large','archive_member_unreadable','plugin_name_mismatch'] as const
 for(const [fragment,reason,category] of [...uploadReasons.map(([fragment,reason])=>[fragment,reason,'file_upload'] as const),...archiveReasons.map(reason=>[reason,reason,'invalid_arguments'] as const),['plugin_version_unchanged','plugin_version_unchanged','release_conflict'] as const]){
  const safe=publisherSafeDiagnostic('native_upload',{message:'MCP tool call error: '+fragment+': '+secret,reason:secret,result:{content:[{text:secret}]}})
  assert.deepEqual(safe,{stage:'native_upload',category,reason})
  const error=new PublisherDiagnosticError({...safe,event:'tool_failed'})
  assert.deepEqual(error.diagnostic,{stage:'native_upload',category,reason,event:'tool_failed'})
  for(const sensitive of ['uploader-secret','signed.example','token=hidden','/tmp/private','content'])assert.ok(!JSON.stringify(error).includes(sensitive))
 }
 assert.deepEqual(publisherSafeDiagnostic('native_upload',{code:'archive_format_not_zip',message:secret}),{stage:'native_upload',category:'invalid_arguments',reason:'archive_format_not_zip'})
 assert.deepEqual(publisherSafeDiagnostic('native_upload',{httpStatus:403,message:'OpenAI file blob upload attempt failed '+secret}),{stage:'native_upload',category:'authorization',reason:'blob_upload_failed',httpStatus:403})
})
test('uploader diagnostics reject forged reasons and unsupported marker suffixes',()=>{
 const secret='Bearer reason-secret https://signed.example/?token=hidden /tmp/private/archive.zip'
 for(const source of [
  {reason:secret,message:secret},
  {reason:'blob_upload_failed',message:'unrecognized '+secret},
  {code:'archive_format_not_zip_forged',message:'archive_format_not_zip_forged '+secret},
  {code:'__proto__',message:'xarchive_empty '+secret},
  {message:'x'.repeat(4096)+' missing download_url '+secret},
 ])assert.deepEqual(publisherSafeDiagnostic('native_upload',source),{stage:'native_upload',category:'unknown'})
 for(const reason of [secret,'__proto__','constructor',{toString:()=> 'blob_upload_failed',secret}]){
  const error=new PublisherDiagnosticError({stage:'native_upload',category:'unknown',event:'tool_failed',reason,message:secret,result:{content:[{text:secret}]}} as any)
  assert.deepEqual(error.diagnostic,{stage:'native_upload',category:'unknown',event:'tool_failed'})
  for(const sensitive of ['reason-secret','signed.example','token=hidden','/tmp/private','content'])assert.ok(!JSON.stringify(error).includes(sensitive))
 }
})

type NativeOutcome='exit'|'error'|'eof'|'stdin_error'|'stdout_error'|'turn_failed'|'turn_interrupted'|'timeout'|'tool_failed'|'server_request'|'completed'
function nativeFixture(outcome:NativeOutcome,serverMethod='item/tool/requestUserInput',failureMessage='MCP error -32602: Invalid params'){
 const child=new EventEmitter() as any
 child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough()
 let terminated=false,requests=0
 const serverResponses:any[]=[]
 const exit=()=>{if(!terminated){terminated=true;child.emit('exit',1,null)}}
 child.kill=()=>{queueMicrotask(exit);return true}
 const write=(value:unknown)=>child.stdout.write(JSON.stringify(value)+'\n')
 const notification=(method:string,params:unknown)=>write({method,params:{threadId:'publisher-test-thread',...params as any}})
 const secret='Bearer process-secret https://signed.example/?token=hidden'
 child.stdin.on('data',(buffer:Buffer)=>{
  for(const line of buffer.toString().trim().split('\n')){
   const request=JSON.parse(line);if(request.id==null)continue
   if(request.method==null){serverResponses.push(request);continue}
   requests++
   let result:any={}
   if(request.method==='account/read')result={account:{type:'chatgpt'}}
   if(request.method==='config/read')result={config:{}}
   if(request.method==='thread/start')result={thread:{id:'publisher-test-thread'}}
   if(request.method==='app/installed')result={apps:[{id:'connector_openai_plugin_creator',isEnabled:true,isCallable:true}]}
   if(request.method==='mcpServerStatus/list')result={data:[{name:'codex_apps',tools:Object.fromEntries(['get_plugin_files','get_owned_plugin_archive','update_plugin'].map(name=>['plugin_creator.'+name,{name:'plugin_creator.'+name}]))}]}
   if(request.method==='turn/start')result={turn:{id:'publisher-test-turn',status:'inProgress'}}
   write({id:request.id,result})
   if(request.method==='turn/start')queueMicrotask(()=>{
    if(outcome==='exit')exit()
    if(outcome==='error')child.emit('error',Object.assign(new Error(secret),{code:'ECONNRESET'}))
    if(outcome==='eof')child.stdout.end()
    if(outcome==='stdin_error')child.stdin.emit('error',Object.assign(new Error(secret),{code:'EPIPE'}))
    if(outcome==='stdout_error')child.stdout.emit('error',Object.assign(new Error(secret),{code:'ECONNRESET'}))
    if(outcome==='turn_failed'){
     notification('error',{error:{code:-32000,codexErrorInfo:'usageLimitExceeded',message:secret},willRetry:false})
     notification('turn/completed',{turn:{id:'publisher-test-turn',status:'failed'}})
    }
    if(outcome==='turn_interrupted')notification('turn/completed',{turn:{id:'publisher-test-turn',status:'interrupted'}})
    if(outcome==='server_request')write({id:'publisher-server-request',method:serverMethod,params:{threadId:'publisher-test-thread',credentials:secret,message:secret,url:secret}})
    if(outcome==='tool_failed'||outcome==='server_request'||outcome==='completed'){
     notification('item/completed',{item:{type:'mcpToolCall',server:'codex_apps',tool:'plugin_creator.update_plugin',status:outcome==='completed'?'completed':'failed',arguments:{plugin_id:PACKAGE_ID,archive:'/tmp/release.zip',expected_release_id:'pluginrel_before'},...(outcome==='tool_failed'?{error:{message:failureMessage+' '+secret},result:null}:outcome==='server_request'?{error:{message:'Tool request declined'},result:null}:{result:{content:[],structuredContent:null,_meta:null},error:null})}})
     notification('turn/completed',{turn:{id:'publisher-test-turn',status:'completed'}})
    }
   })
  }
 })
 return {spawn:(()=>child) as any,secret,requests:()=>requests,serverResponses}
}
test('native exit/error/EOF interrupts upload waiting after turn/start has responded',async(t)=>{
 const logs:unknown[]=[];t.mock.method(console,'warn',(...args:unknown[])=>logs.push(args))
 for(const [outcome,event] of [['exit','process_exit'],['error','process_error'],['eof','process_eof'],['stdin_error','stdin_error'],['stdout_error','stdout_error']] as const){
  const fake=nativeFixture(outcome),platform=await openPluginCreator('fake-codex',PACKAGE_ID,{spawn:fake.spawn,uploadTimeoutMs:1000})
  try{
   await assert.rejects(platform.update('/tmp/release.zip','pluginrel_before'),(error:any)=>{
    assert.ok(error instanceof PublisherDiagnosticError)
    assert.equal(error.diagnostic.stage,'native_process');assert.equal(error.diagnostic.category,'transport');assert.equal(error.diagnostic.event,event);return true
   })
   assert.equal(fake.requests(),7)
  }finally{await platform.close()}
  for(const sensitive of ['process-secret','signed.example','token=hidden'])assert.ok(!JSON.stringify(logs).includes(sensitive))
 }
})
test('native failed/interrupted/timed-out turns and failed tool receipts log safe typed failures',async(t)=>{
 const logs:unknown[]=[];t.mock.method(console,'warn',(...args:unknown[])=>logs.push(args));t.mock.method(console,'info',(...args:unknown[])=>logs.push(args))
 for(const [outcome,event,category] of [['turn_failed','turn_failed','rate_limit'],['turn_interrupted','turn_interrupted','interrupted'],['timeout','turn_timeout','timeout'],['tool_failed','tool_failed','invalid_arguments']] as const){
  const fake=nativeFixture(outcome),platform=await openPluginCreator('fake-codex',PACKAGE_ID,{spawn:fake.spawn,uploadTimeoutMs:10})
  try{
   await assert.rejects(platform.update('/tmp/release.zip','pluginrel_before'),(error:any)=>{
    assert.ok(error instanceof PublisherDiagnosticError);assert.equal(error.diagnostic.event,event);assert.equal(error.diagnostic.category,category);return true
   })
  }finally{await platform.close()}
  for(const sensitive of ['process-secret','signed.example','token=hidden'])assert.ok(!JSON.stringify(logs).includes(sensitive))
 }
 const receipt=logs.find((args:any)=>args[0]==='[plugin-publisher] native upload receipt') as any[]
 assert.deepEqual(JSON.parse(receipt[1]).calls[0].diagnostic,{stage:'native_upload',category:'invalid_arguments',errorCode:-32602})
})
test('failed native receipts preserve uploader reason without becoming successful',async(t)=>{
 const logs:unknown[]=[];t.mock.method(console,'warn',(...args:unknown[])=>logs.push(args));t.mock.method(console,'info',(...args:unknown[])=>logs.push(args))
 const fake=nativeFixture('tool_failed',undefined,'OpenAI file blob upload attempt failed'),platform=await openPluginCreator('fake-codex',PACKAGE_ID,{spawn:fake.spawn,uploadTimeoutMs:1000})
 try{
  await assert.rejects(platform.update('/tmp/release.zip','pluginrel_before'),(error:any)=>{
   assert.ok(error instanceof PublisherDiagnosticError)
   assert.deepEqual(error.diagnostic,{stage:'native_upload',category:'file_upload',reason:'blob_upload_failed',event:'tool_failed'});return true
  })
 }finally{await platform.close()}
 const receipt=logs.find((args:any)=>args[0]==='[plugin-publisher] native upload receipt') as any[]
 assert.deepEqual(JSON.parse(receipt[1]).calls[0].diagnostic,{stage:'native_upload',category:'file_upload',reason:'blob_upload_failed'})
 assert.equal(JSON.parse(receipt[1]).calls[0].status,'failed')
 for(const sensitive of ['process-secret','signed.example','token=hidden','OpenAI file blob upload attempt failed'])assert.ok(!JSON.stringify(logs).includes(sensitive))
})
test('native server requests remain denied and log only an allowlisted method',async(t)=>{
 const logs:unknown[]=[];t.mock.method(console,'warn',(...args:unknown[])=>logs.push(args));t.mock.method(console,'info',(...args:unknown[])=>logs.push(args))
 for(const method of ['item/tool/requestUserInput','mcpServer/elicitation/request','account/chatgptAuthTokens/refresh','Bearer malicious-method https://signed.example/?token=hidden']){
  const fake=nativeFixture('server_request',method),platform=await openPluginCreator('fake-codex',PACKAGE_ID,{spawn:fake.spawn,uploadTimeoutMs:1000})
  try{await assert.rejects(platform.update('/tmp/release.zip','pluginrel_before'),PublisherDiagnosticError)}finally{await platform.close()}
  assert.deepEqual(fake.serverResponses,[{id:'publisher-server-request',error:{code:-32601,message:'Interactive requests are not supported by the bounded publisher.'}}])
 }
 const rejections=logs.filter((args:any)=>args[0]==='[plugin-publisher] native server request rejected').map((args:any)=>JSON.parse(args[1]))
 assert.deepEqual(rejections,['item/tool/requestUserInput','mcpServer/elicitation/request','account/chatgptAuthTokens/refresh','unknown'].map(method=>({stage:'native_rpc',category:'authorization',event:'server_request_rejected',method})))
 for(const sensitive of ['process-secret','malicious-method','signed.example','token=hidden','credentials'])assert.ok(!JSON.stringify(logs).includes(sensitive))
})
test('native successful upload still requires the exact completed official invocation',async(t)=>{
 t.mock.method(console,'info',()=>{})
 const fake=nativeFixture('completed'),platform=await openPluginCreator('fake-codex',PACKAGE_ID,{spawn:fake.spawn,uploadTimeoutMs:1000})
 try{await platform.update('/tmp/release.zip','pluginrel_before')}finally{await platform.close()}
})
test('Flow identity stays separate, full trees are retained and normalized host MCP fields are equivalent',()=>{
 const f=fixture(),name='vyibc-flow-video-studio',packageId='plugins_6ac374b9d988819187fc2677405e443d'
 delete f.snapshot.files['.app.json'];delete f.current.contents['.app.json']
 Object.assign(f.snapshot,{packageName:name,packageId,appId:''})
 Object.assign(f.current.plugin,{name,plugin_id:packageId,version:'0.1.3',current_release_id:'pluginrel_flow'})
 const root=JSON.parse(f.snapshot.files['plugin.json']);root.name=name
 f.snapshot.files['plugin.json']=JSON.stringify(root)
 f.snapshot.files['.codex-plugin/plugin.json']=JSON.stringify({...root,skills:'./skills/',interface:root.extensions['com.openai'].interface})
 f.snapshot.files['.mcp.json']=JSON.stringify({mcpServers:{video:{type:'http',url:'https://fleet.vyibc.com/mcp/video'}}})
 f.snapshot.files['README.md']='Flow usage';f.snapshot.files['skills/flow-video-studio/references/rules.md']='rules'
 f.current.contents={...f.snapshot.files,'.codex-plugin/plugin.json':JSON.stringify({...root,skills:'./skills',interface:{...root.extensions['com.openai'].interface,keywords:[]}}),'.mcp.json':JSON.stringify({mcpServers:{video:{type:'streamable-http',url:'https://fleet.vyibc.com/mcp/video',headers:{}}}})}
 assert.doesNotThrow(()=>validateSource(f.snapshot,f.current))
 assert.equal(verifyReadback(f.snapshot,f.current),'pluginrel_flow')
 assert.throws(()=>validateSource({...f.snapshot,appId:'asdk_app_fake'},f.current),/identity_mismatch/)
 f.current.contents['.mcp.json']=JSON.stringify({mcpServers:{video:{type:'streamable-http',url:'https://other.example/mcp'}}})
 assert.throws(()=>validateSource(f.snapshot,f.current),/source_changed/)
})
function fixture(){
 const token='x'.repeat(32),archive=Buffer.from('test archive'),sha=createHash('sha256').update(archive).digest('hex')
 const root={name:'vyibc-personal-content',version:'0.1.3',extensions:{'com.openai':{interface:{defaultPrompt:['prompt']}}}}
 const snapshot={packageId:PACKAGE_ID,appId,packageName:root.name,version:root.version,files:{'plugin.json':JSON.stringify(root),'.codex-plugin/plugin.json':JSON.stringify(root),'.app.json':JSON.stringify({apps:{'vyibc-personal-content':{id:appId,required:true}}}),'mcp.json':'{"mcpServers":{}}','.mcp.json':'{"mcpServers":{}}','skills/personal-content/SKILL.md':'skill','assets/icon.png':'aQ=='}}
 const current={plugin:{name:root.name,plugin_id:PACKAGE_ID,version:'0.1.2',current_release_id:'pluginrel_before',scope:'USER',discoverability:'PRIVATE'},contents:{...snapshot.files,'plugin.json':JSON.stringify({...root,version:'0.1.2'})}}
 const state:any={id,version:'0.1.3',state:'queued',expectedReleaseId:'pluginrel_before'}
 let updates=0,archivePath='',lost=false,closes=0
 const options={token,fetch:async(url:any,init:any)=>{
  assert.equal(init.headers.authorization,'Bearer '+publisherToken(token));assert.equal(init.redirect,'error')
  const action=new URL(url).pathname.split('/').pop(),body=init.body?JSON.parse(init.body):{}
  if(action==='archive')return new Response(archive)
  if(action==='claim'){if(state.state!=='queued'&&!(Date.parse(state.leaseUntil)<Date.now()))return Response.json({ok:false,error:'job_not_claimable'},{status:409});state.state='running';state.leaseUntil=new Date(Date.now()+300000).toISOString();return Response.json({ok:true,claim:id})}
  if(action==='finish'){assert.equal(body.claim,id);state.state=body.error?(body.error==='unknown_outcome'?'verifying':'blocked'):'verified';state.error=body.error;state.proof=body;return Response.json({ok:true})}
  return Response.json({ok:true,job:state,snapshot,archiveSha:sha})
 },platform:async()=>({read:async()=>structuredClone(current),close:async()=>{closes++},update:async(path:string,expected:string)=>{
  assert.equal(expected,'pluginrel_before');assert.deepEqual(await readFile(path),archive);assert.equal((await stat(path)).mode&0o777,0o600)
  updates++;archivePath=path;current.plugin.version=snapshot.version;current.plugin.current_release_id='pluginrel_after';current.contents={...snapshot.files}
  if(lost)throw Error('secret upstream error')
 }})}
 return {snapshot,current,state,options,updates:()=>updates,closes:()=>closes,path:()=>archivePath,lose:()=>{lost=true}}
}
test('bounded publisher uploads once and verifies before recording success',async()=>{
 const f=fixture(),p=new PluginPublisher(f.options)
 await p.start(id);await p.start(id)
 assert.equal((await p.settled(id)).state,'verified');assert.equal(f.updates(),1);assert.equal(f.closes(),1)
 assert.equal(f.state.proof.releaseId,'pluginrel_after');await assert.rejects(stat(f.path()))
 await p.start(id);assert.equal(f.updates(),1)
})
test('official JSON object reordering is equivalent but changed values and arrays fail',()=>{
 const f=fixture();f.current.plugin.version='0.1.3';f.current.plugin.current_release_id='pluginrel_after';f.current.contents={...f.snapshot.files}
 const value=JSON.parse(f.current.contents['.codex-plugin/plugin.json'])
 f.current.contents['.codex-plugin/plugin.json']=JSON.stringify({extensions:value.extensions,version:value.version,name:value.name},null,2)
 assert.equal(verifyReadback(f.snapshot,f.current),'pluginrel_after')
 f.current.contents['.codex-plugin/plugin.json']=JSON.stringify({...value,version:'0.1.4'})
 assert.throws(()=>verifyReadback(f.snapshot,f.current),/verification_failed/)
 f.snapshot.files['.codex-plugin/plugin.json']='{"ordered":["first","second"]}'
 f.current.contents['.codex-plugin/plugin.json']='{"ordered":["second","first"]}'
 assert.throws(()=>verifyReadback(f.snapshot,f.current),/verification_failed/)
})
test('unknown write outcome is reconciled without a second upload',async()=>{
 const f=fixture();f.lose();const p=new PluginPublisher(f.options)
 await p.start(id);assert.equal((await p.settled(id)).state,'verifying')
 assert.ok(!JSON.stringify(f.state).includes('secret upstream'))
 f.state.leaseUntil='2000-01-01T00:00:00.000Z'
 await p.start(id);assert.equal((await p.settled(id)).state,'verified');assert.equal(f.updates(),1)
})
test('typed native failure remains unknown_outcome and is only logged as safe diagnostics',async(t)=>{
 const logs:unknown[]=[];t.mock.method(console,'warn',(...args:unknown[])=>logs.push(args))
 const f=fixture(),original=f.options.platform
 f.options.platform=async()=>({...await original(),update:async()=>{throw new PublisherDiagnosticError({...publisherSafeDiagnostic('native_upload',{code:-32602,httpStatus:422,message:'Bearer never-log-this'}),event:'tool_failed'})}})
 const p=new PluginPublisher(f.options);await p.start(id)
 assert.equal((await p.settled(id)).state,'verifying');assert.equal(f.state.error,'unknown_outcome');assert.equal(f.updates(),0)
 assert.deepEqual(f.state.proof,{claim:id,error:'unknown_outcome'})
 const row=logs.find((args:any)=>args[0]==='[plugin-publisher] publish failed') as any[]
 assert.deepEqual(JSON.parse(row[1]),{releaseId:id,outcome:'unknown_outcome',diagnostic:{stage:'native_upload',category:'invalid_arguments',event:'tool_failed',errorCode:-32602,httpStatus:422}})
 assert.ok(!JSON.stringify([logs,f.state]).includes('never-log-this'))
})
test('concurrent official update, changed scope and changed connection all block',async()=>{
 for(const change of [(f:any)=>f.current.plugin.current_release_id='pluginrel_other',(f:any)=>f.current.plugin.scope='WORKSPACE',(f:any)=>f.snapshot.files['.app.json']='{}']){
  const f=fixture();change(f);const p=new PluginPublisher(f.options);await p.start(id);assert.equal((await p.settled(id)).state,'blocked');assert.equal(f.updates(),0)
 }
})
test('default prompts and unexpected files are not silently changed',()=>{
 const f=fixture();f.snapshot.files['plugin.json']=f.snapshot.files['plugin.json'].replace('prompt','different');assert.throws(()=>validateSource(f.snapshot,f.current),/source_changed/)
 const g=fixture();g.snapshot.files['extra.sh']='echo wrong';assert.throws(()=>validateSource(g.snapshot,g.current),/source_changed/)
})
test('reviewer has no publish tool; model cannot supply URLs or commands',async()=>{
 const rows:any[]=[];await registerPluginPublisher({tools:{register:(t:any)=>{rows.push(t);return ()=>{}}}},{start:async()=>({}),status:async()=>({})},true)
 assert.deepEqual(rows.map(t=>t.name),['fleet_plugin_publish_status'])
 assert.equal(rows[0].parameters.additionalProperties,false)
 await assert.rejects(rows[0].execute({releaseId:id,command:'ignored'}),/invalid_release/)
})
test('associated Skill text resources are published and all are read back, not just SKILL.md',async()=>{
 const f=fixture();Object.assign(f.snapshot.files,{'skills/second-skill/SKILL.md':'new skill','skills/second-skill/scripts/helper.py':'print(1)','skills/personal-content/references/readme.md':'context'})
 const p=new PluginPublisher(f.options);await p.start(id);assert.equal((await p.settled(id)).state,'verified');assert.equal(f.updates(),1)
 delete f.current.contents['skills/second-skill/scripts/helper.py'];assert.throws(()=>verifyReadback(f.snapshot,f.current),/verification_failed/)
})
test('missing old Skill files cannot be mistaken for deletion by an overlay update',()=>{
 const f=fixture();(f.current as any).files=[{path:'skills/old-skill/SKILL.md',size_bytes:10}]
 assert.throws(()=>validateSource(f.snapshot,f.current),/platform_file_delete_unsupported/)
 for(const path of ['skills/a/../../credentials','skills/a/.env','skills/a/node_modules/x.js']){const g=fixture();g.snapshot.files[path]='bad';assert.throws(()=>validateSource(g.snapshot,g.current),/source_changed/)}
})
test('binary resources need independent owned-archive readback',()=>{
 const f=fixture();(f.snapshot as any).binaryPaths=['assets/icon.png','skills/personal-content/assets/sound.bin'];f.snapshot.files['skills/personal-content/assets/sound.bin']='AP8=';f.current.plugin.version=f.snapshot.version;f.current.plugin.current_release_id='pluginrel_after';f.current.contents={...f.snapshot.files}
 assert.throws(()=>verifyReadback(f.snapshot,f.current),/verification_failed/)
 ;(f.current as any).binaryContents={'assets/icon.png':'aQ==','skills/personal-content/assets/sound.bin':'AP8='}
 assert.equal(verifyReadback(f.snapshot,f.current),'pluginrel_after');(f.current as any).binaryContents['skills/personal-content/assets/sound.bin']='AAAA';assert.throws(()=>verifyReadback(f.snapshot,f.current),/verification_failed/)
})
test('initial full-package read identifies binary paths instead of requesting PNG as text',async()=>{
 const f=fixture();(f.snapshot as any).binaryPaths=['assets/icon.png','skills/personal-content/assets/new.bin'];
 f.snapshot.files['skills/personal-content/assets/new.bin']='AP8=';
 const reads:any[]=[];
 const original=f.options.platform;
 f.options.platform=async()=>{
  const platform=await original();
  return {...platform,read:async(paths?:string[],binaryPaths?:string[])=>{
   reads.push({paths,binaryPaths});const data:any=await platform.read();
   data.binaryContents={'assets/icon.png':'aQ==',...(data.plugin.version===f.snapshot.version?{'skills/personal-content/assets/new.bin':'AP8='}:{})};return data;
  }};
 };
 const p=new PluginPublisher(f.options);await p.start(id);
 assert.equal((await p.settled(id)).state,'verified');
 assert.deepEqual(reads[0].binaryPaths,f.snapshot.binaryPaths);
 assert.ok(reads[0].paths.includes('assets/icon.png'));
 assert.equal(f.updates(),1);
})
test('owned tar binary reader checks checksum and never extracts files',()=>{
 const header=Buffer.alloc(512),value=Buffer.from([0,255]);header.write('skills/personal-content/assets/sound.bin');header.write('00000000002\0',124);header[156]=48;header.fill(32,148,156);const sum=header.reduce((n,b)=>n+b,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148)
 const tar=Buffer.concat([header,value,Buffer.alloc(510),Buffer.alloc(1024)]),zip=gzipSync(tar),paths=['skills/personal-content/assets/sound.bin']
 assert.deepEqual(ownedTarFiles(zip,paths),{[paths[0]]:'AP8='});assert.throws(()=>ownedTarFiles(zip,['missing']),/verification_failed/);tar[0]=0;assert.throws(()=>ownedTarFiles(gzipSync(tar),paths),/verification_failed/)
})
test('publisher presets match the registered capability contract',async()=>{
 const agents:any[]=[]
 for(const name of ['plugin-publisher','plugin-publisher-reviewer','plugin-publisher-planner']){
  const spec=JSON.parse(await readFile(new URL('../presets/'+name+'/task-console.json',import.meta.url),'utf8'));assert.equal(validateSpec(spec).id,name)
  agents.push({...spec,toolSchemas:spec.tools.flatMap((id:string)=>NATIVE_TOOLS.find(t=>t.id===id)?.schemaNames||[])})
 }
 const requiredExecutorTools=['fleet_plugin_publish','fleet_plugin_publish_status']
 const context={agents,requiredExecutorTools,candidateTasks:[],policy:[]}
 const large={...context,agents:[...Array.from({length:100},(_,i)=>({id:'unrelated-'+i,toolSchemas:['other']})),...agents]}
 const focused=intakeContextForModel(large)
 assert.deepEqual(focused.agents.map(a=>a.id),agents.map(a=>a.id))
 assert.equal(intakeContextForModel(large,true).agents.length,103)
 assert.equal(intakeContextForModel({...large,requiredExecutorTools:undefined}).agents.length,103)
 const decision={action:'create',title:'Private plugin update',reason:'Use dedicated registered roles and exact live tool contracts.',confidence:1,workflow:'dynamic-rounds',participants:[{agentId:'plugin-publisher-planner',role:'planner'},{agentId:'plugin-publisher',role:'executor'},{agentId:'plugin-publisher-reviewer',role:'reviewer'}]}
 assert.equal(validateTaskIntakeDecision(decision,context).action,'create')
 const reviewer=agents.find(a=>a.id==='plugin-publisher-reviewer')
 assert.ok(!reviewer.toolSchemas.includes('fleet_plugin_publish'))
 delete reviewer.taskExpertise
 assert.throws(()=>validateTaskIntakeDecision(decision,context),/taskExpertise/)
})
