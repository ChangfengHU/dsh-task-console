import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { gunzipSync } from 'node:zlib'

export const PACKAGE_ID = 'plugins_6ac15b9d3e4c8191b2f6ff943d1e574d'
const APP_ID = 'asdk_app_6ac1f14048b88191a1aa282f102f65f6'
export const PUBLISH_TARGETS = {
 'vyibc-personal-content':{packageId:PACKAGE_ID,appId:APP_ID},
 'vyibc-flow-video-studio':{packageId:'plugins_6ac374b9d988819187fc2677405e443d',appId:''},
} as const
function targetFor(snapshot:any){
 const target=PUBLISH_TARGETS[snapshot.packageName as keyof typeof PUBLISH_TARGETS]
 requireValue(target&&snapshot.packageId===target.packageId&&snapshot.appId===target.appId,'identity_mismatch')
 return target
}
const FILES = ['plugin.json', '.codex-plugin/plugin.json', '.app.json', 'mcp.json', '.mcp.json', 'skills/personal-content/SKILL.md']
const fail = (code: string): never => { throw new Error(code) }
const requireValue = (ok: unknown, code: string) => { if (!ok) fail(code) }
export const publisherToken = (token: string) => createHmac('sha256', token).update('fleet-hub-plugin-publisher-v1').digest('hex')

export interface Platform {
  read(paths?: string[], binaryPaths?: string[]): Promise<any>
  update(archive: string, expected: string): Promise<void>
  close(): Promise<void>
}

