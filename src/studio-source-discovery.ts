/** Read-only metadata discovery. Never downloads, selects a baseline or approves quality. */
export type StudioSourceTool='character_search'|'character_get'|'character_assets'|'asset_get'
const TOOLS=new Set<StudioSourceTool>(['character_search','character_get','character_assets','asset_get'])
const ID=/^(?:[a-f0-9]{64}|[a-f0-9]{32}-[a-f0-9]{64})$/
const object=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v)
function unpack(result:any){
 if(result?.isError)throw Error('provider_error')
 let value=result?.structuredContent
 if(!value){const text=result?.content?.find((c:any)=>c.type==='text')?.text;if(text){if(text.length>256_000)throw Error('response_too_large');try{value=JSON.parse(text)}catch{throw Error('metadata_invalid')}}else value=result}
 if(!object(value)||JSON.stringify(value).length>256_000)throw Error('metadata_invalid')
 return value
}
function reference(asset:any,id:string,characterId:string){
 if(!object(asset)||asset.id!==id||asset.kind!=='reference'||!Array.isArray(asset.character_ids)||!asset.character_ids.includes(characterId))return undefined
 const binding=asset.technical?.studio_reference
 if(!object(binding)||binding.schema!=='studio-reference-v1'||binding.character_id!==characterId||typeof binding.sha256!=='string'||!/^[a-fA-F0-9]{64}$/.test(binding.sha256))return undefined
 if(typeof asset.source_url!=='string'||asset.source_url.length>2048||!/^https:\/\/cdn\.vyibc\.com\//.test(asset.source_url)||/[?#\\\s]/.test(asset.source_url))return undefined
 let url:URL;try{url=new URL(asset.source_url)}catch{return undefined}
 if(url.hostname!=='cdn.vyibc.com'||url.protocol!=='https:'||url.username||url.password||url.port||url.pathname==='/')return undefined
 return {assetId:id,characterId,sourceUrl:asset.source_url,sha256:binding.sha256.toLowerCase(),
  title:typeof asset.title==='string'?asset.title:undefined,license:object(asset.license)?asset.license:null,
  status:'metadata_unverified',downloadVerified:false,qualityApproved:false,publishingApproved:false}
}
export async function resolveStudioSources(args:{query?:string;characterId?:string},invoke:(tool:StudioSourceTool,args:any)=>Promise<any>,options:{timeoutMs?:number}={}){
 if(!object(args)||Object.keys(args).some(k=>!['query','characterId'].includes(k))||args.query!==undefined&&(typeof args.query!=='string'||!args.query.trim()||args.query.length>300)||args.characterId!==undefined&&(typeof args.characterId!=='string'||!args.characterId.trim()||args.characterId.length>200)||!args.query&&!args.characterId)throw Error('studio-source-discovery-input-invalid')
 const timeoutMs=options.timeoutMs??15_000
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>15_000)throw Error('studio-source-discovery-time-budget-invalid')
 const maxCalls=8,deadline=Date.now()+timeoutMs;let calls=0
 const base={schema:'studio-source-discovery-v1',readOnly:true,metadataVerified:false,qualityApproved:false,publishingApproved:false}
 async function call(tool:StudioSourceTool,input:any){
  if(!TOOLS.has(tool)||calls>=maxCalls)throw Error('call_budget_exhausted')
  const remaining=deadline-Date.now();if(remaining<=0)throw Error('timeout')
  calls++;let timer:ReturnType<typeof setTimeout>|undefined
  try{return unpack(await Promise.race([Promise.resolve().then(()=>invoke(tool,input)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),remaining)})]))}
  finally{clearTimeout(timer)}
 }
 let character:any;const references:any[]=[],unresolvedAssetIds:string[]=[],rejectedReferences:any[]=[]
 try{
  if(!args.characterId){
   const value=await call('character_search',{query:args.query!.trim(),limit:20})
   if(!Array.isArray(value.characters))throw Error('metadata_invalid')
   const candidates=value.characters.filter((c:any)=>object(c)&&typeof c.character_id==='string'&&typeof c.name==='string').map((c:any)=>({characterId:c.character_id,name:c.name,profileAssetId:c.profile_asset_id??null,profileVersion:c.profile_version??null,lifecycle:c.lifecycle??'unknown'}))
   return {...base,status:candidates.length?'character_candidates':'no_match',candidates,selectionRequired:!!candidates.length,calls,maxCalls,total:typeof value.total==='number'?value.total:null,partial:typeof value.total==='number'?value.total>candidates.length:true}
  }
  const id=args.characterId,profile=await call('character_get',{character_id:id})
  if(profile.character_id!==id||!ID.test(profile.profile_asset_id??'')||profile.lifecycle!=='active'||!object(profile.profile))throw Error('current_profile_unresolved')
  character={characterId:id,profileAssetId:profile.profile_asset_id,profileVersion:profile.profile_version??null,profile:profile.profile,voiceRecommendation:profile.voice_recommendation??null,preproduction:profile.preproduction??null}
  const value=await call('character_assets',{character_id:id,include_retired:false})
  if(value.character_id!==id||value.profile_asset_id!==profile.profile_asset_id||!object(value.assets)||Object.values(value.assets).some(v=>!Array.isArray(v)))throw Error('current_profile_changed_or_invalid')
  const rows=Object.values(value.assets).flatMap((v:any)=>Array.isArray(v)?v:[])
  const ids=[...new Set<string>(rows.filter((r:any)=>r?.kind==='reference'&&r.lifecycle!=='retired'&&ID.test(r.id??'')).map((r:any)=>r.id))]
  unresolvedAssetIds.push(...ids)
  while(unresolvedAssetIds.length&&calls<maxCalls){
   const assetId=unresolvedAssetIds[0],detail=await call('asset_get',{id:assetId})
   unresolvedAssetIds.shift()
   const candidate=reference(detail.asset,assetId,id)
   if(candidate)references.push(candidate)
   else rejectedReferences.push({assetId,reason:'reference_metadata_missing_or_invalid'})
  }
  return {...base,status:unresolvedAssetIds.length?'partial':references.length?'metadata_unverified':rejectedReferences.length?'reference_metadata_invalid':'missing_reference',character,references,rejectedReferences,unresolvedAssetIds,calls,maxCalls,partial:!!unresolvedAssetIds.length,
   notice:'Current character/profile design approval is not video approval. Reference URL and SHA are metadata claims only; fetch, hash verification and independent viewing are still required. No baseline selected.'}
 }catch(error){
  const known=new Set(['provider_error','response_too_large','metadata_invalid','call_budget_exhausted','timeout','current_profile_unresolved','current_profile_changed_or_invalid'])
  return {...base,status:'incomplete',reason:error instanceof Error&&known.has(error.message)?error.message:'provider_error',character,references,rejectedReferences,unresolvedAssetIds,calls,maxCalls,partial:true}
 }
}
