/** Read-only discovery of common project scaffolding assets, not license or quality approval. */
import {createHash} from 'node:crypto'
import {lstat,readFile,realpath} from 'node:fs/promises'
import {join,relative,isAbsolute,sep} from 'node:path'
const locations={
 gsap:['assets/vendor/gsap.min.js','assets/gsap.min.js','gsap.min.js','.studio-host/hyperframes-smoke/gsap.min.js'],
 fonts:['assets/Chinese.ttf','assets/font.ttf','Chinese.ttf','font.ttf'],
} as const
export async function studioExecutionAssets(cwd:string){
 const root=await realpath(cwd),result:{gsap:any[];fonts:any[]}={gsap:[],fonts:[]}
 for(const kind of ['gsap','fonts'] as const)for(const name of locations[kind]){
  try{
   const proposed=join(root,name),info=await lstat(proposed)
   if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>(kind==='gsap'?2:64)*1024*1024)continue
   const path=await realpath(proposed),within=relative(root,path)
   if(!within||within==='..'||within.startsWith('..'+sep)||isAbsolute(within))continue
   const bytes=await readFile(path),after=await lstat(proposed)
   if(bytes.length!==info.size||after.size!==info.size||after.mtimeMs!==info.mtimeMs||await realpath(proposed)!==path)continue
   const version=kind==='gsap'?bytes.subarray(0,1000).toString('utf8').match(/\bGSAP\s+(\d+\.\d+\.\d+)\b/)?.[1]:undefined
   result[kind].push({path:within,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),...(version?{headerVersion:version}:{})})
  }catch{/* Missing/unreadable candidates are not declared usable. */}
 }
 return {...result,scope:'observed project files at common scaffold paths; not an exhaustive inventory or license/quality approval',usage:'Execution board gsap and font fields require existing project-relative file paths, not npm package names or versions. Preserve these files; no dependency installation is implied.'}
}
