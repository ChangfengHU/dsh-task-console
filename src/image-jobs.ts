import { createHash, randomUUID } from 'node:crypto'
import { imagePolicy, type ImageBackend, type ImagePolicy } from './image-policy.ts'

export interface ImageRequest { requestId: string; prompt: string; backend?: ImageBackend; references: any[]; executionId?:string }
export interface ImageProvider {
  prepare(signal: AbortSignal): Promise<{ generate(request: ImageRequest, signal: AbortSignal): Promise<{ images: any[]; model: string;route?:string;routeReason?:string }> }>
}
/** An explicit pre-dispatch unavailability is the only permitted fallback. */
export class ImageUnavailable extends Error {}

/** Durable receipts, not an in-memory polling loop. Never auto-replay uncertain jobs. */
export class ImageJobs {
  private live = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  constructor(private db: any, private providers: Partial<Record<ImageBackend, ImageProvider>>, private timeoutMs = 240000, private concurrency = 10) {
    if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>100)throw Error('生图并发必须为 1–100')
    db.exec(`CREATE TABLE IF NOT EXISTS dsh_native_image_jobs (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL,
      backend TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      result_json TEXT NOT NULL, UNIQUE(owner,request_id))`)
    db.exec('CREATE TABLE IF NOT EXISTS dsh_native_image_refs (owner TEXT NOT NULL, attachment_id TEXT NOT NULL, ref_json TEXT NOT NULL, PRIMARY KEY(owner,attachment_id))')
    db.prepare("UPDATE dsh_native_image_jobs SET state='interrupted',updated_at=?,result_json=? WHERE state='running'").run(new Date().toISOString(), JSON.stringify({ code:'HOST_RESTARTED', message:'宿主重启；执行结果未知，不自动重发。' }))
  }
  status(owner: string, id: string): any {
    const row = this.db.prepare('SELECT * FROM dsh_native_image_jobs WHERE id=? AND owner=?').get(id, owner)
    if (!row) throw Error('生图任务不存在或不属于当前会话')
    return { jobId:row.id, requestId:row.request_id, backend:row.backend, state:row.state, createdAt:row.created_at, updatedAt:row.updated_at, ...JSON.parse(row.result_json), ...(row.state === 'running' ? { pollAfterMs:5000, instruction:'继续使用 image_generate_status 查询同一 jobId，不要重新提交。' } : {}) }
  }
  pending(owner: string): string | undefined {
    return this.db.prepare("SELECT id FROM dsh_native_image_jobs WHERE owner=? AND state='running' ORDER BY created_at LIMIT 1").get(owner)?.id
  }
  list(owner: string): any[] {
    if (!owner) throw Error('真实会话必需')
    return this.db.prepare('SELECT id FROM dsh_native_image_jobs WHERE owner=? ORDER BY created_at DESC LIMIT 100').all(owner).map((row:any)=>this.status(owner,row.id))
  }
  recordReference(owner:string, image:any):void {
    if(!owner||!image?.attachmentId)throw Error('真实图片归属必需')
    this.db.prepare('INSERT OR REPLACE INTO dsh_native_image_refs VALUES (?,?,?)').run(owner,String(image.attachmentId),JSON.stringify(image))
  }
  references(owner:string):Map<string,any> {
    const refs=new Map<string,any>(this.db.prepare('SELECT attachment_id,ref_json FROM dsh_native_image_refs WHERE owner=?').all(owner).map((r:any)=>[r.attachment_id,JSON.parse(r.ref_json)]))
    for(const receipt of this.list(owner))for(const ref of receipt.images || [])refs.set(String(ref.attachmentId),ref)
    return refs
  }
  async waitStatus(owner: string, id: string, waitMs: number, signal: AbortSignal): Promise<any> {
    const initial = this.status(owner,id)
    if (!Number.isSafeInteger(waitMs) || waitMs<0 || waitMs>15000) throw Error('waitMs 必须在 0–15000 之间')
    signal.throwIfAborted()
    const job = this.live.get(id)
    if(initial.state !== 'running' || !job || !waitMs)return initial
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (()=>void) | undefined
    try { await Promise.race([job.promise,new Promise<void>((resolve,reject)=>{timer=setTimeout(resolve,waitMs);abort=()=>reject(signal.reason ?? Error('取消等待'));signal.addEventListener('abort',abort,{once:true})})]);signal.throwIfAborted();return this.status(owner,id) }
    finally {if(timer)clearTimeout(timer);if(abort)signal.removeEventListener('abort',abort)}
  }
  start(owner: string, input: ImageRequest, policyValue: ImagePolicy): any {
    const policy = imagePolicy(policyValue)
    if (!owner || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16000 || !/^[A-Za-z0-9._-]{1,120}$/.test(input.requestId)) throw Error('生图请求需要有效 requestId 和 1–16000 字符的提示词')
    if (!Array.isArray(input.references) || input.references.length > 4) throw Error('最多使用四张会话内参考图')
    const backend = input.backend ?? policy.defaultBackend
    if (!policy.allowedBackends.includes(backend) || input.backend && backend !== policy.defaultBackend && !policy.allowOverride) throw Error('当前 Agent 未授权这个生图后端')
    const request = { requestId:input.requestId, prompt:input.prompt.trim(), references:input.references, backend }
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const prior = this.db.prepare('SELECT id,digest FROM dsh_native_image_jobs WHERE owner=? AND request_id=?').get(owner,input.requestId)
    if (prior) { if (prior.digest !== digest) throw Error('同一 requestId 不能替换提示词或参考图'); return this.status(owner,prior.id) }
    if (this.live.size >= this.concurrency) throw Error('生图并发已满；尚未提交上游，请稍后使用同一 requestId')
    const id = `img-${randomUUID()}`, at = new Date().toISOString()
    this.db.transaction(() => {
      const count = this.db.prepare('SELECT COUNT(*) n FROM dsh_native_image_jobs WHERE owner=?').get(owner).n
      if (count >= policy.maxRequestsPerSession) throw Error('当前 Agent 会话生图预算已用完；不能通过重试或换后端绕过')
      this.db.prepare('INSERT INTO dsh_native_image_jobs VALUES (?,?,?,?,?,?,?,?,?)').run(id,owner,input.requestId,digest,backend,'running',at,at,'{}')
    })()
    const controller = new AbortController()
    // Register before yielding so concurrent calls cannot evade the limit.
    const entry = { controller, promise:Promise.resolve() }; this.live.set(id,entry)
    entry.promise = this.perform(id, request, input.backend?{...policy,fallback:'none'}:policy, controller).finally(() => this.live.delete(id))
    return this.status(owner,id)
  }
  private async perform(id: string, request: ImageRequest, policy: ImagePolicy, controller: AbortController) {
    let backend = request.backend!, dispatched = false, timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.timeoutMs)
    try {
      let prepared: Awaited<ReturnType<ImageProvider['prepare']>>
      try {
        if (!this.providers[backend]) throw new ImageUnavailable('后端未配置')
        prepared = await this.providers[backend]!.prepare(controller.signal)
      } catch (error) {
        if (!(error instanceof ImageUnavailable) || policy.fallback !== 'unavailable-only' || controller.signal.aborted) throw error
        const alternate = policy.allowedBackends.find(b => b !== backend && this.providers[b])
        if (!alternate) throw error
        backend = alternate; prepared = await this.providers[backend]!.prepare(controller.signal)
        this.db.prepare('UPDATE dsh_native_image_jobs SET backend=? WHERE id=?').run(backend,id)
      }
      controller.signal.throwIfAborted(); dispatched = true
      // The user requestId is session scoped; the service needs a globally unique job ID.
      const result = await prepared.generate({...request,executionId:id},controller.signal)
      controller.signal.throwIfAborted()
      if (!result.images.length || result.images.length > 4) throw Error('上游没有返回可验证的图片')
      this.finish(id,'completed',{ images:result.images, model:result.model,...(result.route?{route:result.route,routeReason:result.routeReason}:{}), execution:'verified-image-output' })
    } catch (error) {
      const state = controller.signal.aborted ? timedOut ? 'interrupted' : 'cancelled' : dispatched ? 'failed' : 'unavailable'
      this.finish(id,state,{ code:timedOut?'TIMEOUT_UNKNOWN':controller.signal.aborted?'CANCELLED':dispatched?'GENERATION_FAILED':'BACKEND_UNAVAILABLE', message:timedOut?'等待超时，执行结果未知；不自动重发。':controller.signal.aborted?'请求已取消；上游可能已消耗额度。':dispatched?'生成未取得有效图片；不自动重试或切换后端。':'生图后端未就绪，请检查宿主配置。', mayHaveConsumedQuota:dispatched })
    } finally { clearTimeout(timer) }
  }
  private finish(id: string, state: string, result: any) { this.db.prepare('UPDATE dsh_native_image_jobs SET state=?,updated_at=?,result_json=? WHERE id=?').run(state,new Date().toISOString(),JSON.stringify(result),id) }
  async cancel(owner: string, id: string) { this.status(owner,id); const job = this.live.get(id); if (job) { job.controller.abort(); await job.promise }; return this.status(owner,id) }
  async dispose() { for (const job of this.live.values()) job.controller.abort(); await Promise.all([...this.live.values()].map(j=>j.promise)) }
}
