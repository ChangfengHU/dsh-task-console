/** Structured board handoff to the pinned host compiler; never rendering or quality approval. */
import {defineTool} from '@deepseek-ai/dsh-tools'
import {constants} from 'node:fs'
import {lstat,mkdir,open,realpath} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'

export const STUDIO_BOARD_TOOL_NAMES=['studio_compile_storyboard'] as const
export interface StudioBoardOptions {input:any;workflow:any;isActive:()=>boolean;compile:(value:{boardPath:string;outputDirectory:string})=>Promise<any>}
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex')
const missing=(error:any)=>error?.code==='ENOENT'
async function plainDirectory(path:string){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)throw Error('studio-board-directory-symlink-or-invalid')}
async function fileBytes(path:string){const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{if(!(await f.stat()).isFile())throw Error('studio-board-file-required');return await f.readFile()}finally{await f.close()}}
function safeReason(value:unknown,root:string){return String(value??'compiler did not produce a successful receipt').replaceAll(root,'[project]').replace(/https?:\/\/\S+/g,'[url]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,'$1=[redacted]').replace(/(?:\/[A-Za-z0-9._-]+){2,}/g,'[path]').replace(/[\r\n\t]+/g,' ').slice(0,240)}

export async function registerStudioBoardTools(ctx:any,o:StudioBoardOptions):Promise<()=>void>{
 const {input,workflow}=o
 const check=(exec?:any)=>{if(!o.isActive())throw Error('studio-stale-run');if(exec?.agent?.session?.id&&exec.agent.session.id!==input.sessionId)throw Error('studio-session-mismatch')}
 const tool=defineTool({name:'studio_compile_storyboard',description:'Executor only: pass a structured storyboard object to the fixed local compiler. Saves immutable input, writes a new composition directory and verifies HTML hash. Does not render, synthesize media or approve quality.',parameters:{board:{type:'object',additionalProperties:true,required:true},outputDirectory:{type:'string',required:true}},output:{schema:{type:'object',additionalProperties:true},render:(_:any,value:any)=>[{type:'text',text:JSON.stringify(value)}]},execute:async(args:any,exec:any)=>{
  check(exec);if(input.card?.role!=='executor')throw Error('studio-role-denied')
  if(Object.keys(args).some(key=>!['board','outputDirectory'].includes(key)))throw Error('studio-board-unknown-argument')
  const name=args.outputDirectory
  if(!/^[A-Za-z0-9._-]{1,80}$/.test(name)||name==='.'||name==='..')throw Error('studio-board-output-name-invalid')
  const encoded=JSON.stringify(args.board)
  if(Buffer.byteLength(encoded)>1024*1024)throw Error('studio-board-input-too-large')
  const board=JSON.parse(encoded),script=workflow.script(input),policy=input.task.design?.studio
  if(!script||!isDeepStrictEqual(board.script,script.lines))throw Error('studio-board-script-mismatch')
  if(!policy||policy.width!==1080||policy.height!==1920||policy.fps!==30||(board.width??1080)!==policy.width||(board.height??1920)!==policy.height||(board.fps??30)!==policy.fps)throw Error('studio-board-dimensions-mismatch')
  if(!Number.isFinite(board.duration)||!Number.isFinite(policy.durationMin)||!Number.isFinite(policy.durationMax)||board.duration<policy.durationMin||board.duration>policy.durationMax)throw Error('studio-board-duration-outside-policy')
  const root=resolve(input.task.cwd);await plainDirectory(root)
  const base=join(root,'.studio-boards'),output=join(root,name),digest=sha(encoded),boardPath=join(base,digest+'.json')
  // lstat catches dangling output symlinks too; no existing destination is reused.
  const noOutput=async()=>{try{await lstat(output)}catch(error){if(missing(error))return;throw error}throw Error('studio-board-output-exists')}
  await noOutput();try{await mkdir(base,{mode:0o700})}catch(error:any){if(error.code!=='EEXIST')throw error}await plainDirectory(base);check(exec)
  let existing=false
  try{const f=await open(boardPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(encoded);await f.sync()}finally{await f.close()}}
  catch(error:any){if(error.code!=='EEXIST')throw error;existing=true}
  const verifyInput=async()=>{await plainDirectory(root);await plainDirectory(base);if((await lstat(boardPath)).isSymbolicLink()||!(await fileBytes(boardPath)).equals(Buffer.from(encoded)))throw Error('studio-board-input-changed');check(exec)}
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
