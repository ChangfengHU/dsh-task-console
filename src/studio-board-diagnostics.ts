import {createHash} from 'node:crypto'
/** Bounded field diagnostics, not media, timing or artistic validation.
 * Keep the pinned compiler authoritative; never coerce or rewrite a board. */
export function boardFieldDiagnostics(board:any){
 const issues:{field:string;expected:string;unexpectedFields?:string[]}[]=[];let total=0
 const add=(field:string,expected:string,unexpectedFields?:string[])=>{total++;if(issues.length<32)issues.push({field,expected,...(unexpectedFields?{unexpectedFields}:{})})}
 const object=(v:any,p:string,required:string[],optional:string[]=[])=>{
  if(!v||typeof v!=='object'||Array.isArray(v)){add(p,'object');return false}
  for(const key of required)if(!(key in v))add(p+'.'+key,'required field')
  // Report ordinary field names, never values; malformed/free-text keys remain redacted.
  const unknown=Object.keys(v).filter(k=>!required.includes(k)&&!optional.includes(k))
  if(unknown.length)add(p,'only fields: '+[...required,...optional].join(', '),unknown.slice(0,32).map(k=>/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)?k:'<non-schema-key>'))
  return true
 }
 const string=(v:any,p:string)=>{if(typeof v!=='string'||!v.trim())add(p,'nonempty string; source paths are a single project-relative string, not an array or object')}
 const numeric=(v:any,p:string)=>{if(typeof v!=='number'||!Number.isFinite(v))add(p,'finite number')}
 const transform=(v:any,p:string)=>{
  if(!object(v,p,[],['x','y','scale','rotation','opacity']))return
  for(const k of ['x','y','scale','rotation','opacity'])if(k in v)numeric(v[k],p+'.'+k)
 }
 object(board,'board',['schema','duration','gsap','font','script','scenes','audio'],['fps','background','notes','width','height','scriptSha256','visualRequirements'])
 // Documented planning metadata is retained verbatim, never interpreted as rendering parameters.
 for(const [key,value] of [['width',1080],['height',1920]] as const)if(key in board&&board[key]!==value)add('board.'+key,'fixed output dimension '+value)
 if('scriptSha256' in board){
  const lines=board.script,valid=Array.isArray(lines)&&lines.length>0&&lines.every((l:any)=>l&&typeof l==='object'&&!Array.isArray(l)&&Object.keys(l).length===2&&typeof l.id==='string'&&!!l.id.trim()&&typeof l.text==='string'&&!!l.text.trim())&&new Set(lines.map((l:any)=>l.id)).size===lines.length
  if(!valid)add('board.script','ordered unique {id,text} frozen lines required for scriptSha256')
  else if(board.scriptSha256!==createHash('sha256').update(JSON.stringify(lines.map(({id,text}:any)=>({id,text})))).digest('hex'))add('board.scriptSha256','SHA256 of the exact ordered frozen {id,text} lines; the host separately verifies these lines against its frozen script')
 }
 const sceneIds=new Set<string>()
 string(board.gsap,'board.gsap');string(board.font,'board.font')
 if(Array.isArray(board.scenes))board.scenes.forEach((s:any,si:number)=>{
  const p=`board.scenes[${si}]`
  if(!object(s,p,['start','duration','layers'],['notes','id','title','purpose']))return
  for(const key of ['id','title','purpose'])if(key in s){string(s[key],p+'.'+key)}
  if(typeof s.id==='string'){if(sceneIds.has(s.id))add(p+'.id','unique scene id');sceneIds.add(s.id)}
  numeric(s.start,p+'.start');numeric(s.duration,p+'.duration')
  if(!Array.isArray(s.layers)){add(p+'.layers','array of layers');return}
  s.layers.forEach((l:any,li:number)=>{
   const q=p+`.layers[${li}]`
   if(!object(l,q,['type','width','height'],['x','y','src','text','role','fontSize','fit','initial','motion','notes']))return
   numeric(l.width,q+'.width');numeric(l.height,q+'.height')
   for(const k of ['x','y','fontSize'])if(k in l)numeric(l[k],q+'.'+k)
   if(l.type==='image')string(l.src,q+'.src')
   else if(l.type==='text'){if(typeof l.text!=='string')add(q+'.text','string')}
   else add(q+'.type','image or text')
   if('initial' in l)transform(l.initial,q+'.initial')
   if('motion' in l){
    if(!Array.isArray(l.motion))add(q+'.motion','array of {at, duration, to, ease?}')
    else l.motion.forEach((m:any,mi:number)=>{
     const r=q+`.motion[${mi}]`
     if(object(m,r,['at','duration','to'],['ease'])){numeric(m.at,r+'.at');numeric(m.duration,r+'.duration');transform(m.to,r+'.to')}
    })
   }
  })
 })
 if('visualRequirements' in board){
  const items=board.visualRequirements,ids=new Set<string>(),covered=new Set<string>()
  if(!Array.isArray(board.scenes)||!board.scenes.length||board.scenes.some((s:any)=>!s||typeof s.id!=='string'||!s.id.trim()))add('board.scenes','unique nonempty scene ids required when visualRequirements is present')
  if(!Array.isArray(items)||!items.length||items.length>200)add('board.visualRequirements','1..200 planning metadata entries {id,sceneId,purpose}; not visual approval')
  else items.forEach((item:any,i:number)=>{
   const p=`board.visualRequirements[${i}]`
   if(!object(item,p,['id','sceneId','purpose']))return
   for(const key of ['id','sceneId','purpose'])string(item[key],p+'.'+key)
   if(typeof item.id==='string'){if(ids.has(item.id))add(p+'.id','unique requirement id');ids.add(item.id)}
   if(!sceneIds.has(item.sceneId))add(p+'.sceneId','existing scene id')
   else covered.add(item.sceneId)
  })
  if([...sceneIds].some(id=>!covered.has(id)))add('board.visualRequirements','at least one planning requirement for each scene; does not prove fulfillment')
 }
 if(Array.isArray(board.audio))board.audio.forEach((a:any,i:number)=>{
  const p=`board.audio[${i}]`
  if(!object(a,p,['src','role','start'],['trimStart','duration','volume','fadeOut','lineId','text','notes']))return
  string(a.src,p+'.src');numeric(a.start,p+'.start')
  if(!['voice','music','sfx'].includes(a.role))add(p+'.role','voice, music or sfx; no type field or dialogue role')
  for(const k of ['trimStart','duration','volume','fadeOut'])if(k in a)numeric(a[k],p+'.'+k)
  if(a.role==='voice'){string(a.lineId,p+'.lineId');string(a.text,p+'.text')}
 })
 return {issues,total,truncated:total>issues.length}
}

