/** Host-owned configuration binding. Never accept a path from Task/model input. */
import {readFile} from 'node:fs/promises'
import {isAbsolute} from 'node:path'

export interface StudioConfigBinding {studioConfigPath?:string}
export async function readStudioHostConfiguration(path?:string,legacyUrl=new URL('../studio-host.json',import.meta.url)):Promise<any>{
 const explicit=path!==undefined
 if(explicit&&(typeof path!=='string'||!isAbsolute(path)||path.includes('\0')))throw Error('studio-host-config-path-invalid')
 let value:any
 try{value=JSON.parse(await readFile(explicit?path!:legacyUrl,'utf8'))}
 catch{if(!explicit)return {};throw Error('studio-host-config-unavailable')}
 if(!value||typeof value!=='object'||Array.isArray(value)){
  if(!explicit)return {}
  throw Error('studio-host-config-invalid')
 }
 for(const field of ['dshProfilePath','renderRuntime'])if(value[field]!==undefined&&(typeof value[field]!=='string'||!isAbsolute(value[field])||value[field].includes('\0')))throw Error('studio-host-config-binding-invalid')
 return value
}
