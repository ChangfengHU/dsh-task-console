export interface StudioCharacterReference {id:string;path:string;sha256:string;assetId?:string;sourceUrl?:string;sourceSha256?:string}
/** Public handoff of an already verified host reference. Never construct a URL
 * from a profile ID or expose credential-bearing/unapproved source metadata. */
export function publicCharacterReference(ref:StudioCharacterReference){
 const base={id:ref.id,sha256:ref.sha256,...(ref.assetId?{assetId:ref.assetId}:{})}
 if(ref.sourceUrl!==undefined){
  let url:URL;try{url=new URL(ref.sourceUrl)}catch{throw Error('studio-character-source-invalid')}
  if(url.protocol!=='https:'||url.hostname!=='cdn.vyibc.com'||url.username||url.password||url.port||url.search||url.hash||ref.sourceSha256!==ref.sha256||!/^[a-f0-9]{64}$/.test(ref.sha256))throw Error('studio-character-source-invalid')
  return {...base,sourceUrl:ref.sourceUrl,sourceSha256:ref.sourceSha256,sourceVerification:'preflight-download-sha256',sourceNotice:'Verified at preflight, not a guarantee of later provider reachability or character quality. Use this exact sourceUrl; never construct a URL from assetId.'}
 }
 return {...base,...(ref.assetId?{sourceLookup:{tool:'asset_get',arguments:{id:ref.assetId},field:'asset.source_url'}}:{}),sourceNotice:ref.assetId?'Legacy cached preflight has no source URL. Call asset_get with the exact provided primary-reference id and verify the returned asset identity. Use asset.source_url only when it is an actual approved public HTTPS CDN URL. An archived asset may have project:// provenance instead of a public download URL: never rewrite its scheme/path or construct a URL from its ID. Prefer a verified locked primary reference sourceUrl when available.':'Legacy cached preflight has no verified source URL or catalog asset ID. Refresh character preflight; do not invent an asset ID or URL.'}
}
