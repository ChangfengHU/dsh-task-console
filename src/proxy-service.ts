/** Persistent, bounded operations; an ambiguous write is never automatically replayed. */
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdir, lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { authorizeProxy, proxyIp, type ProxyPolicy } from './proxy-policy.ts'

export type ProxyAction = 'inspect'|'verify'|'repair'|'receipt'
export type ProxyResult = { ok: boolean; reason?: string; phase?: string; quiescent?: boolean; [key:string]: unknown }
export type ProxyTransport = (action: ProxyAction, ip: string, operationId: string, emit:(event:Record<string,unknown>)=>void)=>Promise<ProxyResult>
const requestId=z.string().regex(/^[a-zA-Z0-9_-]{16,96}$/)
const schemas={ proxy_inspect:z.object({ip:proxyIp}).strict(),
  proxy_verify:z.object({ip:proxyIp,requestId}).strict(), proxy_repair:z.object({ip:proxyIp,requestId}).strict(),
  proxy_status:z.object({operationId:z.string().uuid(),after:z.number().int().min(0).default(0)}).strict() }
export const proxyTools = Object.entries(schemas).map(([name,schema])=>({name,inputSchema:z.toJSONSchema(schema),
  description: ({proxy_inspect:'只读查询允许节点的Controller与历史出口证据；历史快照不是本次验收。',
    proxy_verify:'只读主动验收：系统代理TCP/UDP及预期出口。返回操作编号，使用proxy_status查看结果；不会修复代理或调整时区。',
    proxy_repair:'仅对允许修复的节点幂等恢复已批准线路；不接收命令、凭据或URL。不操作本机、不装机、不改浏览器。返回操作编号；未知结果禁止换requestId盲重试。',
    proxy_status:'分页查询操作阶段和终态，每页最多50事件。unknown表示结果不确定且锁保留，不是失败重试许可。'} as Record<string,string>)[name],
  annotations:{readOnlyHint:name!=='proxy_repair',destructiveHint:name==='proxy_repair',idempotentHint:true,openWorldHint:true}}))
type Row={id:string;principal:string;ip:string;action:ProxyAction;state:string;request_id:string;started_at:string;updated_at:string;owner_pid:number;result_json:string|null}
const safeReason=(e:unknown)=>e instanceof Error && /^[a-z][a-z0-9-]{1,95}$/.test(e.message)?e.message:'proxy-operation-failed'

