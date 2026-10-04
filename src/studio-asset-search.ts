/** Page-filtered catalog search. Exact matches and query-free discovery remain
 * separate; both use the original credential and all non-query filters. */
export function assetSearchPage(result:any):any {
 if(result?.structuredContent)return result.structuredContent
 for(const item of result?.content??[])if(item.type==='text')try{return JSON.parse(item.text)}catch{}
 return result
}
const MAX_SUMMARY_BYTES=24_000,MAX_PAGE_ASSETS=100
const object=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v)
const short=(v:any,max=240)=>typeof v==='string'?v.slice(0,max):undefined
const positive=(v:any)=>typeof v==='number'&&Number.isFinite(v)&&v>0
/** Search is an index, not the full asset document. IDs and candidate order are never truncated. */
function assetSummary(asset:any){
 if(!object(asset)||typeof asset.id!=='string'||!asset.id||asset.id.length>200)throw Error('invalid_candidate_identity')
 const summary:any={id:asset.id}
 for(const key of ['kind','title','name','author','source_type','review_status'])if(typeof asset[key]==='string')summary[key]=short(asset[key],key==='title'||key==='name'?240:100)
 for(const key of ['tags','use_cases','character_ids'])if(Array.isArray(asset[key])){
  const valid=asset[key].filter((v:any)=>typeof v==='string');summary[key]=valid.slice(0,16).map((v:string)=>short(v,100))
  if(valid.length>16)summary[key+'Omitted']=valid.length-16
 }
 const duration=[asset.duration_seconds,asset.durationSeconds,asset.duration,asset.metadata?.duration_seconds,asset.media?.durationSeconds].find(positive)
 if(duration!==undefined)summary.durationSeconds=duration
 if(asset.object===null)summary.object=null
 else if(object(asset.object)){
  summary.object={}
  if(typeof asset.object.sha256==='string'&&/^[a-f0-9]{64}$/i.test(asset.object.sha256))summary.object.sha256=asset.object.sha256
  for(const key of ['bytes','size'])if(positive(asset.object[key]))summary.object[key]=asset.object[key]
  if(typeof asset.object.content_type==='string')summary.object.content_type=short(asset.object.content_type,100)
 }
 if(object(asset.license)){
  summary.license={}
  for(const key of ['status','scope','type'])if(typeof asset.license[key]==='string')summary.license[key]=short(asset.license[key],160)
  if(typeof asset.license.archive_allowed==='boolean')summary.license.archive_allowed=asset.license.archive_allowed
 }
 summary.archiveState=asset.object===null?'source_card':object(asset.object)?'archived':'unknown'
 summary.downloadVerified=false;summary.rightsApproved=false;summary.details={tool:'asset_get',arguments:{id:asset.id}}
 return summary
}
function compactPage(page:any){
 if(!object(page)||!Array.isArray(page.assets)||page.assets.length>MAX_PAGE_ASSETS)throw Error('candidate_page_limit_or_shape')
 if(page.next_cursor!==undefined&&page.next_cursor!==null&&(typeof page.next_cursor!=='string'||page.next_cursor.length>4096))throw Error('cursor_shape_or_limit')
 const result:any={assets:page.assets.map(assetSummary),next_cursor:page.next_cursor??null}
 if(typeof page.scanned==='number'&&Number.isFinite(page.scanned))result.scanned=page.scanned
 if(typeof page.note==='string')result.note=short(page.note,400)
 return result
}
/** Exported for offline, original-result size audits. Never mutates stored/catalog data. */
export function summarizeStudioAssetSearchResult(result:any,originalArguments:any){
 if(result?.isError)return result
 const payload=assetSearchPage(result)
 if(!object(payload)||payload.ok===false||payload.error||payload.error_code||!Array.isArray(payload.assets))return result
 try{
  const exact=compactPage(payload),summary:any={...(payload.searchRecovery?{searchRecovery:payload.searchRecovery}:{}),...exact}
  if(payload.catalogDiscovery){
   const catalog=payload.catalogDiscovery
   if(catalog.available===false)summary.catalogDiscovery={available:false,error:{error_code:'catalog-discovery-failed'},guidance:'Keep the exact search continuation; catalog lookup did not succeed.'}
   else{
    const compact=compactPage(catalog)
    summary.catalogDiscovery={scope:catalog.scope,arguments:catalog.arguments,...compact}
    for(const key of ['pages','exhausted','partial','cursorRepeated','timedOut','continueCall'])if(catalog[key]!==undefined)summary.catalogDiscovery[key]=catalog[key]
    summary.catalogDiscovery.availability=compact.assets.map((a:any)=>({assetId:a.id,kind:a.kind,archiveState:a.archiveState,downloadVerified:false,rightsApproved:false}))
    summary.catalogDiscovery.guidance='Catalog candidates are NOT exact query matches. Use asset_get for full source, license and acquisition details before selecting or downloading.'
   }
  }
  if(payload.studioSearch)summary.studioSearch=payload.studioSearch
  summary.searchProjection={schema:'studio-asset-search-summary-v1',candidateCount:exact.assets.length,catalogCandidateCount:summary.catalogDiscovery?.assets?.length??0,metadataOnly:true,detailsTool:'asset_get',notice:'All candidate IDs and order are preserved; descriptive strings and tags are bounded. Full profiles, provenance, embedded data and download URLs are omitted from this index. Use asset_get by exact ID. Archived/source-card status is metadata, not verified download, rights or quality approval.'}
  const text=JSON.stringify(summary)
  if(Buffer.byteLength(text,'utf8')>MAX_SUMMARY_BYTES)throw Error('summary_budget_exceeded')
  return {content:[{type:'text',text}],structuredContent:summary}
 }catch{
  // Never shorten the candidate array while returning the provider's advanced cursor.
  const retryArguments={...originalArguments,limit:Math.max(1,Math.min(5,Math.floor((Number(originalArguments?.limit)||10)/2)))}
  const failure={error_code:'studio-asset-search-summary-unavailable',partial:true,candidatesDelivered:false,retryArguments,
   nextAction:'The upstream page could not be represented safely within the search summary budget. No candidate subset or advanced cursor is returned. Retry at this original input cursor with the smaller limit; all other filters remain unchanged. If the provider ignores limit or repeats this error, report the capability failure instead of looping. Use asset_get only for IDs already obtained from a valid page.'}
  return {isError:true,content:[{type:'text',text:JSON.stringify(failure)}],structuredContent:failure}
 }
}
export async function searchStudioAssets(args:any,invoke:(args:any)=>Promise<any>,maxPages=20,options:{timeoutMs?:number}={}){
 const timeoutMs=options.timeoutMs??30_000
 if(!Number.isInteger(maxPages)||maxPages<1||maxPages>20||!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>60_000)throw Error('studio-asset-search-page-budget-invalid')
 const original=structuredClone(args),discoveryArgs={...original};delete discoveryArgs.query;delete discoveryArgs.cursor
 const hasQuery=typeof original.query==='string'&&!!original.query.trim(),discover=hasQuery&&maxPages>1
 const deadline=Date.now()+timeoutMs;let requests=0
 const timeout=Symbol('timeout')
 async function scan(filters:any,budget:number):Promise<any>{
  let cursor=filters.cursor,scanned=0,pages=0,value:any={assets:[],next_cursor:cursor??null},repeated=false,timedOut=false,complete=false
  const seen=new Set<string>();if(cursor)seen.add(cursor)
  while(pages<budget&&requests<maxPages){
   const remaining=deadline-Date.now();if(remaining<=0){timedOut=true;break}
   let timer:ReturnType<typeof setTimeout>|undefined
   requests++
   const call={...filters,...(cursor?{cursor}:{})}
   const result=await Promise.race([Promise.resolve().then(()=>invoke(call)),new Promise(resolve=>{timer=setTimeout(()=>resolve(timeout),remaining)})]).finally(()=>clearTimeout(timer))
   if(result===timeout){timedOut=true;break}
   const nextValue=assetSearchPage(result)
   // Never multiply an already bounded upstream wrapper into 20 * 20 calls.
   if(result?.isError||nextValue?.ok===false||nextValue?.error||nextValue?.error_code||!Array.isArray(nextValue?.assets)||nextValue.studioSearch)return {passthrough:result}
   pages++;value=nextValue;scanned+=Number.isFinite(value.scanned)?value.scanned:0
   const next=value.next_cursor
   if(next!==null&&next!==undefined&&typeof next!=='string')throw Error('studio-asset-search-invalid-cursor')
   repeated=!!next&&seen.has(next);complete=!next
   if(value.assets.length||complete||repeated)break
   seen.add(next);cursor=next
  }
  return {value,scanned,pages,exhausted:complete,partial:!complete,cursorRepeated:repeated,timedOut,
   // A timed-out page must be retried at its input cursor, never skipped.
   continueArgs:timedOut?{...filters,...(cursor?{cursor}:{})}:value.next_cursor&&!repeated?{...filters,cursor:value.next_cursor}:undefined}
 }
 const exact=await scan(original,discover?Math.ceil(maxPages/2):maxPages)
 if(exact.passthrough)return summarizeStudioAssetSearchResult(exact.passthrough,original)
 let catalog:any
 if(discover&&!exact.value.assets.length&&!exact.cursorRepeated&&!exact.timedOut&&requests<maxPages){
  const found=await scan(discoveryArgs,maxPages-requests).catch(()=>({passthrough:{isError:true,error_code:'catalog-discovery-failed'}}))
  catalog=found.passthrough?{available:false,error:found.passthrough}: {
   scope:'Catalog candidates with query omitted; NOT matches for the original query. Every other filter and credential scope is unchanged.',
   arguments:discoveryArgs,assets:found.value.assets,next_cursor:found.value.next_cursor,scanned:found.scanned,
   pages:found.pages,exhausted:found.exhausted,partial:found.partial,cursorRepeated:found.cursorRepeated,timedOut:found.timedOut,
   ...(found.continueArgs?{continueCall:{tool:'asset_search',arguments:found.continueArgs}}:{}),
   availability:found.value.assets.map((asset:any)=>({assetId:asset.id,kind:asset.kind,
    archiveState:asset.object===null?'source_card':asset.object&&typeof asset.object==='object'?'archived':'unknown',
    downloadVerified:false,rightsApproved:false})),
   guidance:'Inspect asset_get and actual audio before selection. A source card has no archived file. Archived metadata is not a successful download, permission for this project, or listening approval. Do not invent file URLs.'
  }
 }
 const recovery=exact.value.assets.length===0?{
  nextAction:exact.cursorRepeated?'report_provider_cursor_problem':catalog?.assets?.length?'inspect_catalog_candidates':exact.partial?'continue_same_search_or_inspect_catalog':'inspect_catalog',
  ...(exact.continueArgs?{continueCall:{tool:'asset_search',arguments:exact.continueArgs}}:{}),
  ...(hasQuery?{catalogDiscovery:{tool:'asset_search',arguments:discoveryArgs,scope:'Explicit separate discovery without query; all other filters and credential scope preserved. These are not matches for the original query.'}}:{}),
  guidance:'Do not restart reordered multiword queries. Inspect separately labelled catalog candidates, or resume the exact returned continuation. No music was selected or approved.'
 }:undefined
 const payload={...(recovery?{searchRecovery:recovery}:{}),...exact.value,scanned:exact.scanned,...(catalog?{catalogDiscovery:catalog}:{}),studioSearch:{pages:exact.pages,exhausted:exact.exhausted,partial:exact.partial,cursorRepeated:exact.cursorRepeated,timedOut:exact.timedOut,totalRequests:requests,maxPages,timeoutMs,
  instruction:'Exact query assets and catalogDiscovery.assets have different meanings. Continue each using its own cursor and filters. Empty partial results do not mean the library is empty.'}}
 return summarizeStudioAssetSearchResult({content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload},original)
}
