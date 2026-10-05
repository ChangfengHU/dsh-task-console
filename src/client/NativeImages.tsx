import {useEffect,useState} from 'react'

async function rpc(method:string,payload:any){
  const response=await fetch('/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:{payload:JSON.stringify(payload)}}})})
  const result=(await response.json()).result
  if(!response.ok||!result?.ok)throw Error('读取图片资产失败')
  return JSON.parse(result.value)
}
function Asset({sessionId,jobId,index}:{sessionId:string;jobId:string;index:number}){
  const [src,setSrc]=useState(''),[error,setError]=useState(''),[extension,setExtension]=useState('png')
  useEffect(()=>{let live=true;void rpc('taskConsole/nativeImageAsset',{sessionId,jobId,index}).then(value=>{if(live){setSrc(`data:${value.image.mediaType};base64,${value.data}`);setExtension(value.image.mediaType==='image/jpeg'?'jpg':value.image.mediaType==='image/webp'?'webp':'png')}}).catch(e=>{if(live)setError(e.message)});return()=>{live=false}},[sessionId,jobId,index])
  if(error)return <p>{error}</p>
  if(!src)return <p>加载图片…</p>
  return <div><img src={src} alt="内置工具生成的图片" style={{maxWidth:'100%',maxHeight:480,objectFit:'contain'}}/><p><a href={src} download={`${jobId}-${index}.${extension}`}>下载图片</a></p></div>
}
/** UI reads host-owned assets, never adds ImageBlocks to model history. */
export function NativeImagesView({sessionId}:{sessionId:string}){
  const [jobs,setJobs]=useState<any[]>([]),[error,setError]=useState('')
  useEffect(()=>{let live=true;setJobs([]);setError('');const load=async()=>{try{const value=await rpc('taskConsole/nativeImageJobs',{sessionId});if(live){setJobs(value.jobs);setError('')}}catch(e){if(live)setError(String((e as Error).message))}};void load();const timer=setInterval(()=>{if(!document.hidden)void load()},5000);return()=>{live=false;clearInterval(timer)}},[sessionId])
  return <section style={{padding:24,overflow:'auto',height:'100%'}}><h2>图片资产</h2><p>固定生图后端的真实结果；切换聊天模型不影响展示。识图报告由固定视觉模型返回。</p>{error&&<p role="alert">{error}</p>}{!error&&!jobs.length&&<p>当前会话暂无内置生图任务。</p>}{jobs.map(job=><article key={job.jobId} style={{borderTop:'1px solid #ddd',padding:'16px 0'}}><p>{job.backend} · {job.state} · {job.model || '尚未取得生成结果'}</p><small>{job.jobId}</small>{job.message&&<p>{job.message}</p>}{job.state==='completed'&&(job.images || []).map((_:any,index:number)=><Asset key={index} sessionId={sessionId} jobId={job.jobId} index={index}/>)}</article>)}</section>
}
