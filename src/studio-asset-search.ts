/** The catalog filters each storage page, not the whole library. Empty pages
 * with a cursor are not an empty search. Keep all filters and credential scope. */
export function assetSearchPage(result:any):any {
 if(result?.structuredContent)return result.structuredContent
 for(const item of result?.content??[])if(item.type==='text')try{return JSON.parse(item.text)}catch{}
 return result
}
export async function searchStudioAssets(args:any,invoke:(args:any)=>Promise<any>,maxPages=20){
 let cursor=args.cursor,scanned=0,pages=0
 const seen=new Set<string>()
 if(cursor)seen.add(cursor)
 while(pages<maxPages){
  const result=await invoke({...args,...(cursor?{cursor}:{})}),value=assetSearchPage(result)
  if(result?.isError||!Array.isArray(value?.assets))return result
  pages++;scanned+=Number.isFinite(value.scanned)?value.scanned:0
  const next=value.next_cursor
  if(next!==null&&next!==undefined&&typeof next!=='string')throw Error('studio-asset-search-invalid-cursor')
  const repeated=!!next&&seen.has(next),stop=value.assets.length>0||!next||repeated||pages===maxPages
  if(stop){
   const discoveryArgs={...args};delete discoveryArgs.query;delete discoveryArgs.cursor
   const recovery=value.assets.length===0?{
    nextAction:repeated?'report_provider_cursor_problem':next?'continue_same_search_or_inspect_catalog':'inspect_catalog',
    ...(next&&!repeated?{continueCall:{tool:'asset_search',arguments:{...args,cursor:next}}}:{}),
    ...(typeof args.query==='string'&&args.query.trim()?{catalogDiscovery:{tool:'asset_search',arguments:discoveryArgs,scope:'Explicit separate discovery without query; all other filters and credential scope preserved. These would be catalog candidates, not matches for the original query.'}}:{}),
    guidance:'This is page-filtered catalog search, not semantic web search. Do not keep swapping long multiword mood descriptions after empty pages. Continue the exact cursor, or inspect the catalog with query omitted and choose from actual titles/tags; inspect rights and audio before choosing.'
   }:undefined
   const payload={...(recovery?{searchRecovery:recovery}:{}),...value,scanned,studioSearch:{pages,exhausted:!next,partial:!!next,cursorRepeated:repeated,
    instruction:repeated?'The provider repeated its cursor. Do not loop or claim complete search; report the provider issue.':next?'Continue with the returned next_cursor and identical filters if more results are needed. Empty partial pages do not mean the library is empty.':'Search exhausted for these exact filters. If empty, use one keyword or omit query while retaining kind to inspect catalog tags. Do not repeat reordered multiword queries. Inspect asset details, rights and actual audio before use; registration is not approval.'}}
   return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload}
  }
  seen.add(next);cursor=next
 }
 throw Error('studio-asset-search-page-budget-invalid')
}