export type PublisherFailureCategory = 'authorization'|'file_upload'|'release_conflict'|'rate_limit'|'timeout'|'transport'|'invalid_arguments'|'upstream'|'interrupted'|'unknown'
// Exact uploader fragments from Codex 0.160.1 and public plugin archive codes.
// This is an output allowlist, not a place to copy connector-provided labels.
const FAILURE_REASONS = {
  local_file_open_failed:{category:'file_upload',fragment:'failed to open OpenAI file upload contents'},
  upload_response_parse_failed:{category:'file_upload',fragment:'failed to parse OpenAI file response from'},
  blob_upload_failed:{category:'file_upload',fragment:'OpenAI file blob upload attempt failed'},
  upload_finalization_failed:{category:'file_upload',fragment:'upload finalization returned an error'},
  upload_download_url_missing:{category:'file_upload',fragment:'missing download_url'},
  archive_empty:{category:'invalid_arguments',fragment:'archive_empty'},
  archive_too_large:{category:'invalid_arguments',fragment:'archive_too_large'},
  archive_format_not_zip:{category:'invalid_arguments',fragment:'archive_format_not_zip'},
  archive_member_path_empty:{category:'invalid_arguments',fragment:'archive_member_path_empty'},
  archive_member_path_has_outer_whitespace:{category:'invalid_arguments',fragment:'archive_member_path_has_outer_whitespace'},
  archive_member_path_has_backslash:{category:'invalid_arguments',fragment:'archive_member_path_has_backslash'},
  archive_member_path_absolute:{category:'invalid_arguments',fragment:'archive_member_path_absolute'},
  archive_member_path_has_empty_segment:{category:'invalid_arguments',fragment:'archive_member_path_has_empty_segment'},
  archive_member_path_has_parent_segment:{category:'invalid_arguments',fragment:'archive_member_path_has_parent_segment'},
  archive_member_path_too_deep:{category:'invalid_arguments',fragment:'archive_member_path_too_deep'},
  archive_member_path_too_long:{category:'invalid_arguments',fragment:'archive_member_path_too_long'},
  archive_member_path_normalization_collision:{category:'invalid_arguments',fragment:'archive_member_path_normalization_collision'},
  archive_member_type_unsupported:{category:'invalid_arguments',fragment:'archive_member_type_unsupported'},
  archive_member_too_large:{category:'invalid_arguments',fragment:'archive_member_too_large'},
  archive_member_path_duplicate:{category:'invalid_arguments',fragment:'archive_member_path_duplicate'},
  archive_member_path_type_conflict:{category:'invalid_arguments',fragment:'archive_member_path_type_conflict'},
  archive_too_many_entries:{category:'invalid_arguments',fragment:'archive_too_many_entries'},
  archive_uncompressed_too_large:{category:'invalid_arguments',fragment:'archive_uncompressed_too_large'},
  archive_member_unreadable:{category:'invalid_arguments',fragment:'archive_member_unreadable'},
  plugin_name_mismatch:{category:'invalid_arguments',fragment:'plugin_name_mismatch'},
  plugin_version_unchanged:{category:'release_conflict',fragment:'plugin_version_unchanged'},
} as const
export type PublisherFailureReason = keyof typeof FAILURE_REASONS
type PublisherDiagnosticStage = 'native_upload'|'native_rpc'|'native_process'|'publisher'
type PublisherDiagnosticEvent = 'tool_failed'|'rpc_error'|'rpc_timeout'|'turn_failed'|'turn_interrupted'|'turn_timeout'|'process_error'|'process_exit'|'process_eof'|'process_timeout'|'process_closed'|'stdin_error'|'stdout_error'|'stdout_limit'|'server_request_rejected'|'publish_failed'
export interface PublisherSafeDiagnostic {
  stage: PublisherDiagnosticStage
  category: PublisherFailureCategory
  reason?: PublisherFailureReason
  event?: PublisherDiagnosticEvent
  errorCode?: number
  httpStatus?: number
}
const ERROR_CATEGORIES: Record<string, PublisherFailureCategory> = {
  authorization_required:'authorization',unauthorized:'authorization',forbidden:'authorization',authentication_failed:'authorization',invalid_token:'authorization',expired_token:'authorization',permission_denied:'authorization',
  file_upload_failed:'file_upload',file_upload_error:'file_upload',upload_failed:'file_upload',
  release_conflict:'release_conflict',platform_conflict:'release_conflict',
  rate_limit_exceeded:'rate_limit',ratelimitexceeded:'rate_limit',usagelimitexceeded:'rate_limit',
  timeout:'timeout',request_timeout:'timeout',etimedout:'timeout',
  econnreset:'transport',econnrefused:'transport',epipe:'transport',httpconnectionfailed:'transport',responsestreamconnectionfailed:'transport',responsestreamdisconnected:'transport',responsetoomanyfailedattempts:'transport',
  invalid_arguments:'invalid_arguments',invalid_params:'invalid_arguments',badrequest:'invalid_arguments',
  internal_error:'upstream',internalservererror:'upstream',server_error:'upstream',interrupted:'interrupted',
}
const SERVER_REQUEST_METHODS = ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/tool/requestUserInput','mcpServer/elicitation/request','item/permissions/requestApproval','item/tool/call','account/chatgptAuthTokens/refresh','attestation/generate','currentTime/read','applyPatchApproval','execCommandApproval'] as const
/** Never retain raw errors/messages, result content, arguments or credentials. */
export function publisherSafeDiagnostic(stage:PublisherDiagnosticStage,error:unknown,fallback:PublisherFailureCategory='unknown'):PublisherSafeDiagnostic {
  const source=error&&typeof error==='object'?error as any:{}
  const info=source.codexErrorInfo??source.data?.codexErrorInfo
  const fields=[source,source.data,typeof info==='object'?info:undefined,info?.httpConnectionFailed,info?.responseStreamConnectionFailed,info?.responseStreamDisconnected,info?.responseTooManyFailedAttempts].filter(Boolean)
  const message=typeof source.message==='string'?source.message.slice(0,4096):undefined
  // McpToolCallError exposes message only. Accept only a fixed MCP/JSON-RPC code format.
  const messageCode=message?.match(/\bMCP\s+error\s*:?\s*(-(?:32700|3260[0-3]|320\d{2}))\b/i)?.[1]
  const errorCode=fields.map(value=>value.code).find(value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=-2147483648&&value<=2147483647)??(messageCode===undefined?undefined:Number(messageCode))
  const httpStatus=fields.flatMap(value=>[value.httpStatus,value.httpStatusCode,value.statusCode]).find(value=>typeof value==='number'&&Number.isInteger(value)&&value>=100&&value<=599)
  const labels=[source.code,source.data?.code,typeof info==='string'?info:undefined,...(info&&typeof info==='object'?Object.keys(info):[])].filter((value):value is string=>typeof value==='string')
  const reason=(Object.keys(FAILURE_REASONS) as PublisherFailureReason[]).find(key=>labels.some(label=>label.toLowerCase()===key)||message!==undefined&&new RegExp('\\b'+FAILURE_REASONS[key].fragment+'\\b','i').test(message))
  let category=labels.map(value=>{const key=value.toLowerCase();return Object.hasOwn(ERROR_CATEGORIES,key)?ERROR_CATEGORIES[key]:undefined}).find(Boolean)||fallback
  if(httpStatus===401||httpStatus===403)category='authorization'
  else if(httpStatus===409||httpStatus===412)category='release_conflict'
  else if(httpStatus===429)category='rate_limit'
  else if(httpStatus===408||httpStatus===504)category='timeout'
  else if(httpStatus===400||httpStatus===422||errorCode===-32602)category='invalid_arguments'
  else if(httpStatus>=500||errorCode===-32603)category='upstream'
  if(category==='unknown'&&reason!==undefined)category=FAILURE_REASONS[reason].category
  // A bounded message can classify a known failure, but is never retained/logged.
  if(category==='unknown'&&message!==undefined){
    if(/\b(?:unauthorized|forbidden|permission denied|authentication required|invalid token|token expired)\b/i.test(message))category='authorization'
    else if(/\b(?:file upload|upload file|fileParams|uploaded-file|upload_failed)\b/i.test(message))category='file_upload'
    else if(/\b(?:release conflict|expected_release_id mismatch)\b/i.test(message))category='release_conflict'
    else if(/\b(?:rate limit|too many requests)\b/i.test(message))category='rate_limit'
    else if(/\b(?:timed out|timeout)\b/i.test(message))category='timeout'
    else if(/\b(?:invalid (?:arguments|params|parameters)|invalid_arguments|invalid_params)\b/i.test(message))category='invalid_arguments'
  }
  return {stage,category,...(reason!==undefined?{reason}:{}),...(errorCode!==undefined?{errorCode}:{}),...(httpStatus!==undefined?{httpStatus}:{})}
}
export class PublisherDiagnosticError extends Error {
  readonly diagnostic:Readonly<PublisherSafeDiagnostic>
  constructor(diagnostic:PublisherSafeDiagnostic){
    super('publisher_unavailable');this.name='PublisherDiagnosticError'
    const safe=publisherSafeDiagnostic('publisher',{code:diagnostic.errorCode,httpStatus:diagnostic.httpStatus})
    const stages:PublisherDiagnosticStage[]=['native_upload','native_rpc','native_process','publisher']
    const categories:PublisherFailureCategory[]=['authorization','file_upload','release_conflict','rate_limit','timeout','transport','invalid_arguments','upstream','interrupted','unknown']
    const events:PublisherDiagnosticEvent[]=['tool_failed','rpc_error','rpc_timeout','turn_failed','turn_interrupted','turn_timeout','process_error','process_exit','process_eof','process_timeout','process_closed','stdin_error','stdout_error','stdout_limit','server_request_rejected','publish_failed']
    this.diagnostic=Object.freeze({stage:stages.includes(diagnostic.stage)?diagnostic.stage:'publisher',category:categories.includes(diagnostic.category)?diagnostic.category:'unknown',...(typeof diagnostic.reason==='string'&&Object.hasOwn(FAILURE_REASONS,diagnostic.reason)?{reason:diagnostic.reason}:{}),...(events.includes(diagnostic.event!)?{event:diagnostic.event}:{}),...(safe.errorCode!==undefined?{errorCode:safe.errorCode}:{}),...(safe.httpStatus!==undefined?{httpStatus:safe.httpStatus}:{})})
  }
}

