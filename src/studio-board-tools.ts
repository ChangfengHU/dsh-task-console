/** Structured board handoff to the pinned host compiler; never rendering or quality approval. */
import {defineTool} from '@deepseek-ai/dsh-tools'
import {constants} from 'node:fs'
import {lstat,mkdir,open,realpath} from 'node:fs/promises'
import {extname,isAbsolute,join,relative,resolve,sep} from 'node:path'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'

export const STUDIO_BOARD_TOOL_NAMES=['studio_compile_storyboard'] as const
export interface StudioBoardOptions {input:any;workflow:any;isActive:()=>boolean;compile:(value:{boardPath:string;outputDirectory:string})=>Promise<any>}
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex')
const missing=(error:any)=>error?.code==='ENOENT'
async function plainDirectory(path:string){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)throw Error('studio-board-directory-symlink-or-invalid')}
async function fileBytes(path:string){const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{if(!(await f.stat()).isFile())throw Error('studio-board-file-required');return await f.readFile()}finally{await f.close()}}
function safeReason(value:unknown,root:string){return String(value??'compiler did not produce a successful receipt').replaceAll(root,'[project]').replace(/https?:\/\/\S+/g,'[url]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,'$1=[redacted]').replace(/(?:\/[A-Za-z0-9._-]+){2,}/g,'[path]').replace(/[\r\n\t]+/g,' ').slice(0,240)}

const exactKeys=(value:any,keys:string[])=>value&&typeof value==='object'&&!Array.isArray(value)&&isDeepStrictEqual(Object.keys(value).sort(),[...keys].sort())
const htmlEscape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#x27;')
/** Validate the real compiler's unsigned local receipt, not an aesthetic approval
 * or an authentication claim. Existing output is never repaired or overwritten. */
async function replayReceipt(root:string,output:string,board:any){
 const requireMatch=(ok:unknown)=>{if(!ok)throw Error('studio-board-replay-mismatch')}
 await plainDirectory(output);await plainDirectory(join(output,'assets'))
 const json=async(name:string)=>JSON.parse((await fileBytes(join(output,name))).toString('utf8'))
 requireMatch(isDeepStrictEqual(await json('board.json'),board))
 const receipt=await json('compile-receipt.json')
 requireMatch(exactKeys(receipt,['schema','duration','fps','assets','qualityApproved','indexSha256']))
 requireMatch(receipt.schema==='studio-board-v1'&&receipt.schema===board.schema&&receipt.duration===board.duration&&receipt.fps===(board.fps??30)&&receipt.qualityApproved===false&&/^[a-f0-9]{64}$/.test(receipt.indexSha256))
 const sources=new Map<string,string>([[board.gsap,'script'],[board.font,'font']])
 for(const scene of board.scenes)for(const layer of scene.layers)if(layer.type==='image')sources.set(layer.src,'image')
 for(const audio of board.audio)sources.set(audio.src,'audio')
 requireMatch(exactKeys(receipt.assets,[...sources.keys()]))
 const suffixes:Record<string,string[]>={script:['.js'],font:['.ttf','.otf'],image:['.png','.jpg','.jpeg','.webp'],audio:['.wav','.mp3','.m4a']}
 for(const [source,kind] of sources){
  requireMatch(typeof source==='string'&&!isAbsolute(source))
  const path=await realpath(resolve(root,source)),within=relative(root,path),suffix=extname(path).toLowerCase()
  requireMatch(within&&within!=='..'&&!within.startsWith('..'+sep)&&!isAbsolute(within)&&suffixes[kind].includes(suffix))
  const bytes=await fileBytes(path),digest=sha(bytes),asset=receipt.assets[source]
  requireMatch(exactKeys(asset,['sha256','bytes','kind','file']))
  requireMatch(asset.kind===kind&&asset.sha256===digest&&asset.bytes===bytes.length&&asset.file===`assets/${kind==='script'?'gsap-':''}${digest}${suffix}`)
  requireMatch((await fileBytes(join(output,asset.file))).equals(bytes))
 }
 const indexPath=join(output,'index.html'),indexBytes=await fileBytes(indexPath),html=indexBytes.toString('utf8'),indexSha256=sha(indexBytes)
 requireMatch(indexSha256===receipt.indexSha256)
 for(const asset of Object.values(receipt.assets) as any[])requireMatch(html.includes(asset.kind==='font'?`url('${asset.file}')`:`src="${asset.file}"`))
 const speech=await json('speech-plan.json'),voices=board.audio.map((value:any,index:number)=>({value,index})).filter(({value}:any)=>value.role==='voice')
 requireMatch(Array.isArray(speech)&&speech.length===voices.length&&voices.length>0)
 for(let i=0;i<voices.length;i++){
  const {value,index}=voices[i],line=speech[i]
  requireMatch(exactKeys(line,['id','text','start','end','sourcePath']))
  requireMatch(line.id===value.lineId&&line.text===value.text&&line.sourcePath===value.src&&line.start===value.start&&Number.isFinite(line.end)&&line.end>line.start&&line.end<=board.duration+.025)
  const caption=html.match(new RegExp(`<div id="caption-${index}" class="clip caption" data-start="([^"]+)" data-duration="([^"]+)" data-track-index="90">([^]*?)</div>`))
  requireMatch(caption&&Number(caption[1])===line.start&&Math.abs(Number(caption[2])-(line.end-line.start))<.000001&&caption[3]===htmlEscape(line.text))
 }
 requireMatch(isDeepStrictEqual(board.script,speech.map(({id,text}:any)=>({id,text}))))
 return {indexPath,indexSha256}
}

export async function registerStudioBoardTools(ctx:any,o:StudioBoardOptions):Promise<()=>void>{
 const {input,workflow}=o
 const check=(exec?:any)=>{if(!o.isActive())throw Error('studio-stale-run');if(exec?.agent?.session?.id&&exec.agent.session.id!==input.sessionId)throw Error('studio-session-mismatch')}
 const tool=defineTool({name:'studio_compile_storyboard',description:'Executor only: pass a structured storyboard object to the fixed local compiler. Saves immutable input, writes a new composition directory and verifies HTML hash. Fix named fields without deleting planned scenes/actions. Does not render, synthesize media or approve quality.',parameters:{board:{type:'object',description:'Execution object with required root schema:"studio-board-v1", numeric duration (seconds), gsap, font, script, scenes and audio. Not the planning document or serialized text. Scenes use start/duration/layers. Image layer example: {"type":"image","role":"character","src":"assets/character.png","width":400,"height":800}. role is a direct property; tags is unsupported. Full contract: STORYBOARD_EXECUTION.md.',additionalProperties:true},boardPath:{type:'string',description:'Preferred for an existing execution board: project-relative .json file to read and freeze. Supply exactly one of boardPath or board. No need to copy the whole JSON into tool arguments.'},outputDirectory:{type:'string',description:'Optional new directory name that does not exist yet. Omit to use a content-derived name. The compiler creates it. Do not mkdir it or write board.json into it first; preserve existing directories.'}},output:{schema:{type:'object',additionalProperties:true},render:(_:any,value:any)=>[{type:'text',text:JSON.stringify(value)}]},execute:async(args:any,exec:any)=>{
  check(exec);if(input.card?.role!=='executor')throw Error('studio-role-denied')
  if(Object.keys(args).some(key=>!['board','boardPath','outputDirectory'].includes(key)))throw Error('studio-board-unknown-argument')
  const hasBoard=args.board!==undefined,hasPath=args.boardPath!==undefined
  if(hasBoard===hasPath)throw Error('studio-board-input-required: provide exactly one of board or boardPath; prefer boardPath for an existing project JSON file')
  const root=resolve(input.task.cwd);await plainDirectory(root)
  let source=args.board
  if(hasPath){
   if(!args.boardPath||isAbsolute(args.boardPath)||extname(args.boardPath).toLowerCase()!=='.json')throw Error('studio-board-source-path-invalid')
   const path=await realpath(resolve(root,args.boardPath)),within=relative(root,path)
   if(!within||within==='..'||within.startsWith('..'+sep)||isAbsolute(within))throw Error('studio-board-source-outside-project')
   if((await lstat(path)).size>1024*1024)throw Error('studio-board-input-too-large')
   try{source=JSON.parse((await fileBytes(path)).toString('utf8'))}catch{throw Error('studio-board-source-invalid-json')}
   if(!source||typeof source!=='object'||Array.isArray(source))throw Error('studio-board-source-object-required')
   check(exec)
  }
  const encoded=JSON.stringify(source)
  if(Buffer.byteLength(encoded)>1024*1024)throw Error('studio-board-input-too-large')
  const name=args.outputDirectory??'composition-'+sha(encoded).slice(0,16)
  if(!/^[A-Za-z0-9._-]{1,80}$/.test(name)||name==='.'||name==='..')throw Error('studio-board-output-name-invalid')
  const board=JSON.parse(encoded),script=workflow.script(input),policy=input.task.design?.studio
  if(!script||!isDeepStrictEqual(board.script,script.lines))throw Error('studio-board-script-mismatch')
  if(!policy||policy.width!==1080||policy.height!==1920||policy.fps!==30||(board.width??1080)!==policy.width||(board.height??1920)!==policy.height||(board.fps??30)!==policy.fps)throw Error('studio-board-dimensions-mismatch')
  if(board.schema!=='studio-board-v1')throw Error('studio-board-execution-schema-required: '+JSON.stringify({
   error_code:'studio-board-execution-schema-required',requiredSchema:'studio-board-v1',
   requiredRootFields:['schema','duration','gsap','font','script','scenes','audio'],
   action:'Pass the execution board described by STORYBOARD_EXECUTION.md. A planning document with version/dimensions/frame descriptions is not a renderable board. Keep the planned scenes, actions and frozen dialogue; express scenes as start/duration/layers and actual audio sources. Do not delete content to satisfy the schema.',
  }))
  if(!Number.isFinite(board.duration)||!Number.isFinite(policy.durationMin)||!Number.isFinite(policy.durationMax)||board.duration<policy.durationMin||board.duration>policy.durationMax)throw Error('studio-board-duration-outside-policy: '+JSON.stringify({
   error_code:'studio-board-duration-outside-policy',reason:Number.isFinite(board.duration)?'duration-outside-range':'root-duration-required',
   field:'board.duration',received:typeof board.duration==='number'||typeof board.duration==='string'?board.duration:null,
   minimum:policy.durationMin,maximum:policy.durationMax,
   action:'Set a numeric duration in seconds at the execution board root, aligned with the complete scene timeline and task duration policy. durationMin/durationMax inside dimensions do not supply it. Preserve the full script and scene content; do not pad empty frames or trim dialogue to fit.',
  }))
  const base=join(root,'.studio-boards'),output=join(root,name),digest=sha(encoded),boardPath=join(base,digest+'.json')
  // lstat catches dangling output symlinks too. Only complete, matching compiler
  // output can be replayed; this branch never creates or repairs any files.
  const noOutput=async()=>{try{await lstat(output)}catch(error){if(missing(error))return;throw error}throw Error('studio-board-output-exists')}
  const verifyInput=async()=>{await plainDirectory(root);await plainDirectory(base);if((await lstat(boardPath)).isSymbolicLink()||!(await fileBytes(boardPath)).equals(Buffer.from(encoded)))throw Error('studio-board-input-changed');check(exec)}
  let outputExists=false
  try{await lstat(output);outputExists=true}catch(error){if(!missing(error))throw error}
  if(outputExists){
   try{
    await verifyInput();const replay=await replayReceipt(root,output,board)
    // Repeat the integrity read after filesystem work, preserving the live run,
    // frozen input and frozen script checks that protect the normal compile path.
    await verifyInput();const confirmed=await replayReceipt(root,output,board)
    if(!isDeepStrictEqual(replay,confirmed))throw Error('studio-board-replay-changed')
    await verifyInput();check(exec)
    if(!isDeepStrictEqual(workflow.script(input)?.lines,board.script))throw Error('studio-board-script-changed')
    return {ok:true,composition:output,...replay,boardPath,boardSha256:digest,inputReused:true,outputReused:true,qualityApproved:false,scope:'technical-compilation-only; not rendered or quality-approved'}
   }catch(error:any){
    if(/^studio-(stale-run|session-mismatch|board-input-changed|board-script-changed)$/.test(error?.message??''))throw error
    throw Error('studio-board-output-exists: '+JSON.stringify({error_code:'studio-board-output-exists',reason:'existing-output-is-not-a-verified-replay',dispatched:false,action:'Preserve the existing directory. Pass a fresh outputDirectory name without creating it first: the compiler itself creates that directory. Do not write your source board.json there, delete an old directory, or retry this same destination.'}))
   }
  }
  await noOutput();try{await mkdir(base,{mode:0o700})}catch(error:any){if(error.code!=='EEXIST')throw error}await plainDirectory(base);check(exec)
  let existing=false
  try{const f=await open(boardPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(encoded);await f.sync()}finally{await f.close()}}
  catch(error:any){if(error.code!=='EEXIST')throw error;existing=true}
  await verifyInput();await noOutput();check(exec)
  let result:any
  try{result=await o.compile({boardPath,outputDirectory:name})}catch(error){result={ok:false,reason:error instanceof Error?error.message:'compiler invocation failed'}}
  await verifyInput()
  if(result?.ok!==true)return {ok:false,error:'studio-board-compile-failed',reason:safeReason(result?.reason,root),boardPath,boardSha256:digest,inputReused:existing,qualityApproved:false}
  if(result.composition!==output||result.qualityApproved!==false||typeof result.indexSha256!=='string'||!/^[a-f0-9]{64}$/.test(result.indexSha256))throw Error('studio-board-receipt-invalid')
  await plainDirectory(output)
  const indexPath=join(output,'index.html');if((await lstat(indexPath)).isSymbolicLink())throw Error('studio-board-output-symlink')
  const indexSha256=sha(await fileBytes(indexPath));if(indexSha256!==result.indexSha256)throw Error('studio-board-output-hash-mismatch')
  await verifyInput();await plainDirectory(output);check(exec)
  if(sha(await fileBytes(indexPath))!==indexSha256)throw Error('studio-board-output-hash-mismatch')
  check(exec)
  if(!isDeepStrictEqual(workflow.script(input)?.lines,board.script))throw Error('studio-board-script-changed')
  return {ok:true,composition:output,indexPath,indexSha256,boardPath,boardSha256:digest,inputReused:existing,qualityApproved:false,scope:'technical-compilation-only; not rendered or quality-approved'}
 }})
 return ctx.tools.register(tool)
}