/** Explain all numeric scene discontinuities together; never invent action or alter timings. */
export function boardTimelineDiagnostics(board:any){
 const issues:any[]=[];let total=0,cursor=0
 const add=(value:any)=>{total++;if(issues.length<32)issues.push(value)}
 const duration=Number.isFinite(board?.duration)?board.duration:null
 const scenes=Array.isArray(board?.scenes)?board.scenes:[]
 for(let i=0;i<scenes.length;i++){
  const s=scenes[i],field=`board.scenes[${i}]`
  if(!Number.isFinite(s?.start)||!Number.isFinite(s?.duration)){add({field,kind:'invalid-numeric-timing'});continue}
  const end=s.start+s.duration,difference=s.start-cursor
  if(Math.abs(difference)>.001)add({field,kind:difference>0?'gap':'overlap',previousEnd:cursor,start:s.start,differenceSeconds:difference})
  if(s.start<0||s.duration<.1||!Number.isFinite(end))add({field,kind:'invalid-scene-range'})
  else if(duration!==null&&end>duration+.001)add({field,kind:'overrun',end,compositionDuration:duration})
  cursor=end
 }
 if(duration!==null&&Math.abs(cursor-duration)>.001)add({field:'board.scenes',kind:'incomplete-coverage',finalEnd:cursor,compositionDuration:duration})
 return {issues,total,truncated:total>issues.length,scope:'numeric-visual-timeline-only; audio sources and visual quality are not validated',qualityApproved:false,
  action:'scene.duration means visible scene time, not the length of one spoken sentence. Keep the full planned actions and complete film. Use a short program to inspect and repair all listed boundaries, then verify scene coverage and audio timing separately before compiling again. A key-moment gap is not a rendered scene. Do not remove scenes, shorten the film, or fill gaps with static placeholders to pass.'}
}