export function publisherRuntimeConfig(effective: any = {}) {
  const config: Record<string, unknown> = {'features.shell_tool':false,'features.unified_exec':false,'features.multi_agent':false,'features.skill_mcp_dependency_install':false,web_search:'disabled','apps._default.enabled':false,'apps.connector_openai_plugin_creator.enabled':true,'apps.connector_openai_plugin_creator.default_tools_enabled':false,'apps.connector_openai_plugin_creator.tools.update_plugin.enabled':true,'apps.connector_openai_plugin_creator.tools.get_plugin_files.enabled':true,'apps.connector_openai_plugin_creator.tools.get_owned_plugin_archive.enabled':true}
  for(const name of Object.keys(effective.mcp_servers||{}))config['mcp_servers.'+name+'.enabled']=false
  for(const name of Object.keys(effective.apps||{}))if(!['_default','connector_openai_plugin_creator'].includes(name))config['apps.'+name+'.enabled']=false
  return config
}

export function verifyUploadInvocation(item:any, archive:string, expected:string, packageId:string=PACKAGE_ID) {
  requireValue(item?.type==='mcpToolCall'&&item.server==='codex_apps'&&item.tool==='plugin_creator.update_plugin','verification_failed')
  const args=typeof item.arguments==='string'?JSON.parse(item.arguments):item.arguments
  requireValue(args?.plugin_id===packageId&&args.archive===archive&&args.expected_release_id===expected&&Object.keys(args).length===3,'verification_failed')
  if(item.status!=='completed'||item.error||item.result?.isError)throw new PublisherDiagnosticError({...publisherSafeDiagnostic('native_upload',item.error),event:'tool_failed'})
}

