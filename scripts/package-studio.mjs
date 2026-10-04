/** Explicit development-time helper vendoring; never copy host configuration or evidence. */
import {readFile,writeFile,mkdir,rm,lstat,readdir} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
export const HELPERS=Object.freeze(['audio_observe_host.py','audio_review.py','audio_signals.py','compiler_host_bridge.py','compile_storyboard.py','vision_observe_host.py','observation_cache.py','render_job_host.py','speech_check_host.py','preflight_host.py','prepare_execution_assets.py','download_existing_asset.py','acquire_incompetech_source.py','studio_preview_upload_host.py','studio_upload.py'])
export const RUNTIME_ASSETS=Object.freeze(['gsap.min.js','Chinese.ttf','GSAP-LICENSE.txt','DROID-NOTICE.txt','GSAP-STANDARD-LICENSE.html','SOURCES.json','manifest.json'])
const RUNTIME_TARGETS={'gsap.min.js':'assets/vendor/gsap.min.js','Chinese.ttf':'assets/Chinese.ttf',...Object.fromEntries(['GSAP-LICENSE.txt','DROID-NOTICE.txt','GSAP-STANDARD-LICENSE.html','SOURCES.json'].map(n=>[n,'assets/licenses/'+n]))}
export const REQUIRED_PROOFS=Object.freeze(['speech-calibration.json','speech-differential-regression.json'])
export const ROLES=Object.freeze(['director','storyboard','visual','sound','editor','quality'])
const ROLE_FILES=['roles/README.md','roles/manifest.json',...ROLES.map(role=>'roles/'+role+'/task-console.json')]
const sha=b=>createHash('sha256').update(b).digest('hex')
const root=dirname(dirname(fileURLToPath(import.meta.url)))
async function roleFiles(base){
 const directory=join(base,'roles')
 if(!(await lstat(directory)).isDirectory()||JSON.stringify((await readdir(directory)).sort())!==JSON.stringify(['README.md','manifest.json',...ROLES].sort()))throw Error('studio-payload-roles-invalid')
 const files={}
 for(const role of ROLES){const dir=join(directory,role);if(!(await lstat(dir)).isDirectory()||JSON.stringify(await readdir(dir))!==JSON.stringify(['task-console.json']))throw Error('studio-payload-role-files-invalid')}
 for(const name of ROLE_FILES){const path=join(base,name);if(!(await lstat(path)).isFile())throw Error('studio-payload-role-not-regular');files[name]=sha(await readFile(path))}
 const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'))
 if(manifest.schema!=='studio-role-pack-v1'||manifest.version!=='1.0.0'||manifest.installed!==false||manifest.runtimeVerified!==false||manifest.publishingGranted!==false||!Array.isArray(manifest.roles)||manifest.roles.length!==ROLES.length)throw Error('studio-payload-role-manifest-invalid')
 for(const role of ROLES){const rows=manifest.roles.filter(row=>row.role===role);if(rows.length!==1||rows[0].path!==role+'/task-console.json'||rows[0].sha256!==files['roles/'+role+'/task-console.json'])throw Error('studio-payload-role-integrity')}
 return files
}
async function runtimeFiles(directory){
 if(!(await lstat(directory)).isDirectory())throw Error('studio-runtime-assets-directory-invalid')
 if(JSON.stringify((await readdir(directory)).sort())!==JSON.stringify([...RUNTIME_ASSETS].sort()))throw Error('studio-runtime-assets-unexpected-file')
 const contents=new Map(),files={}
 for(const name of RUNTIME_ASSETS){
  const p=join(directory,name);if(!(await lstat(p)).isFile())throw Error('studio-runtime-asset-not-regular: '+name)
  const bytes=await readFile(p);contents.set(name,bytes);files['runtime-assets/'+name]=sha(bytes)
 }
 const manifest=JSON.parse(contents.get('manifest.json').toString('utf8'))
 if(manifest.schema!=='studio-runtime-assets-v1'||manifest.qualityApproved!==false||!manifest.files||JSON.stringify(Object.keys(manifest.files).sort())!==JSON.stringify(Object.keys(RUNTIME_TARGETS).sort()))throw Error('studio-runtime-assets-manifest-invalid')
 for(const [name,target] of Object.entries(RUNTIME_TARGETS)){
  const row=manifest.files[name],bytes=contents.get(name)
  if(row?.target!==target||row.bytes!==bytes.length||row.sha256!==sha(bytes))throw Error('studio-runtime-assets-integrity: '+name)
 }
 return {contents,files}
}
// Static Python checks do not import or execute providers. Reject undeclared third-party
// imports as well as missing local siblings; this closure currently uses stdlib only.
const check=String.raw`
import ast,hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); names=json.loads(sys.argv[2]); local={pathlib.Path(n).stem for n in names}
source_map=json.loads(sys.argv[4]) if len(sys.argv)>4 else {}
for name in names:
 tree=ast.parse(pathlib.Path(source_map.get(name,str(root/name))).read_bytes(),filename=name)
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
pins=[ast.literal_eval(n.value) for n in ast.walk(ast.parse((root/'prepare_execution_assets.py').read_bytes())) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='MANIFEST_SHA256' for t in n.targets)]
if pins!=[hashlib.sha256(pathlib.Path(sys.argv[3]).read_bytes()).hexdigest()]:raise ValueError('Runtime asset manifest pin mismatch')
`
export async function verifyStudioPayload(packageRoot=root,options={}){
 const base=join(packageRoot,'studio'), manifest=JSON.parse(await readFile(join(base,'manifest.json'),'utf8'))
 if(manifest.schema!=='studio-package-v1'||manifest.rolesPackaged!==true||manifest.runtimeAssetsPackaged!==true||manifest.proofsPackaged!==false||manifest.runtimeVerified!==false||!manifest.files||JSON.stringify(Object.keys(manifest.files).sort())!==JSON.stringify([...HELPERS.map(n=>'helpers/'+n),...ROLE_FILES,...RUNTIME_ASSETS.map(n=>'runtime-assets/'+n)].sort()))throw Error('studio-payload-manifest-invalid')
 if(JSON.stringify(manifest.requiredHostProofs)!==JSON.stringify(REQUIRED_PROOFS))throw Error('studio-payload-proofs-invalid')
 const entries=(await readdir(base)).sort()
 if(JSON.stringify(entries.filter(n=>!['roles','runtime-assets'].includes(n)))!==JSON.stringify(['README.md','helpers','manifest.json']))throw Error('studio-payload-unexpected-file')
 if(JSON.stringify((await readdir(join(base,'helpers'))).sort())!==JSON.stringify([...HELPERS].sort()))throw Error('studio-payload-unexpected-helper')
 await roleFiles(base)
 await runtimeFiles(join(base,'runtime-assets'))
 for(const [name,expected] of Object.entries(manifest.files)){
  const p=join(base,name);if(!(await lstat(p)).isFile()||sha(await readFile(p))!==expected)throw Error('studio-payload-hash-mismatch: '+name)
 }
 execFileSync(options.pythonExecutable??'python3',['-I','-B','-c',check,join(base,'helpers'),JSON.stringify(HELPERS),join(base,'runtime-assets/manifest.json')],{stdio:'pipe'})
 return manifest
}
export async function packageStudio(packageRoot=root,sourceRoot=resolve(packageRoot,'../autonomous-studio')){
 const base=join(packageRoot,'studio')
 let sourceExists=false;try{sourceExists=(await lstat(sourceRoot)).isDirectory()}catch(e){if(e.code!=='ENOENT')throw e}
 // Repacking an installed tarball must require no sibling checkout.
 if(!sourceExists)return verifyStudioPayload(packageRoot)
 const files=await roleFiles(base);const contents=[]
 for(const name of HELPERS){const p=name==='studio_upload.py'?resolve(sourceRoot,'../studio_upload.py'):join(sourceRoot,name);if(!(await lstat(p)).isFile())throw Error('studio-helper-not-regular: '+name);const data=await readFile(p);contents.push([name,data]);files['helpers/'+name]=sha(data)}
 execFileSync('python3',['-I','-B','-c',check,sourceRoot,JSON.stringify(HELPERS),resolve(sourceRoot,'../runtime-assets/manifest.json'),JSON.stringify({'studio_upload.py':resolve(sourceRoot,'../studio_upload.py')})],{stdio:'pipe'})
 const runtime=await runtimeFiles(resolve(sourceRoot,'../runtime-assets'));Object.assign(files,runtime.files)
 await rm(join(base,'helpers'),{recursive:true,force:true});await mkdir(join(base,'helpers'),{recursive:true})
 for(const [name,data] of contents)await writeFile(join(base,'helpers',name),data)
 await rm(join(base,'runtime-assets'),{recursive:true,force:true});await mkdir(join(base,'runtime-assets'),{recursive:true})
 for(const [name,data] of runtime.contents)await writeFile(join(base,'runtime-assets',name),data)
 await writeFile(join(base,'README.md'),`# Studio helper payload\n\nThese owned Python helpers are distributed under the package MIT license. Third-party files in runtime-assets are excluded from that MIT grant: GSAP retains its GSAP Standard No Charge License; Chinese.ttf (Droid Sans Fallback Full) retains its Apache-2.0 notice. Keep GSAP-LICENSE.txt, GSAP-STANDARD-LICENSE.html, DROID-NOTICE.txt and SOURCES.json with these files; check their actual terms for the intended use. They are copied from an explicit development source list; hashes are in manifest.json. No parent checkout is needed after packing.\n\nThis is not an installed or validated Studio runtime. Python 3.10+ on POSIX, Node, ffmpeg/ffprobe, Chrome, the render runtime, DSH profile, provider access and host credential references remain host responsibilities. Helpers retain legacy default paths; configure the host explicitly. The six public role templates are hash-covered by this manifest and retain their own role contract validation. Required Skills remain separate host dependencies; packaging does not install or grant role capabilities.\n\nThe host must supply speech-calibration.json and speech-differential-regression.json from genuine calibration, with their existing validation. Private historical proof snapshots are deliberately excluded. Missing proofs mean unverified, never calibration passed. Task media and compiler input files are not package assets. The fixed seven-file runtime-assets directory carries only the reviewed runtime/font and notices; its manifest validates six members, and this outer manifest hashes all seven including the inner manifest. prepare_execution_assets.py resolves this packaged sibling by default; it does not require the original developer home.\n`)
 await writeFile(join(base,'manifest.json'),JSON.stringify({schema:'studio-package-v1',files,requiredHostProofs:REQUIRED_PROOFS,proofsPackaged:false,rolesPackaged:true,runtimeAssetsPackaged:true,scope:'python-helper-closure-role-templates-and-licensed-runtime-assets',runtimeVerified:false},null,2)+'\n')
 return verifyStudioPayload(packageRoot)
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const m=process.argv.includes('--verify')?await verifyStudioPayload():await packageStudio();console.error(JSON.stringify({schema:m.schema,helpers:HELPERS.length,rolesPackaged:m.rolesPackaged,runtimeAssetsPackaged:m.runtimeAssetsPackaged,proofsPackaged:false,runtimeVerified:false}))}
