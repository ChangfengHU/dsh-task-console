/** Reject known-invalid image inputs before spending; not proof of visual identity. */
const APPROVED_GITHUB_REFERENCE_PATH='/ChangfengHU/cartoon-video-skills/main/skills/cartoon-xiaban/assets/identity/approved-comic-v1.png'
export function assertStudioImageRequest(raw:string,args:any){
 if(!/generate_image$/.test(raw))return
 const fail=(code:string,action:string):never=>{throw Error(code+': '+JSON.stringify({error_code:code,dispatched:false,retryable:false,retryAfterRepair:true,action}))}
 if(args?.wait===true)fail('studio-image-async-required','Submit with wait:false and poll the returned taskId using get_task. Waiting inside the submission can lose the taskId at the MCP timeout; never retry an unknown submission.')
 const prompts=[...(Array.isArray(args?.prompts)?args.prompts:[]),...(args?.prompt?[args.prompt]:[])]
 if(!prompts.length||prompts.some(p=>typeof p!=='string'||!p.trim()))fail('studio-image-prompts-required','Supply nonempty prompt text or a prompts array. Each entry consumes one image allowance.')
 if(typeof args?.referenceImageUrl!=='string'||!args.referenceImageUrl.trim())fail('studio-image-reference-required','Retrieve an actual character/brand reference image URL from the approved character assets and pass it as referenceImageUrl. A character description in the prompt is not a reference image. Use the reference for background style consistency too.')
 let url:URL
 try{url=new URL(args.referenceImageUrl)}catch{fail('studio-image-reference-invalid','Use a publicly reachable HTTPS image URL from the character assets; not a local path or an asset ID.')}
 if(url!.protocol!=='https:'||url!.username||url!.password||/\.(?:mp4|mov|m4v|webm|avi|mkv|mp3|wav|ogg|m4a)(?:$|\/)/i.test(url!.pathname))fail('studio-image-reference-invalid','referenceImageUrl must point to an actual image, not the approved MP4 or an audio file. Query the character asset image URL. This local check does not verify remote bytes or identity.')
 // preflight_host.safe_url approves the CDN; the original approved Xiaban
 // reference is one explicit raw GitHub file, not a grant to browse GitHub.
 const trusted=url!.hostname==='cdn.vyibc.com'||url!.hostname==='raw.githubusercontent.com'&&url!.pathname===APPROVED_GITHUB_REFERENCE_PATH
 if(!trusted||url!.port||url!.search||url!.hash)fail('studio-image-reference-untrusted','Use a real catalog image on cdn.vyibc.com or the explicitly approved cartoon-xiaban approved-comic-v1.png GitHub reference, without credentials, query parameters, fragment or custom port. Other GitHub owners, repositories and paths are not authorized. Never construct a URL from an asset ID.')
}

const MAX_REFERENCE_BYTES=16*1024*1024
const imageMagic=(b:Buffer)=>b.length>=12&&(
 b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||
 b[0]===255&&b[1]===216&&b[2]===255||
 b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'||
 ['GIF87a','GIF89a'].includes(b.toString('ascii',0,6)))
/** Public asset bytes only: no auth, redirects, arbitrary hosts or unbounded body.
 * Reachability at this instant is not identity/quality approval or a guarantee
 * that a later provider download will still succeed. */
export async function prepareStudioImageRequest(raw:string,args:any,request:typeof fetch=fetch){
 if(!/generate_image$/.test(raw))return
 assertStudioImageRequest(raw,args)
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined
 try{
  const response=await request(args.referenceImageUrl,{method:'GET',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(10000),headers:{Accept:'image/png,image/jpeg,image/webp,image/gif','User-Agent':'curl/8.0'}})
  reader=response.body?.getReader()
  if(!response.ok||response.redirected||!reader)throw Error('unavailable')
  const length=response.headers.get('content-length')
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_REFERENCE_BYTES))throw Error('size')
  let total=0,head=Buffer.alloc(0)
  while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>MAX_REFERENCE_BYTES)throw Error('size');if(head.length<32)head=Buffer.concat([head,Buffer.from(value.subarray(0,32-head.length))])}
  if(!imageMagic(head)||!total||length!==null&&total!==Number(length))throw Error('image')
  return {reachable:true,bytes:total,qualityApproved:false}
 }catch{throw Error('studio-image-reference-unavailable: '+JSON.stringify({error_code:'studio-image-reference-unavailable',dispatched:false,reservedUnits:0,retryAfterRepair:true,action:'The approved reference could not be downloaded as a bounded image. Query asset_get for a concrete image asset and use its actual source_url. profile_asset_id is not an image file URL; never append it to a CDN path. No provider submission occurred. This check does not approve character identity or guarantee later provider availability.'}))}
 finally{try{await reader?.cancel()}catch{/* no credential-bearing transport errors */}}
}