export function uploadTurnRequest(archive:string,expected:string,packageId:string=PACKAGE_ID) {
  const args={plugin_id:packageId,archive,expected_release_id:expected}
  return 'Use functions.exec to run exactly this JavaScript. Resolve the executable name from ALL_TOOLS; do not guess a namespace. '+
    'const matches = ALL_TOOLS.filter(t => /plugin_creator.*update_plugin$/.test(t.name)); '+
    'if (matches.length !== 1) throw new Error("publisher_tool_not_found"); '+
    'text(await tools[matches[0].name]('+JSON.stringify(args)+')); '+
    'The archive is owner-approved and immutable. Call that external tool exactly once. Do not call any other external tool, change arguments, create files, or retry. Report its result and stop.'
}

/** Direct source reads; one native turn performs the host's required file upload. */
export async function openPluginCreator(binary = join(homedir(), '.local/bin/codex'),packageId:string=PACKAGE_ID,dependencies:{spawn?:typeof spawn;uploadTimeoutMs?:number}={}): Promise<Platform> {
  requireValue(Object.values(PUBLISH_TARGETS).some(t=>t.packageId===packageId),'identity_mismatch')
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['HOME','PATH','USER','LOGNAME','LANG','TMPDIR','CODEX_HOME','SSL_CERT_FILE','SSL_CERT_DIR','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  const child = (dependencies.spawn||spawn)(binary, ['app-server', '--listen', 'stdio://'], {cwd: tmpdir(), env, stdio: ['pipe','pipe','pipe']})
  let serial = 0, ended = false, exited = false, closing = false
  let observeTurn: ((message:any)=>void)|undefined
  let abortUpload:((error:PublisherDiagnosticError)=>void)|undefined,endedError:PublisherDiagnosticError|undefined
  const pending = new Map<number, {resolve: (x: any) => void; reject: (x: Error) => void; timer: NodeJS.Timeout}>()
  const send = (value: unknown) => { if (!ended) child.stdin.write(JSON.stringify(value) + '\n') }
  const processFailure=(event:PublisherDiagnosticEvent,error?:unknown,category:PublisherFailureCategory='transport')=>new PublisherDiagnosticError({...publisherSafeDiagnostic('native_process',error,category),event})
  const rejectAll = (error:PublisherDiagnosticError=processFailure('process_closed')) => {
    ended = true;endedError??=error
    for (const p of pending.values()) {clearTimeout(p.timer); p.reject(endedError)} pending.clear()
    abortUpload?.(endedError)
  }
  child.on('error', error=>rejectAll(processFailure('process_error',error)))
  child.on('exit', () => {exited=true;rejectAll(processFailure('process_exit'))})
  child.stdin.on('error', error=>rejectAll(processFailure('stdin_error',error)))
  child.stdout.on('error', error=>rejectAll(processFailure('stdout_error',error)))
  child.stdout.on('end', ()=>{if(!closing)rejectAll(processFailure('process_eof'))})
  const lifetime = setTimeout(() => { rejectAll(processFailure('process_timeout',undefined,'timeout')); child.kill('SIGTERM') }, 240000)
  lifetime.unref()
  child.stderr.on('data', () => {}) // Auth/MCP diagnostics must not leak to Task receipts.
  const lines = createInterface({input: child.stdout})
  lines.on('error', error=>rejectAll(processFailure('stdout_error',error)))
  lines.on('close', ()=>{if(!closing)rejectAll(processFailure('process_eof'))})
  lines.on('line', line => {
    if (line.length > 4 * 1024 * 1024) {rejectAll(processFailure('stdout_limit',undefined,'upstream')); child.kill(); return}
    let m: any; try {m = JSON.parse(line)} catch {return}
    if (m.method && m.id != null) {
      console.warn('[plugin-publisher] native server request rejected',JSON.stringify({stage:'native_rpc',category:'authorization',event:'server_request_rejected',method:SERVER_REQUEST_METHODS.includes(m.method)?m.method:'unknown'}))
      send({id:m.id,error:{code:-32601,message:'Interactive requests are not supported by the bounded publisher.'}}); return
    }
    if(m.method)observeTurn?.(m)
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id); clearTimeout(p.timer)
    if (m.error) p.reject(new PublisherDiagnosticError({...publisherSafeDiagnostic('native_rpc',m.error),event:'rpc_error'})); else p.resolve(m.result)
  })
  const rpc = (method: string, params: unknown, timeout = 70000): Promise<any> => new Promise((resolve,reject) => {
    if (ended) return reject(endedError||processFailure('process_closed'))
    const id = ++serial, timer = setTimeout(() => {pending.delete(id); reject(new PublisherDiagnosticError({stage:'native_rpc',category:'timeout',event:'rpc_timeout'}))}, timeout)
    pending.set(id,{resolve,reject,timer}); send({id,method,params})
  })
  const close = async () => {
    closing=true
    clearTimeout(lifetime)
    lines.close(); child.stdin.end(); child.kill('SIGTERM')
    if (!exited) await new Promise<void>(resolve => {const timer=setTimeout(()=>{child.kill('SIGKILL');resolve()},2000);child.once('exit',()=>{clearTimeout(timer);resolve()})})
    rejectAll()
  }
  try {
    await rpc('initialize',{clientInfo:{name:'fleet_private_plugin_publisher',title:'Fleet Private Plugin Publisher',version:'0.1.0'},capabilities:{experimentalApi:true,explicitGatewayOauth:true}})
    send({method:'initialized',params:{}})
    const account=await rpc('account/read',{refreshToken:false})
    requireValue(account.account?.type==='chatgpt','authorization_required')
    const effective=await rpc('config/read',{includeLayers:false})
    const started=await rpc('thread/start',{cwd:tmpdir(),ephemeral:true,sandbox:'read-only',approvalPolicy:'never',model:'gpt-5.6-terra',config:publisherRuntimeConfig(effective.config),baseInstructions:'You perform only the exact owner-approved Plugin Creator update requested. No shell, browsing, file changes, retries, plugin creation, or other operations.',developerInstructions:'The archive is immutable and prevalidated. Invoke the specified update_plugin once with the exact three arguments. Do not inspect or modify other files or plugins. Report the tool outcome and stop. Do not claim success without the tool result.'})
    const threadId=started.thread.id
    const apps=await rpc('app/installed',{threadId,forceRefresh:true})
    requireValue(apps.apps?.some((a:any)=>a.id==='connector_openai_plugin_creator'&&a.isEnabled!==false&&a.isCallable!==false),'authorization_required')
    const found=new Set<string>(); let cursor: string|undefined
    for(let page=0;page<20;page++){
      const inventory=await rpc('mcpServerStatus/list',{threadId,detail:'toolsAndAuthOnly',limit:100,...(cursor?{cursor}:{})})
      for(const server of inventory.data||[]) if(server.name==='codex_apps')for(const [key,t] of Object.entries<any>(server.tools||{}))found.add(t.name||key)
      cursor=inventory.nextCursor;if(!cursor)break
    }
    const readTool='plugin_creator.get_plugin_files',updateTool='plugin_creator.update_plugin'
    const archiveTool='plugin_creator.get_owned_plugin_archive'
    requireValue(found.has(readTool)&&found.has(updateTool)&&found.has(archiveTool),'authorization_required')
    const call=async(tool:string,args:unknown)=>{
      const raw=await rpc('mcpServer/tool/call',{threadId,server:'codex_apps',tool,arguments:args},90000)
      const result=raw.result??raw
      requireValue(!result.isError,'publisher_unavailable')
      let value=result.structuredContent
      if(!value)for(const c of result.content||[])if(c.type==='text'){try{value=JSON.parse(c.text);break}catch{}}
      requireValue(value,'publisher_unavailable');return value.result??value
    }
    const update=async(archive:string,expected:string)=>{
      const invocations:any[]=[]
      const began=Date.now()
      let turnDiagnostic:PublisherSafeDiagnostic|undefined
      let resolveTurn:()=>void,rejectTurn:(error:Error)=>void
      const done=new Promise<void>((resolve,reject)=>{resolveTurn=resolve;rejectTurn=reject})
      void done.catch(()=>{})
      // The normal tool handler resolves openai/fileParams. Raw MCP calls do not.
      abortUpload=rejectTurn
      const timer=setTimeout(()=>rejectTurn(new PublisherDiagnosticError({stage:'native_upload',category:'timeout',event:'turn_timeout'})),dependencies.uploadTimeoutMs??120000)
      observeTurn=m=>{
        if(m.params?.threadId!==threadId)return
        if(m.method==='item/completed'&&m.params.item?.type==='mcpToolCall')invocations.push(m.params.item)
        if(m.method==='error')turnDiagnostic=publisherSafeDiagnostic('native_upload',m.params.error)
        if(m.method==='turn/completed'){
          if(m.params.turn?.status==='completed')resolveTurn()
          else if(m.params.turn?.status==='interrupted')rejectTurn(new PublisherDiagnosticError({stage:'native_upload',category:'interrupted',event:'turn_interrupted'}))
          else rejectTurn(new PublisherDiagnosticError({...((m.params.turn?.error?publisherSafeDiagnostic('native_upload',m.params.turn.error):turnDiagnostic)||{stage:'native_upload',category:'unknown'}),event:'turn_failed'}))
        }
      }
      try{
        await rpc('turn/start',{threadId,effort:'low',input:[{type:'text',text:uploadTurnRequest(archive,expected,packageId)},{type:'mention',name:'Plugin Creator',path:'app://connector_openai_plugin_creator'}]})
        await done
        console.info('[plugin-publisher] native upload receipt',JSON.stringify({elapsedMs:Date.now()-began,calls:invocations.map(item=>({server:item.server==='codex_apps'?'codex_apps':'unexpected',tool:['plugin_creator.update_plugin','plugin_creator.get_plugin_files','plugin_creator.get_owned_plugin_archive'].includes(item.tool)?item.tool:'unexpected',status:['inProgress','completed','failed'].includes(item.status)?item.status:'unknown',error:Boolean(item.error||item.result?.isError),...(item.status!=='completed'||item.error||item.result?.isError?{diagnostic:publisherSafeDiagnostic('native_upload',item.error)}:{})}))}))
        requireValue(invocations.length===1,'verification_failed')
        verifyUploadInvocation(invocations[0],archive,expected,packageId)
      }catch(error){
        const diagnostic=error instanceof PublisherDiagnosticError?error.diagnostic:publisherSafeDiagnostic('native_upload',error)
        console.warn('[plugin-publisher] native upload failed',JSON.stringify({...diagnostic,elapsedMs:Date.now()-began,callCount:invocations.length}))
        throw error
      }finally{clearTimeout(timer);observeTurn=undefined;abortUpload=undefined;done.catch(()=>{})}
    }
    const read=async(paths=FILES,binaryPaths:string[]=[])=>{
      const hasApp=Object.values(PUBLISH_TARGETS).find(t=>t.packageId===packageId)?.appId
      const result=await call(readTool,{plugin_id:packageId,read_paths:FILES.slice(0,5).filter(path=>hasApp||path!=='.app.json')})
      let offset=result.next_offset
      for(let page=0;offset!=null&&page<20;page++){
        const next=await call(readTool,{plugin_id:packageId,offset})
        requireValue(next.plugin.current_release_id===result.plugin.current_release_id,'platform_conflict')
        result.files.push(...next.files);offset=next.next_offset
      }
      requireValue(offset==null&&result.files.length<=250,'source_changed')
      const available=new Set<string>(result.files.map((f:any)=>f.path))
      const texts=paths.filter(p=>available.has(p)&&!binaryPaths.includes(p)&&!Object.hasOwn(result.contents,p))
      for(let i=0;i<texts.length;i+=10){
        const next=await call(readTool,{plugin_id:packageId,read_paths:texts.slice(i,i+10)})
        requireValue(next.plugin.current_release_id===result.plugin.current_release_id,'platform_conflict')
        Object.assign(result.contents,next.contents)
      }
      if(binaryPaths.length){
        const owned=await call(archiveTool,{plugin_id:packageId,release_id:result.plugin.current_release_id})
        requireValue(owned.plugin.plugin_id===packageId&&owned.release.release_id===result.plugin.current_release_id,'identity_mismatch')
        const url=new URL(owned.download_url)
        requireValue(url.protocol==='https:'&&url.hostname.endsWith('.oaiusercontent.com')&&!url.username&&!url.password&&!url.port,'verification_failed')
        const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)})
        requireValue(response.ok,'verification_failed')
        result.binaryContents=ownedTarFiles(await bytes(response,8*1024*1024),binaryPaths.filter(path=>available.has(path)))
      }
      return result
    }
    return {read,update,close}
  } catch(error) {await close(); throw error}
}

