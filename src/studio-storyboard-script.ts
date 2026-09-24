/** Semantic handoff checks, not creative or duration approval. */
export interface FrozenDialogue {sha256:string;lines:{id:string;text:string}[]}
const HASH=/^[a-f0-9]{64}$/i
const object=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v)
const fail=(missing:string[],detail:string):never=>{throw Error('studio-storyboard-script-mismatch: '+JSON.stringify({error_code:'studio-storyboard-script-mismatch',missing,detail,retryable:false,retryAfterRepair:true,tool:'studio_status',action:'Read studio_status.state.script. Copy its sha256 to storyboard.scriptSha256 and preserve every frozen line id and exact text. Use script:[{id,text}] for the full dialogue and lineId/text or sound:"line-id: quoted text" for shot references. Silent shots may omit speech. Do not change the frozen script to fit a different story; repair the storyboard, then call studio_register_stage again.'}))}
export function isStoryboardDocument(value:any){return object(value)&&(Array.isArray(value.scenes)||value.schema==='studio-board-v1'||value.version==='studio-board-v1'||value.script!==undefined||value.speech!==undefined)}
export function validateStoryboardScript(board:any,script:FrozenDialogue){
 if(!object(board))fail(['storyboard'],'Storyboard must be a JSON object.')
 if(!script||!HASH.test(script.sha256??'')||!Array.isArray(script.lines)||!script.lines.length)fail(['frozen_script'],'Host frozen dialogue is required before storyboard registration.')
 if(script.lines.some(l=>!object(l)||typeof l.id!=='string'||!l.id||typeof l.text!=='string'||!l.text.trim()))fail(['frozen_script'],'Host dialogue is invalid.')
 const lines=new Map(script.lines.map(line=>[line.id,line.text]))
 if(lines.size!==script.lines.length)fail(['frozen_script'],'Host dialogue is invalid.')
 const versions=[board.scriptSha256,object(board.script)?board.script.sha256:undefined].filter(v=>v!==undefined)
 if(!versions.length||versions.some(v=>v!==script.sha256))fail(['scriptSha256'],'Missing or stale frozen-script version. A hash alone does not prove matching dialogue.')
 const unquote=(v:string)=>{const text=v.trim(),pairs:Record<string,string>={'"':'"',"'":"'",'“':'”','‘':'’'};return pairs[text[0]]===text.at(-1)?text.slice(1,-1):text}
 const referenced=new Set<string>()
 const ref=(id:any,text:any,where:string)=>{
  if(typeof id!=='string'||!lines.has(id))fail(['dialogue_reference'],`Unknown dialogue id at ${where}.`)
  if(text!==undefined&&(typeof text!=='string'||text!==lines.get(id)))fail(['dialogue_text'],`Frozen dialogue text differs at ${where} (id ${id}).`)
  referenced.add(id)
 }
 const textRef=(value:string,where:string,explicit:boolean)=>{
  const v=value.trim();if(lines.has(v)){ref(v,undefined,where);return}
  const m=v.match(/^([A-Za-z0-9_.-]+)\s*[:：]\s*([\s\S]+)$/)
  if(m&&(explicit||lines.has(m[1])||/^(?:line|speech|dialogue)[_-]/i.test(m[1]))){ref(m[1],unquote(m[2]),where);return}
  if(explicit){const ids=[...lines].filter(([,text])=>text===value).map(([id])=>id);if(ids.length===1){ref(ids[0],value,where);return}fail(['dialogue_reference'],`Unresolved or ambiguous speech at ${where}; use an explicit frozen lineId.`)}
 }
 const speech=(v:any,where:string):void=>{
  if(v===null||v===undefined||v==='')return
  if(Array.isArray(v)){v.forEach((line,i)=>speech(line,`${where}[${i}]`));return}
  if(typeof v==='string'){textRef(v,where,true);return}
  if(object(v)){ref(v.lineId??v.id,v.text,where);return}
  fail(['dialogue_reference'],`Invalid speech at ${where}.`)
 }
 const declared=Array.isArray(board.script)?board.script:object(board.script)?board.script.lines:undefined
 if(declared!==undefined){
  if(!Array.isArray(declared)||declared.length!==script.lines.length||declared.some((l:any,i:number)=>!object(l)||l.id!==script.lines[i].id||l.text!==script.lines[i].text))fail(['script.lines'],'Canonical dialogue must match frozen ids, text and order exactly, with no omitted or duplicate lines.')
  declared.forEach((line:any)=>ref(line.id,line.text,'script'))
 }
 const walk=(v:any,path:string):void=>{
  if(Array.isArray(v)){v.forEach((x,i)=>walk(x,`${path}[${i}]`));return}
  if(!object(v))return
  if(v.lineId!==undefined)ref(v.lineId,v.text,path)
  if(v.role==='voice'&&v.lineId===undefined)fail(['dialogue_reference'],`Voice clip has no lineId at ${path}.`)
  for(const [key,child] of Object.entries(v)){
   if(key==='script'||key==='scriptSha256')continue
   if(key==='speech'||key==='dialogue')speech(child,`${path}.${key}`)
   else if(key==='sound'&&typeof child==='string')textRef(child,`${path}.sound`,false)
   else if(key==='sound'&&object(child)&&((child as any).lineId!==undefined||(child as any).type==='speech'))speech(child,`${path}.sound`)
   else walk(child,`${path}.${key}`)
  }
 }
 walk(board,'storyboard')
 const omitted=script.lines.filter(line=>!referenced.has(line.id)).map(line=>line.id)
 if(omitted.length)fail(['dialogue_coverage'],`Frozen lines are absent from the storyboard: ${omitted.join(', ')}.`)
 return {scriptSha256:script.sha256,lineCount:script.lines.length,qualityApproved:false}
}
