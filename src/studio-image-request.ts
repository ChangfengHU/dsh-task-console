/** Reject known-invalid image inputs before spending; not proof of visual identity. */
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
}