function sameText(path: string, a: string, b: string) {
  if (typeof a!=='string'||typeof b!=='string')return false
  if(path.endsWith('.json')){try{
   const normalized=(text:string)=>{
    const value=JSON.parse(text)
    if(path==='.mcp.json')for(const server of Object.values<any>(value.mcpServers||{})){
     if(server.type==='http')server.type='streamable-http'
     if(server.headers&&Object.keys(server.headers).length===0)delete server.headers
    }
    if(path==='.codex-plugin/plugin.json'){
     if(typeof value.skills==='string')value.skills=value.skills.replace(/\/$/,'')
     if(Array.isArray(value.interface?.keywords)&&value.interface.keywords.length===0)delete value.interface.keywords
    }
    return value
   }
   return isDeepStrictEqual(normalized(a),normalized(b))
  }catch{return false}}
  return a===b
}
/** Read owned tar.gz without filesystem extraction or executing bundled files. */
export function ownedTarFiles(compressed:Buffer,paths:string[]) {
  const data=gunzipSync(compressed,{maxOutputLength:12*1024*1024}),result:Record<string,string>={}
  let offset=0
  while(offset+512<=data.length){
    const header=data.subarray(offset,offset+512);if(header.every(b=>b===0))break
    const string=(a:number,b:number)=>header.subarray(a,b).toString('utf8').replace(/\0.*$/s,'')
    const checksum=parseInt(string(148,156).trim(),8),sum=header.reduce((n,b,i)=>n+(i>=148&&i<156?32:b),0)
    requireValue(checksum===sum,'verification_failed')
    const size=parseInt(string(124,136).trim()||'0',8),type=string(156,157),prefix=string(345,500)
    let path=(prefix?prefix+'/':'')+string(0,100);path=path.replace(/^\.\//,'')
    requireValue(Number.isSafeInteger(size)&&size>=0&&offset+512+size<=data.length&&!path.split('/').includes('..'),'verification_failed')
    if(paths.includes(path)){
      requireValue((type===''||type==='0')&&!Object.hasOwn(result,path),'verification_failed')
      result[path]=data.subarray(offset+512,offset+512+size).toString('base64')
    }
    offset+=512+Math.ceil(size/512)*512
  }
  requireValue(paths.every(p=>Object.hasOwn(result,p)),'verification_failed');return result
}
const allowedFile=(path:string)=>FILES.includes(path)||path==='README.md'||path==='assets/icon.png'||/^skills\/[a-z][a-z0-9-]{1,79}\/(?!.*(?:^|\/)\.)(?:[A-Za-z0-9_ -]+\/)*[A-Za-z0-9_ .-]+$/.test(path)&&!path.split('/').some(p=>p==='.'||p==='..'||p==='node_modules')
export function validateSource(snapshot:any,current:any) {
  const target=targetFor(snapshot)
  requireValue(current.plugin?.plugin_id===target.packageId&&current.plugin?.scope==='USER'&&current.plugin?.discoverability==='PRIVATE','identity_mismatch')
  requireValue(current.plugin.name===snapshot.packageName,'identity_mismatch')
  const next=JSON.parse(snapshot.files['plugin.json']),before=JSON.parse(current.contents['plugin.json'])
  requireValue(next.name===before.name&&next.version===snapshot.version,'identity_mismatch')
  if(target.appId){
   const app=JSON.parse(snapshot.files['.app.json'])
   requireValue(app.apps?.[snapshot.packageName]?.id===target.appId&&app.apps?.[snapshot.packageName]?.required===true&&Object.keys(app.apps).length===1,'identity_mismatch')
  }else requireValue(!snapshot.files['.app.json']&&!current.contents['.app.json']&&!next.extensions?.['com.openai']?.apps,'identity_mismatch')
  for(const path of ['.app.json','mcp.json','.mcp.json'])if(snapshot.files[path]!==undefined||current.contents[path]!==undefined)requireValue(sameText(path,snapshot.files[path],current.contents[path]),'source_changed')
  requireValue(JSON.stringify(next.extensions?.['com.openai']?.interface?.defaultPrompt)===JSON.stringify(before.extensions?.['com.openai']?.interface?.defaultPrompt),'source_changed')
  const paths=Object.keys(snapshot.files)
  requireValue(paths.length<=250&&paths.every(allowedFile)&&FILES.slice(0,5).filter(p=>target.appId||p!=='.app.json').every(p=>typeof snapshot.files[p]==='string'),'source_changed')
  requireValue((snapshot.binaryPaths||[]).every((p:string)=>paths.includes(p)&&allowedFile(p)),'source_changed')
  // Official update is an overlay: omission is NOT deletion. Fail before upload.
  requireValue((current.files||[]).filter((f:any)=>f.path.startsWith('skills/')||f.path==='README.md').every((f:any)=>paths.includes(f.path)),'platform_file_delete_unsupported')
}
export function verifyReadback(snapshot:any,current:any) {
  validateSource(snapshot,current)
  requireValue(current.plugin.version===snapshot.version&&/^pluginrel_[a-zA-Z0-9]+$/.test(current.plugin.current_release_id),'verification_failed')
  for(const path of Object.keys(snapshot.files)){
    if((snapshot.binaryPaths||[]).includes(path))requireValue(current.binaryContents?.[path]===snapshot.files[path],'verification_failed')
    else if(path!=='assets/icon.png')requireValue(sameText(path,snapshot.files[path],current.contents[path]),'verification_failed')
  }
  return current.plugin.current_release_id as string
}

async function bytes(response:Response,max=2*1024*1024):Promise<Buffer>{
  const chunks:Uint8Array[]=[];let size=0;const reader=response.body?.getReader()
  if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();fail('publisher_unavailable')}chunks.push(value)}
  return Buffer.concat(chunks)
}
export class PluginPublisher {
  private active = new Map<string,Promise<void>>()
  constructor(private options:{token:string; origin?:string; fetch?:typeof fetch; platform?:()=>Promise<Platform>}){}
  private async request(id:string,action:string,body?:unknown):Promise<any>{
    requireValue(/^[a-f0-9-]{36}$/.test(id),'invalid_release')
    const origin=this.options.origin||'https://fleet.vyibc.com'
    requireValue(['https://fleet.vyibc.com','https://fleet-console.2513120790.workers.dev'].includes(origin),'publisher_unavailable')
    requireValue(this.options.token.length>=24,'publisher_unavailable')
    const response=await (this.options.fetch||fetch)(origin+'/api/hub/publication/executor/'+action+'?id='+id,{method:body?'POST':'GET',headers:{authorization:'Bearer '+publisherToken(this.options.token),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000),redirect:'error'})
    const data=await bytes(response)
    if(action==='archive'){requireValue(response.ok,'publisher_unavailable');return data}
    const parsed=JSON.parse(data.toString());requireValue(response.ok&&parsed.ok===true,parsed.error==='job_not_claimable'?'job_not_claimable':'publisher_unavailable');return parsed
  }
  async status(id:string){const data=await this.request(id,'job');return {ok:true,...data.job,retryAfterSeconds:10}}
  async start(id:string){
    const initial=await this.status(id)
    if(initial.state==='verified'||initial.state==='blocked'||this.active.has(id))return initial
    if(initial.state!=='queued'&&(!initial.leaseUntil||Date.parse(initial.leaseUntil)>Date.now()))return initial
    // The claim is persisted before returning. Concurrent Task turns cannot upload twice.
    let claim:string
    try{claim=(await this.request(id,'claim',{})).claim}catch(error){if((error as Error).message==='job_not_claimable')return this.status(id);throw error}
    const work=this.execute(id,claim).catch(()=>{}).finally(()=>this.active.delete(id))
    this.active.set(id,work)
    return {ok:true,...initial,state:'running',retryAfterSeconds:10}
  }
  async settled(id:string){await this.active.get(id);return this.status(id)}
  private async execute(id:string,claim:string){
    let platform:Platform|undefined,directory:string|undefined,mutationAttempted=false
    try{
      const data=await this.request(id,'job'),s=data.snapshot
      const archive=await this.request(id,'archive')
      requireValue(createHash('sha256').update(archive).digest('hex')===data.archiveSha,'archive_integrity_failed')
      const approved=targetFor(s)
      platform=await (this.options.platform?this.options.platform():openPluginCreator(undefined,approved.packageId))
      const paths=Object.keys(s.files),binaryPaths=s.binaryPaths||[]
      let current=await platform.read(paths,binaryPaths);validateSource(s,current)
      if(current.plugin.version!==s.version){
        requireValue(current.plugin.current_release_id===data.job.expectedReleaseId,'platform_conflict')
        directory=await mkdtemp(join(tmpdir(),'fleet-plugin-publish-'))
        const path=join(directory,'release.zip');await writeFile(path,archive,{mode:0o600})
        mutationAttempted=true
        await platform.update(path,data.job.expectedReleaseId)
        current=await platform.read(paths,binaryPaths)
      }
      if(current.plugin.version===s.version&&binaryPaths.length&&!current.binaryContents)current=await platform.read(paths,binaryPaths)
      const releaseId=verifyReadback(s,current)
      requireValue(releaseId!==data.job.expectedReleaseId,'verification_failed')
      await this.request(id,'finish',{claim,pluginId:approved.packageId,version:s.version,releaseId,archiveSha:data.archiveSha})
    }catch(error){
      const allowed=['platform_conflict','identity_mismatch','archive_integrity_failed','source_changed','authorization_required','verification_failed','platform_file_delete_unsupported']
      const reason=mutationAttempted?'unknown_outcome':allowed.includes((error as Error).message)?(error as Error).message:'publisher_unavailable'
      const diagnostic=error instanceof PublisherDiagnosticError?error.diagnostic:{...publisherSafeDiagnostic('publisher',error),event:'publish_failed' as const}
      console.warn('[plugin-publisher] publish failed',JSON.stringify({releaseId:id,outcome:reason,diagnostic}))
      await this.request(id,'finish',{claim,error:reason}).catch(()=>{})
    }finally{if(platform)await platform.close();if(directory)await rm(directory,{recursive:true,force:true})}
  }
}
