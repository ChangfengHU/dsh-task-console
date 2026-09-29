import {useEffect,useState} from 'react'

export interface ExecutionMigrationApi {
 previewExecutionMigration:(input:{taskId:string;batchId:string})=>Promise<any>
 applyExecutionMigration:(input:{taskId:string;batchId:string;expectedPreviewSha256:string;reason:string})=>Promise<any>
}

/** Two-step, hash-bound operator review. Preview never edits a Batch or dispatches work. */
export function ExecutionMigrationReview({api,taskId,batchId,onApplied}:{api:ExecutionMigrationApi;taskId:string;batchId:string;onApplied:()=>Promise<void>|void}){
 const [preview,setPreview]=useState<any>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[applying,setApplying]=useState(false)
 const inspect=async()=>{setLoading(true);setError('');setPreview(null);try{setPreview(await api.previewExecutionMigration({taskId,batchId}))}catch(e){const message=String((e as Error).message??e);setError(message.includes('migration-snapshot-unavailable')||message.includes('snapshot-unavailable')?'批次创建时没有保存可验证的原始执行快照。系统不会猜测或重建冻结配置；这个旧批次不能安全迁移。':message)}finally{setLoading(false)}}
 useEffect(()=>{void inspect()},[taskId,batchId])
 const apply=async()=>{if(!preview?.previewSha256)return;setApplying(true);setError('');try{await api.applyExecutionMigration({taskId,batchId,expectedPreviewSha256:preview.previewSha256,reason:'Operator reviewed the exact execution identity migration preview before recovery.'});await onApplied()}catch(e){setError(String((e as Error).message??e))}finally{setApplying(false)}}
 const changes=preview?.runtimeChanges
 return <section className="dtc-execution-migration" aria-label="执行身份迁移检查"><div><b>执行身份发生变化</b><small>旧 Run 保留。迁移预览只读；检查差异后，才会应用审计迁移。</small></div>{!preview?<button className="dtc-btn sm" disabled={loading||applying} onClick={()=>void inspect()}>{loading?'正在核对冻结快照…':'重新检查快照'}</button>:<><dl><dt>旧运行根目录</dt><dd>{changes?.fromRoot??'—'}</dd><dt>当前运行根目录</dt><dd>{changes?.toRoot??'—'}</dd><dt>运行时代码变更</dt><dd>新增 {changes?.addedFiles?.length??0} · 修改 {changes?.changedFiles?.length??0} · 删除 {changes?.removedFiles?.length??0}</dd><dt>依赖变更</dt><dd>{changes?.dependencyChanges?.length??0} 项 · Node {changes?.nodeVersionChanged?'版本有变化':'版本不变'}</dd><dt>目标绑定摘要</dt><dd><code>{preview.binding?.sha256??'—'}</code></dd><dt>预览摘要</dt><dd><code>{preview.previewSha256}</code></dd></dl>{((changes?.addedFiles?.length??0)+(changes?.changedFiles?.length??0)+(changes?.removedFiles?.length??0))>0?<details><summary>查看文件差异</summary><ul>{[...(changes.addedFiles??[]).map((x:string)=>`新增 ${x}`),...(changes.changedFiles??[]).map((x:string)=>`修改 ${x}`),...(changes.removedFiles??[]).map((x:string)=>`删除 ${x}`)].slice(0,30).map((x:string)=><li key={x}>{x}</li>)}</ul></details>:<p>代码与依赖文件未变；预览检测到的是路径或宿主身份变化。</p>}<p>应用后会追加执行身份迁移记录，不覆盖批次原始冻结；下一步将重新执行当前阻塞节点。</p><button className="dtc-btn pri sm" disabled={loading||applying} onClick={()=>void apply()}>{applying?'正在应用并恢复…':'确认迁移并恢复节点'}</button></>}{error?<div className="dtc-err">预览/迁移未完成：{error}</div>:null}</section>
}
