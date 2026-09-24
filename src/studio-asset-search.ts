/** Page-filtered catalog search. Exact matches and query-free discovery remain
 * separate; both use the original credential and all non-query filters. */
export function assetSearchPage(result:any):any {
 if(result?.structuredContent)return result.structuredContent
 for(const item of result?.content??[])if(item.type==='text')try{return JSON.parse(item.text)}catch{}
 return result
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
   if(result?.isError||!Array.isArray(nextValue?.assets)||nextValue.studioSearch)return {passthrough:result}
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
 if(exact.passthrough)return exact.passthrough
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
 return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload}
}
