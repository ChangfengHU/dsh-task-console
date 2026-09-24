/** Bounded field diagnostics, not media, timing or artistic validation.
 * Keep the pinned compiler authoritative; never coerce or rewrite a board. */
export function boardFieldDiagnostics(board:any){
 const issues:{field:string;expected:string}[]=[];let total=0
 const add=(field:string,expected:string)=>{total++;if(issues.length<32)issues.push({field,expected})}
 const object=(v:any,p:string,required:string[],optional:string[]=[])=>{
  if(!v||typeof v!=='object'||Array.isArray(v)){add(p,'object');return false}
  for(const key of required)if(!(key in v))add(p+'.'+key,'required field')
  // Do not echo arbitrary unknown keys or values (they can contain secrets).
  if(Object.keys(v).some(k=>!required.includes(k)&&!optional.includes(k)))add(p,'only fields: '+[...required,...optional].join(', '))
  return true
 }
 const string=(v:any,p:string)=>{if(typeof v!=='string'||!v.trim())add(p,'nonempty string; source paths are a single project-relative string, not an array or object')}
 const numeric=(v:any,p:string)=>{if(typeof v!=='number'||!Number.isFinite(v))add(p,'finite number')}
 const transform=(v:any,p:string)=>{
  if(!object(v,p,[],['x','y','scale','rotation','opacity']))return
  for(const k of ['x','y','scale','rotation','opacity'])if(k in v)numeric(v[k],p+'.'+k)
 }
 object(board,'board',['schema','duration','gsap','font','script','scenes','audio'],['fps','background','notes'])
 string(board.gsap,'board.gsap');string(board.font,'board.font')
 if(Array.isArray(board.scenes))board.scenes.forEach((s:any,si:number)=>{
  const p=`board.scenes[${si}]`
  if(!object(s,p,['start','duration','layers'],['notes']))return
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