export class ProxyService {
  readonly pending=new Set<Promise<void>>()
  constructor(readonly db:Database.Database,readonly policy:ProxyPolicy|undefined,readonly transport:ProxyTransport) {
    db.pragma('journal_mode = WAL');db.pragma('busy_timeout = 5000')
    db.exec(`CREATE TABLE IF NOT EXISTS proxy_operations(id TEXT PRIMARY KEY,principal TEXT NOT NULL,ip TEXT NOT NULL,action TEXT NOT NULL,request_id TEXT NOT NULL,state TEXT NOT NULL,started_at TEXT NOT NULL,updated_at TEXT NOT NULL,owner_pid INTEGER NOT NULL,result_json TEXT,UNIQUE(principal,request_id));
      CREATE TABLE IF NOT EXISTS proxy_node_locks(ip TEXT PRIMARY KEY,operation_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proxy_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL,at TEXT NOT NULL,payload_json TEXT NOT NULL);`)
  }
  static async open(policy:ProxyPolicy|undefined,transport:ProxyTransport) {
    let file=':memory:'
    if(policy){await mkdir(policy.stateDir,{recursive:true,mode:0o700});const s=await lstat(policy.stateDir)
      if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077))throw new Error('private-state-directory-required')
      file=join(policy.stateDir,'proxy.db')
      const f=await lstat(file).catch(()=>undefined);if(f&&(!f.isFile()||f.isSymbolicLink()||f.uid!==process.getuid?.()||(f.mode&0o077)))throw new Error('private-database-required')
      if(!f)await open(file,'wx',0o600).then(f=>f.close()).catch(async e=>{
        if(e.code!=='EEXIST')throw e
        const row=await lstat(file)
        if(!row.isFile()||row.isSymbolicLink()||row.uid!==process.getuid?.()||(row.mode&0o077))throw new Error('private-database-required')
      })
    }
    return new ProxyService(new Database(file),policy,transport)
  }
  tools(){return proxyTools.filter(t=>t.name!=='proxy_repair'||this.policy?.nodes.some(n=>n.repair))}
  async call(name:string,raw:unknown):Promise<Record<string,unknown>>{
    if(!Object.hasOwn(schemas,name))throw new Error('unknown-proxy-tool')
    const parsed=schemas[name as keyof typeof schemas].safeParse(raw)
    if(!parsed.success)throw new Error('invalid-proxy-arguments')
    const args=parsed.data as any
    if(name==='proxy_status')return this.status(args.operationId,args.after)
    authorizeProxy(this.policy,args.ip,name==='proxy_repair')
    if(name==='proxy_inspect')return this.transport('inspect',args.ip,randomUUID(),()=>{})
    const action=name==='proxy_verify'?'verify':'repair',now=new Date().toISOString(),principal=this.policy!.principal
    const existing=this.db.prepare('SELECT * FROM proxy_operations WHERE principal=? AND request_id=?').get(principal,args.requestId) as Row|undefined
    if(existing){if(existing.ip!==args.ip||existing.action!==action)throw new Error('request-id-conflict');return this.status(existing.id,0)}
    const id=randomUUID()
    this.db.transaction(()=>{
      if(this.db.prepare('SELECT 1 FROM proxy_node_locks WHERE ip=?').get(args.ip))throw new Error('proxy-node-busy-or-unknown')
      this.db.prepare('INSERT INTO proxy_operations VALUES (?,?,?,?,?,?,?,?,?,NULL)').run(id,principal,args.ip,action,args.requestId,'running',now,now,process.pid)
      this.db.prepare('INSERT INTO proxy_node_locks VALUES (?,?)').run(args.ip,id)
      this.event(id,{stage:'accepted',action})
    }).immediate()
    const work=this.run(id,args.ip,action);this.pending.add(work);void work.then(()=>this.pending.delete(work),()=>this.pending.delete(work))
    return this.status(id,0)
  }
  private event(id:string,event:Record<string,unknown>){const now=new Date().toISOString()
    this.db.prepare('INSERT INTO proxy_events(operation_id,at,payload_json) VALUES (?,?,?)').run(id,now,JSON.stringify(event))
    this.db.prepare('UPDATE proxy_operations SET updated_at=? WHERE id=?').run(now,id)
  }
  private finish(id:string,result:ProxyResult){const state=result.quiescent===true?(result.ok?'succeeded':'blocked'):'unknown'
    this.db.transaction(()=>{
      this.db.prepare('UPDATE proxy_operations SET state=?,updated_at=?,result_json=? WHERE id=?').run(state,new Date().toISOString(),JSON.stringify(result),id)
      if(state!=='unknown')this.db.prepare('DELETE FROM proxy_node_locks WHERE operation_id=?').run(id)
      this.event(id,{stage:state,reason:result.reason??null})
    }).immediate()
  }
  private async run(id:string,ip:string,action:ProxyAction){
    const heartbeat=setInterval(()=>this.event(id,{stage:'heartbeat'}),15000)
    try{this.finish(id,await this.transport(action,ip,id,event=>this.event(id,event)))}
    catch(e){this.finish(id,{ok:false,reason:safeReason(e),quiescent:false})}
    finally{clearInterval(heartbeat)}
  }
  async status(id:string,after=0):Promise<Record<string,unknown>>{
    let row=this.db.prepare('SELECT * FROM proxy_operations WHERE id=? AND principal=?').get(id,this.policy?.principal??'') as Row|undefined
    if(!row)throw new Error('proxy-operation-not-found')
    authorizeProxy(this.policy,row.ip)
    // PID liveness alone cannot prove ownership after a restart. A bounded stale
    // heartbeat becomes unknown, retaining the lock until exact remote reconciliation.
    if(row.state==='running'&&Date.now()-Date.parse(row.updated_at)>180000){
      this.db.prepare("UPDATE proxy_operations SET state='unknown' WHERE id=? AND state='running'").run(id);row={...row,state:'unknown'}
    }
    if(row.state==='unknown'){
      try{const result=await this.transport('receipt',row.ip,id,()=>{});if(result.quiescent===true&&result.receiptOperationId===id){this.finish(id,result);row=this.db.prepare('SELECT * FROM proxy_operations WHERE id=?').get(id) as Row}}
      catch{/* unknown remains locked; no repair is resubmitted */}
    }
    const rows=this.db.prepare('SELECT seq,at,payload_json FROM proxy_events WHERE operation_id=? AND seq>? ORDER BY seq LIMIT 51').all(id,after) as any[]
    const events=rows.slice(0,50).map(r=>({seq:r.seq,at:r.at,...JSON.parse(r.payload_json)}))
    return {operationId:id,ip:row.ip,lineId:authorizeProxy(this.policy,row.ip).lineId,action:row.action,state:row.state,startedAt:row.started_at,updatedAt:row.updated_at,
      events,hasMore:rows.length>50,nextAfter:events.at(-1)?.seq??after,result:row.result_json?JSON.parse(row.result_json):null}
  }
  async close(){await Promise.all(this.pending);this.db.close()}
}
