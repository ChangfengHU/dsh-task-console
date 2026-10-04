/** Public-source project-use declaration and pinned-helper receipt validation.
 * This never promotes source-card archive rights or approves the resulting film. */
import {readFile,stat} from 'node:fs/promises'
import {relative} from 'node:path'
import {isDeepStrictEqual} from 'node:util'
import {fileSha256,studioPath} from './studio-tools.js'
export interface SourcePolicy {purpose:'video_soundtrack';platforms:string[];attributionWillBeIncluded:true;platformAllowsAttribution:true;noAdditionalRestrictions:true;changesDescription:string}
export function validateSourcePolicy(value:unknown):SourcePolicy{
 const v=value as any,keys=['purpose','platforms','attributionWillBeIncluded','platformAllowsAttribution','noAdditionalRestrictions','changesDescription']
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join('|')!==keys.sort().join('|')||v.purpose!=='video_soundtrack'||!Array.isArray(v.platforms)||v.platforms.length<1||v.platforms.length>10||v.platforms.some((p:any)=>typeof p!=='string'||!p.trim()||p.length>160)||['attributionWillBeIncluded','platformAllowsAttribution','noAdditionalRestrictions'].some(k=>v[k]!==true)||typeof v.changesDescription!=='string'||!v.changesDescription.trim()||v.changesDescription.length>1000)throw Error('studio-source-policy-invalid: declare the actual video_soundtrack use, platforms, attribution inclusion, permitted attribution, no additional restrictions, and changesDescription. This declaration does not verify platform terms or grant archive rights.')
 return structuredClone(v)
}
export async function verifiedSourceReceipt(root:string,args:{id:string;path:string;sourcePolicy:SourcePolicy},result:any){
 const fail=()=>{throw Error('studio-source-acquisition-receipt-invalid')}
 if(typeof result.receiptPath!=='string'||!/^[a-f0-9]{64}$/.test(result.receiptSha256??''))fail()
 const receiptPath=await studioPath(root,result.receiptPath,true),assetPath=await studioPath(root,args.path,true)
 if(receiptPath!==assetPath+'.source.json'||(await stat(receiptPath)).size>65536||await fileSha256(receiptPath)!==result.receiptSha256)fail()
 const receipt=JSON.parse(await readFile(receiptPath,'utf8'))
 if(!isDeepStrictEqual(receipt,result.sourceAcquisition)||receipt.schema!=='studio-public-source-v1'||receipt.assetId!==args.id||receipt.path!==assetPath||receipt.sha256!==result.sha256||receipt.bytes!==result.bytes||receipt.kind!=='bgm'||receipt.qualityApproved!==false||receipt.audioDecodeVerified!==true||receipt.archivePermissionGranted!==false||receipt.sourceCardRightsUnchanged!==true||receipt.platformTermsIndependentlyVerified!==false||!isDeepStrictEqual(receipt.projectUse,args.sourcePolicy)||!/^USUAN[0-9]{7}$/.test(receipt.isrc??'')||receipt.author!=='Kevin MacLeod'||typeof receipt.attribution!=='string'||!receipt.attribution.trim())fail()
 if(receipt.technical?.codec!=='mp3'||receipt.technical?.measurement!=='ffmpeg_full_decode_out_time'||!Number.isFinite(receipt.technical?.durationSeconds)||receipt.technical.durationSeconds<=0)fail()
 const urls=[`https://incompetech.com/music/royalty-free/index.html?isrc=${receipt.isrc}`,'https://incompetech.com/music/royalty-free/pieces.json','https://incompetech.com/music/royalty-free/licenses/']
 if(!Array.isArray(receipt.evidence)||receipt.evidence.length!==3||receipt.evidence.some((e:any,i:number)=>e.url!==urls[i]||!/^[a-f0-9]{64}$/.test(e.sha256??'')||!Number.isInteger(e.bytes)||e.bytes<1)||receipt.licenseUrl!=='https://creativecommons.org/licenses/by/4.0/')fail()
 return {receiptPath:relative(root,receiptPath),receiptSha256:result.receiptSha256,sourceAcquisition:{schema:receipt.schema,isrc:receipt.isrc,title:receipt.title,author:receipt.author,attribution:receipt.attribution,changesNotice:receipt.changesNotice,licenseUrl:receipt.licenseUrl,evidence:receipt.evidence,technical:receipt.technical,archivePermissionGranted:false,sourceCardRightsUnchanged:true,platformTermsIndependentlyVerified:false,audioDecodeVerified:true,qualityApproved:false}}
}
