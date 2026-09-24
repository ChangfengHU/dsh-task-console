/** Explicit development-time helper vendoring; never copy host configuration or evidence. */
import {readFile,writeFile,mkdir,rm,lstat,readdir} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
export const HELPERS=Object.freeze(['audio_observe_host.py','audio_review.py','audio_signals.py','compiler_host_bridge.py','compile_storyboard.py','vision_observe_host.py','observation_cache.py','render_job_host.py','speech_check_host.py','preflight_host.py','download_existing_asset.py'])
export const REQUIRED_PROOFS=Object.freeze(['speech-calibration.json','speech-differential-regression.json'])
const sha=b=>createHash('sha256').update(b).digest('hex')
const root=dirname(dirname(fileURLToPath(import.meta.url)))
// Static Python checks do not import or execute providers. Reject undeclared third-party
// imports as well as missing local siblings; this closure currently uses stdlib only.
const check=String.raw`
import ast,hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); names=json.loads(sys.argv[2]); local={pathlib.Path(n).stem for n in names}
for name in names:
 tree=ast.parse((root/name).read_bytes(),filename=name)
 for node in ast.walk(tree):
  modules=[]
  if isinstance(node,ast.Import):modules=[a.name.split('.')[0] for a in node.names]
  if isinstance(node,ast.ImportFrom):
   if node.level:raise ValueError('Relative helper import requires explicit packaging support: '+name)
   modules=[node.module.split('.')[0]] if node.module else []
  for module in modules:
   if module not in local and module not in sys.stdlib_module_names:raise ValueError('Undeclared Python dependency: '+name+' -> '+module)
  if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr=='with_name' and node.args and isinstance(node.args[0],ast.Constant):
   sibling=node.args[0].value
   if isinstance(sibling,str) and sibling.endswith('.py') and sibling not in names:raise ValueError('Missing sibling: '+sibling)
  if name=='compiler_host_bridge.py' and isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='COMPILER_SHA256' for t in node.targets):
   if ast.literal_eval(node.value)!=hashlib.sha256((root/'compile_storyboard.py').read_bytes()).hexdigest():raise ValueError('Compiler pin mismatch')
`
export async function verifyStudioPayload(packageRoot=root){
 const base=join(packageRoot,'studio'), manifest=JSON.parse(await readFile(join(base,'manifest.json'),'utf8'))
 if(manifest.schema!=='studio-package-v1'||JSON.stringify(Object.keys(manifest.files).sort())!==JSON.stringify(HELPERS.map(n=>'helpers/'+n).sort()))throw Error('studio-payload-manifest-invalid')
 if(JSON.stringify(manifest.requiredHostProofs)!==JSON.stringify(REQUIRED_PROOFS))throw Error('studio-payload-proofs-invalid')
 const entries=(await readdir(base)).sort()
 if(JSON.stringify(entries.filter(n=>n!=='roles'))!==JSON.stringify(['README.md','helpers','manifest.json']))throw Error('studio-payload-unexpected-file')
 if(JSON.stringify((await readdir(join(base,'helpers'))).sort())!==JSON.stringify([...HELPERS].sort()))throw Error('studio-payload-unexpected-helper')
 for(const [name,expected] of Object.entries(manifest.files)){
  const p=join(base,name);if(!(await lstat(p)).isFile()||sha(await readFile(p))!==expected)throw Error('studio-payload-hash-mismatch: '+name)
 }
 execFileSync('python3',['-I','-B','-c',check,join(base,'helpers'),JSON.stringify(HELPERS)],{stdio:'pipe'})
 return manifest
}
export async function packageStudio(packageRoot=root,sourceRoot=resolve(packageRoot,'../autonomous-studio')){
 const base=join(packageRoot,'studio')
 let sourceExists=false;try{sourceExists=(await lstat(sourceRoot)).isDirectory()}catch(e){if(e.code!=='ENOENT')throw e}
 // Repacking an installed tarball must require no sibling checkout.
 if(!sourceExists)return verifyStudioPayload(packageRoot)
 const files={};const contents=[]
 for(const name of HELPERS){const p=join(sourceRoot,name);if(!(await lstat(p)).isFile())throw Error('studio-helper-not-regular: '+name);const data=await readFile(p);contents.push([name,data]);files['helpers/'+name]=sha(data)}
 execFileSync('python3',['-I','-B','-c',check,sourceRoot,JSON.stringify(HELPERS)],{stdio:'pipe'})
 await rm(join(base,'helpers'),{recursive:true,force:true});await mkdir(join(base,'helpers'),{recursive:true})
 for(const [name,data] of contents)await writeFile(join(base,'helpers',name),data)
 await writeFile(join(base,'README.md'),`# Studio helper payload\n\nThese owned Python helpers are distributed under the package MIT license. They are copied from an explicit development source list; hashes are in manifest.json. No parent checkout is needed after packing.\n\nThis is not an installed or validated Studio runtime. Python 3.10+ on POSIX, Node, ffmpeg/ffprobe, Chrome, the render runtime, DSH profile, provider access and host credential references remain host responsibilities. Helpers retain legacy default paths; configure the host explicitly. Skills and role templates are outside this helper manifest; independently packaged role templates require their own validation.\n\nThe host must supply speech-calibration.json and speech-differential-regression.json from genuine calibration, with their existing validation. Private historical proof snapshots are deliberately excluded. Missing proofs mean unverified, never calibration passed. Task media and compiler input files are not package assets.\n`)
 await writeFile(join(base,'manifest.json'),JSON.stringify({schema:'studio-package-v1',files,requiredHostProofs:REQUIRED_PROOFS,proofsPackaged:false,scope:'python-helper-closure',runtimeVerified:false},null,2)+'\n')
 return verifyStudioPayload(packageRoot)
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const m=process.argv.includes('--verify')?await verifyStudioPayload():await packageStudio();console.error(JSON.stringify({schema:m.schema,helpers:Object.keys(m.files).length,proofsPackaged:false,runtimeVerified:false}))}
