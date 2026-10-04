import {createHash} from 'node:crypto'
import {publicToolName} from './filtered-mcp-client.js'

export interface StudioToolProgress {
 tool:string;inputSha256:string;errorFingerprint?:string;errorSummary?:string;
 search:boolean;acquired:boolean;poll:boolean;repaired?:boolean
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const object=(value:any)=>value!==null&&typeof value==='object'&&!Array.isArray(value)
function canonical(value:any):any {
 return Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
}
function parsed(value:any):any {if(typeof value==='string'){try{return JSON.parse(value)}catch{}}return value}
const POLLS=['vyibc-voice_status','vyibc-voice_result','vyibc-image_get_task','studio_render_status']
function toolName(name:string){
 const qualified=/^mcp__(.+?)__(.+)$/.exec(name)
 if(!qualified)return name
 // Recover only an exact known public-name encoding, never guess from a prefix.
 for(const raw of [...POLLS,'asset_search','asset_get'])if(publicToolName(qualified[1],raw)===name)return raw
 return qualified[2]
}
/** Unwrap actual DSH result messages, canonical tool values and MCP envelopes.
 * Multiple content payloads are deliberately not merged into a success receipt. */
function payload(result:any):any {
 let value=result
 for(let depth=0;depth<10;depth++){
  if(value instanceof Error)return value
  const next=parsed(value);if(next!==value){value=next;continue}
  if(Array.isArray(value)&&value.length===1){value=value[0];continue}
  if(!object(value))return value
  if(value.structuredContent!==undefined){value=value.structuredContent;continue}
  if(value.value!==undefined){value=value.value;continue}
  if(value.message!==undefined){value=value.message;continue}
  if(value.data?.message!==undefined){value=value.data.message;continue}
  if(value.type==='text'&&typeof value.text==='string'){value=value.text;continue}
  if(Array.isArray(value.content)&&value.content.length===1){value=value.content[0];continue}
  return value
 }
 return undefined
}
function failed(result:any,depth=0):boolean {
 if(depth>10)return false
 if(result instanceof Error)return true
 const value=parsed(result)
 if(value!==result)return failed(value,depth+1)
 if(Array.isArray(value))return value.some(entry=>failed(entry,depth+1))
 if(!object(value))return false
 if(value.isError===true||value.ok===false||(value.ok!==true&&(value.error!==undefined&&value.error!==null&&value.error!==false||typeof value.error_code==='string')))return true
 return ['structuredContent','value','message'].some(key=>value[key]!==undefined&&failed(value[key],depth+1))
  ||!!value.data?.message&&failed(value.data.message,depth+1)
  ||Array.isArray(value.content)&&value.content.some((entry:any)=>failed(entry,depth+1))
}
function safeField(value:any):string|undefined {
 if(typeof value!=='string'||value.length>100||!/^(?:\$\.)?[A-Za-z][A-Za-z0-9_]*(?:\[\d+\]|\.[A-Za-z][A-Za-z0-9_]*)*$/.test(value)||/secret|token|password|authorization|cookie|credential|api.?key/i.test(value))return
 if(!/^(?:\$\.)?(?:root|arguments|lines|sources|outputs|manifest|board|scenes|script|plan|bgm|sfx|layers|audio|duration|tracks|segments|items|reference|visualRequirements|path|storyboard|visualPlan|executionBoard|sidecar|characterIds|requirements|components|mappings|componentId|requirementId|componentKey|sceneIndex|layerIndex|sha256|kind|usage)(?:[.[]|$)/.test(value))return
 return value.replace(/\[\d+\]/g,'[]')
}
function safeReason(value:any):string|undefined {
 // Validator reasons are stable machine slugs. Never copy prose, paths,
 // provider messages, or arbitrary model-authored text into durable run errors.
 if(typeof value!=='string'||value.length>96||!/^[a-z0-9]+(?:-[a-z0-9]+){0,10}$/.test(value)||/secret|token|password|authorization|cookie|credential|api.?key/i.test(value))return
 return value
}
function normalizeError(text:string){
 return text.replace(/https?:\/\/[^\s"'<>]+/gi,'<url>')
  .replace(/(["'])(?:\/|[A-Za-z]:\\).*?\1/g,'<path>')
  .replace(/(?:[A-Za-z]:\\|\/?(?:[A-Za-z0-9_.-]+\/)+)[^\s"'<>;,]*/g,'<path>')
  .replace(/\[\d+\]/g,'[]').replace(/\s+/g,' ').trim()
}
function errorInfo(result:any,tool:string){
 const value=payload(result),message=typeof result?.error?.message==='string'?result.error.message:value instanceof Error?value.message:typeof value==='string'?value:typeof value?.error?.message==='string'?value.error.message:typeof value?.error==='string'?value.error:typeof value?.message==='string'?value.message:Array.isArray(value?.content)?value.content.filter((entry:any)=>entry?.type==='text'&&typeof entry.text==='string').map((entry:any)=>entry.text).join('\n'):''
 const start=message.indexOf('{');let detail:any=value
 if(start>=0){try{detail=JSON.parse(message.slice(start))}catch{}}
 const code=typeof detail?.error_code==='string'?detail.error_code:message.match(/^(?:Error:\s*)?([A-Za-z][A-Za-z0-9_-]+)(?::|$)/)?.[1]
 const publicCode=typeof code==='string'&&/^(?:studio-[a-z0-9-]{1,90}|blocked_quality_capability|ENOENT|EINVAL|EACCES|EPERM|ETIMEDOUT)$/.test(code)&&!/secret|token|password|authorization|cookie|credential/i.test(code)?code:'tool-error'
 const field=safeField(detail?.field)
 // The hash retains distinctions in reason/missing/other error text; none of
 // that provider-controlled body is copied into the model-facing summary.
 const noisy=new Set(['action','nextAction','retryable','retryAfterRepair','requiresHuman','qualityApproved','tool','arguments','manifestSchema','eligibleExistingMedia','scan','pathContract'])
 const body=object(detail)&&!(detail instanceof Error)?Object.fromEntries(Object.entries(detail).filter(([key])=>!noisy.has(key))):message
 const reason=safeReason(detail?.reason)
 return {errorFingerprint:hash({tool,error:normalizeError(typeof body==='string'?body:JSON.stringify(canonical(body)))}),errorSummary:[publicCode,field&&`at ${field}`,reason&&`(${reason})`].filter(Boolean).join(' ').slice(0,200)}
}
/** Classify a completed dispatch only. This does not select media, approve rights,
 * count attempts, or claim that an asset_get response is a verified download. */
export function classifyStudioTool(exec:{name:string;arguments:unknown},result?:unknown):StudioToolProgress {
 const tool=toolName(exec.name),args=parsed(exec.arguments),poll=POLLS.includes(tool)
 const progress:StudioToolProgress={tool,inputSha256:hash(canonical(args)??null),search:tool==='asset_search',acquired:false,poll}
 if(poll)return progress
 const value=payload(result),isFailure=failed(result)||failed(value)
 if(isFailure)return {...progress,...errorInfo(result,tool)}
 if(tool==='asset_get'&&object(value?.asset)&&!Array.isArray(value?.assets)&&typeof args?.id==='string'&&args.id.length>0&&value.asset.id===args.id&&typeof value.asset.kind==='string'&&value.asset.kind.length>0)progress.acquired=true
 if(tool==='studio_download_asset'&&value?.ok===true&&value.assetId===args?.id&&typeof args?.id==='string'&&!!args.id&&typeof value.path==='string'&&!!value.path&&/^[a-f0-9]{64}$/.test(value.sha256??'')&&Number.isInteger(value.bytes)&&value.bytes>0&&value.bytes<=20_000_000&&['image','voice','sfx','bgm','reference'].includes(value.kind)&&typeof value.reused==='boolean'&&value.newGeneration===0)progress.acquired=true
 if(tool==='studio_register_stage'&&['storyboard','visual','sound'].includes(value?.stage)&&Number.isInteger(value.round)&&value.round>0&&['batchId','sessionId','cardId'].every(key=>typeof value[key]==='string'&&value[key].length>0)&&/^[a-f0-9]{64}$/.test(value.configSha256??'')&&typeof value.manifest?.path==='string'&&/^[a-f0-9]{64}$/.test(value.manifest?.sha256??'')&&Array.isArray(value.outputs)&&value.outputs.length>0&&value.outputs.every((file:any)=>typeof file?.path==='string'&&!!file.path&&/^[a-f0-9]{64}$/.test(file.sha256??'')&&Number.isInteger(file.bytes)&&file.bytes>0)&&value.qualityApproved===false)progress.repaired=true
 return progress
}
