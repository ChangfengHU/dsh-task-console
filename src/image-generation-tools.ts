import z from '@deepseek-ai/schemastery'
import { imagePolicy } from './image-policy.ts'
export const name = 'task-console-native-image-tools'
export const inject = ['tools','taskConsole']
export const Config = z.object({
  defaultBackend:z.union(['codex','gemini']).default('codex'),
  allowedBackends:z.array(z.union(['codex','gemini'])).default(['codex']),
  allowOverride:z.boolean().default(false), fallback:z.union(['none','unavailable-only']).default('none'),
  maxRequestsPerSession:z.natural().min(1).max(100).default(12),
})
/** Only structured image blocks in this session are admissible references. */
export function sessionImageRefs(session: any): Map<string,any> {
  const refs = new Map<string,any>()
  function visit(value: any) { if (!value || typeof value !== 'object') return; if (value.type === 'image' && value.attachment?.attachmentId) refs.set(String(value.attachment.attachmentId),value.attachment); if (Array.isArray(value)) for(const v of value)visit(v); else if(value.type === 'tool-result')visit(value.content) }
  for (const event of session.events || []) if(event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') visit(event.data?.message?.content)
  return refs
}
export async function apply(ctx: any, config: any = {}): Promise<void> {
  const policy = imagePolicy(Object.keys(config).length?config:undefined)
  const defineTool = process.env.NODE_ENV === 'test' ? (s: any)=>s : (await import('@deepseek-ai/dsh-tools')).defineTool
  const jobs = () => { const j = ctx.get('taskConsole').imageGeneration; if(!j)throw Error('宿主未启用内置生图服务'); return j }
  const session = (exec: any) => { if (!exec.agent?.session?.id) throw Error('真实 Agent 会话必需'); exec.signal?.throwIfAborted(); return exec.agent.session }
  const specs = [
    { name:'image_generate', description:`优先生图工具（不使用 MCP）。默认 ${policy.defaultBackend}；允许 ${policy.allowedBackends.join('/')}。每次生成/编辑一张图片，参考图仅用当前会话 attachmentId。立即返回 jobId。必须用 image_generate_status 等待 completed 后交付；不得重复提交，重试同一请求必须复用 requestId。后端超时/执行不明不自动切换。`, parameters:{prompt:{type:'string',required:true},requestId:{type:'string',required:true},backend:{type:'string'},referenceAttachmentIds:{type:'array',items:{type:'string'}}},
      execute:(args: any,exec: any)=>{ const s=session(exec), refs=sessionImageRefs(s); const ids=args.referenceAttachmentIds ?? []; if(!Array.isArray(ids)||ids.length>4)throw Error('最多四张参考图'); const references=ids.map((id: string)=>{const ref=refs.get(id);if(!ref)throw Error('参考图不属于当前会话；先读取或上传图片');return ref}); return jobs().start(String(s.id),{requestId:args.requestId,prompt:args.prompt,...(args.backend?{backend:args.backend}:{}),references},policy) } },
    { name:'image_generate_status',description:'查询当前会话自己的生图回执，默认最多等待 15 秒后返回。running 不代表成功；按 pollAfterMs 间隔查询，不重复 image_generate。completed 返回真实图片。取消等待不会撤销已受理任务，需要取消时用 image_generate_cancel。',parameters:{jobId:{type:'string',required:true},waitMs:{type:'integer'}},timeoutMs:20000,execute:(a: any,e: any)=>jobs().waitStatus(String(session(e).id),a.jobId,a.waitMs ?? 15000,e.signal) },
    { name:'image_generate_cancel',description:'取消当前会话自己的生图任务；取消不保证上游未扣额度，不自动重发。',parameters:{jobId:{type:'string',required:true}},execute:(a: any,e: any)=>jobs().cancel(String(session(e).id),a.jobId) },
  ]
  for (const spec of specs) ctx.effect(()=>ctx.tools.register(defineTool({...spec,output:{schema:{type:'object',additionalProperties:true},render:(_: any,value: any)=>[{type:'text',text:JSON.stringify(value)},...(value.state === 'completed'?(value.images || []).map((attachment: any)=>({type:'image',attachment})):[])]}})))
}
