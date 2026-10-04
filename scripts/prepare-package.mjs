/** Build checkout sources before packing; verify shipped bytes when repacking a tarball. */
import {readFile,writeFile,readdir,lstat,mkdtemp,rename,rm} from 'node:fs/promises'
import {join,dirname,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {packageStudio} from './package-studio.mjs'
const root=dirname(dirname(fileURLToPath(import.meta.url)))
const manifestName='PACKAGE_MANIFEST.json'
const hash=b=>createHash('sha256').update(b).digest('hex')
async function snapshot(base,prefix='',exclude=new Set()){
 const files={}
 for(const name of (await readdir(join(base,prefix))).sort()){
  const key=prefix?prefix+'/'+name:name;if(exclude.has(key))continue
  const path=join(base,key),stat=await lstat(path)
  if(stat.isSymbolicLink())throw Error('package-symlink-forbidden: '+key)
  if(stat.isDirectory())Object.assign(files,await snapshot(base,key,exclude))
  else if(stat.isFile())files[key]=hash(await readFile(path))
  else throw Error('package-nonregular-file: '+key)
 }
 return files
}
async function inputs(base){return {packageSha256:hash(await readFile(join(base,'package.json'))),sources:await snapshot(join(base,'src')),presets:await snapshot(join(base,'presets'))}}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
export async function verifyPackageBundle(base=root){
 const manifest=JSON.parse(await readFile(join(base,'lib',manifestName),'utf8'))
 if(manifest.schema!=='task-console-bundle-v1'||!equal(manifest.inputs,await inputs(base)))throw Error('package-source-mismatch: rebuild from the development checkout')
 const files=await snapshot(join(base,'lib'),'',new Set([manifestName]))
 if(!equal(manifest.files,files))throw Error('package-bundle-mismatch: rebuild from the development checkout')
 const pkg=JSON.parse(await readFile(join(base,'package.json'),'utf8'))
 const targets=[pkg.main,...Object.values(pkg.exports??{}).map(v=>typeof v==='string'?v:v.default)].filter(v=>v?.startsWith('./lib/'))
 for(const target of [...targets,'./lib/client-heavy.js','./lib/workflow-compat.json'])if(!files[target.slice(6)])throw Error('package-required-bundle-missing: '+target)
 return manifest
}
export async function preparePackage(base=root){
 let build=false
 try{const s=await lstat(join(base,'scripts/build.mjs'));if(!s.isFile())throw Error('package-build-script-invalid');build=true}catch(e){if(e.code!=='ENOENT')throw e}
 if(build){
  const before=await inputs(base),buildSha256=hash(await readFile(join(base,'scripts/build.mjs')))
  const out=await mkdtemp(join(base,'.package-build-'))
  try{
   // Deliberately override inherited output settings; a failed build never seals stale lib.
   execFileSync(process.execPath,[join(base,'scripts/build.mjs')],{cwd:base,env:{...process.env,DTC_BUILD_OUT:out},stdio:['ignore','ignore','pipe']})
   if(!equal(before,await inputs(base))||buildSha256!==hash(await readFile(join(base,'scripts/build.mjs'))))throw Error('package-source-changed-during-build')
   const files=await snapshot(out)
   await writeFile(join(out,manifestName),JSON.stringify({schema:'task-console-bundle-v1',inputs:before,buildSha256,files},null,2)+'\n')
   await rm(join(base,'lib'),{recursive:true,force:true});await rename(out,join(base,'lib'))
  }finally{await rm(out,{recursive:true,force:true})}
 }
 await verifyPackageBundle(base)
 await packageStudio(base)
 // Helpers may take time; fail if source or bundle changes before handoff to npm.
 return verifyPackageBundle(base)
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const m=await preparePackage();console.error(JSON.stringify({bundleVerified:true,files:Object.keys(m.files).length,runtimeVerified:false}))}
