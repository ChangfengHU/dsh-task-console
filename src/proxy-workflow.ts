import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CompletionCheck } from './runner.ts'
import type { EventStore } from './tasks.ts'

const PATHS=['generic_exit_ip','cloudflare_exit_ip','claude_exit_ip','udp_cloudflare_exit_ip','udp_google_exit_ip']
const FRESH_MS=15*60_000
export function proxyRequestId(sessionId:string,requestId:unknown) {
  if(!sessionId||typeof requestId!=='string'||!/^[A-Za-z0-9_-]{16,96}$/.test(requestId))throw Error('proxy-request-id-invalid')
  return createHash('sha256').update(sessionId+'\0'+requestId).digest('hex')
}
function decoded(value:any){
  if(value?.structuredContent)return value.structuredContent
  try{return JSON.parse((value?.content??[]).filter((p:any)=>p.type==='text').map((p:any)=>p.text).join(''))}catch{return null}
}
export function validProxyProof(value:any,lineId:string,since:string,now=Date.now()) {
  const r=value?.result,e=r?.evidence,at=Date.parse(e?.verifiedAt),started=Date.parse(value?.startedAt)
  return value?.state==='succeeded'&&value.lineId===lineId&&r?.ok===true&&r.quiescent===true&&e?.ok===true&&
    Number.isFinite(at)&&Number.isFinite(started)&&started>=Date.parse(since)&&at>=started&&at<=now&&now-at<=FRESH_MS&&
    typeof e.expectedIp==='string'&&PATHS.every(k=>e.paths?.[k]===e.expectedIp)&&r.snapshot?.sourceMatches===true&&r.snapshot?.serviceActive===true&&r.snapshot?.tunPresent===true
}

/** Opt-in Task adapter; all network work still happens in the Agent's MCP call. */
export class ProxyWorkflow {
  constructor(private store:EventStore){}
  private db(){
    const db=this.store.kernel.db
    db.exec(`CREATE TABLE IF NOT EXISTS dsh_proxy_round_items(batch_id TEXT NOT NULL,round INTEGER NOT NULL,ip TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(batch_id,round,ip));
      CREATE TABLE IF NOT EXISTS dsh_proxy_issues(id INTEGER PRIMARY KEY AUTOINCREMENT,spec_id TEXT NOT NULL,ip TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_dsh_proxy_open_issue ON dsh_proxy_issues(spec_id,ip) WHERE state='open';
      CREATE TABLE IF NOT EXISTS dsh_proxy_calls(request_id TEXT PRIMARY KEY,spec_id TEXT NOT NULL,batch_id TEXT NOT NULL,card_id TEXT NOT NULL,session_id TEXT NOT NULL,ip TEXT NOT NULL,action TEXT NOT NULL,issue_id INTEGER,operation_id TEXT UNIQUE,state TEXT NOT NULL,result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dsh_proxy_checks(operation_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,card_id TEXT NOT NULL,session_id TEXT NOT NULL,role TEXT NOT NULL,ip TEXT NOT NULL,checked_at TEXT NOT NULL,accepted INTEGER NOT NULL,result_json TEXT NOT NULL);`)
    return db
  }
  plan(input:CompletionCheck,browsers:any[],candidate:unknown){
    if(!input.task.design?.proxy){if(candidate!==undefined)throw Error('proxy-plan-not-reviewed');return undefined}
    const db=this.db()
    if(input.card.role!=='planner'||!Array.isArray(candidate)||!candidate.length||candidate.length>128)throw Error('proxy-items-required')
    const nodes=new Set(browsers.map(row=>row.ip)),seen=new Set<string>()
    const items=candidate.map(row=>{
      if(!row||Object.keys(row).some(k=>!['ip','action','reason'].includes(k))||!nodes.has(row.ip)||seen.has(row.ip)||!['verify','repair'].includes(row.action)||typeof row.reason!=='string'||!row.reason.trim()||row.reason.length>1000)throw Error('proxy-round-item-invalid')
      seen.add(row.ip);return {ip:row.ip,action:row.action,reason:row.reason.trim()}
    })
    if(seen.size!==nodes.size)throw Error('proxy-plan-must-cover-browser-nodes')
    return {items,commit:()=>{
      if(db.prepare('SELECT 1 FROM dsh_proxy_round_items WHERE batch_id=? AND round=?').get(input.batch.id,input.card.round!))throw Error('proxy-round-already-frozen')
      for(const item of items)db.prepare('INSERT INTO dsh_proxy_round_items VALUES (?,?,?,?,?)').run(input.batch.id,input.card.round!,item.ip,item.action,item.reason)
      this.store.kernel.recordEvent(input.card.id,'proxy_round_planned',{round:input.card.round,items,lineId:input.task.design!.proxy!.lineId})
    }}
  }
  private proof(input:CompletionCheck,ip:string,now=Date.now(),independent=false){
    const db=this.db(), rows=db.prepare('SELECT * FROM dsh_proxy_checks WHERE batch_id=? AND ip=? ORDER BY checked_at DESC,rowid DESC').all(input.batch.id,ip) as any[]
    const latest=rows[0]
    if(!latest||!latest.accepted)return null
    const mutation=db.prepare("SELECT created_at FROM dsh_proxy_calls WHERE spec_id=? AND ip=? AND action='repair' ORDER BY created_at DESC LIMIT 1").get(input.task.id,ip) as any
    const pending=db.prepare("SELECT 1 FROM dsh_proxy_calls WHERE ip=? AND state IN ('running','unknown') LIMIT 1").get(ip)
    const chosen=independent?rows.find(r=>r.role==='reviewer'&&r.accepted):latest
    const adverse=rows.find(r=>!r.accepted)
    if(!chosen||pending||mutation&&Date.parse(chosen.checked_at)<Date.parse(mutation.created_at))return null
    if(independent&&adverse&&Date.parse(chosen.checked_at)<=Date.parse(adverse.checked_at))return null
    const value=JSON.parse(chosen.result_json),latestValue=JSON.parse(latest.result_json)
    if(independent&&value.result?.evidence?.expectedIp!==latestValue.result?.evidence?.expectedIp)return null
    // Historical independent acceptance does not expire during downstream login
    // stability waits. Actual new writes still require a fresh network check.
    return validProxyProof(value,input.task.design!.proxy!.lineId,input.batch.firedAt,independent?Date.parse(chosen.checked_at):now)?chosen:null
  }
  assertBrowser(input:CompletionCheck,args:any){
    if(!input.task.design?.proxy)return
    if(!this.proof(input,args?.ip))throw Error('proxy-gate-not-verified: 先取得本轮新鲜代理验收，不能执行登录复制或续接')
  }
  status(input:CompletionCheck){
    if(!input.task.design?.proxy)return undefined
    const db=this.db(), planned=db.prepare('SELECT ip,action,reason FROM dsh_proxy_round_items WHERE batch_id=? AND round=? ORDER BY ip').all(input.batch.id,input.card.round??0)
    const inventory=db.prepare('SELECT inventory_json FROM dsh_patrol_inventory WHERE batch_id=?').get(input.batch.id) as any
    const ips=inventory?JSON.parse(inventory.inventory_json).nodes.filter((n:any)=>n.readAuthorized&&n.browsers?.length&&!input.task.design?.browserPatrol?.excludedNodeIds?.includes(n.nodeId)).map((n:any)=>n.ip):[]
    const operations=db.prepare('SELECT operation_id,ip,action,state,created_at,updated_at,session_id FROM dsh_proxy_calls WHERE batch_id=? ORDER BY created_at').all(input.batch.id)
    return {lineId:input.task.design.proxy.lineId,plan:planned,items:ips.map(ip=>{
      const proof=this.proof(input,ip),independent=this.proof(input,ip,Date.now(),true)
      const last=db.prepare('SELECT * FROM dsh_proxy_checks WHERE batch_id=? AND ip=? ORDER BY checked_at DESC,rowid DESC LIMIT 1').get(input.batch.id,ip) as any
      const result=last?JSON.parse(last.result_json):null
      return {ip,accepted:!!proof,independent:!!independent,operationId:last?.operation_id??null,sessionId:last?.session_id??null,checkedAt:last?.checked_at??null,
        expectedIp:result?.result?.evidence?.expectedIp??null,paths:result?.result?.evidence?.paths??null,reason:result?.result?.reason??(proof?'verified':'fresh-proxy-evidence-required')}
    }),operations}
  }
  complete(input:CompletionCheck){
    const status=this.status(input)
    if(!status)return
    if(input.card.role==='proxy') {
      const terminal=(status.plan as any[]).every(item=>{
        const call=this.db().prepare('SELECT state FROM dsh_proxy_calls WHERE card_id=? AND ip=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(input.card.id,item.ip) as any
        return this.proof(input,item.ip)||call?.state==='blocked'
      })
      if(!status.plan.length||!terminal)throw Error('proxy-completion-needs-fresh-native-evidence')
      const current=status.items.filter(row=>(status.plan as any[]).some(item=>item.ip===row.ip))
      return {summary:`代理阶段交接：本轮 ${current.filter(row=>row.accepted).length}/${current.length} 台通过 TCP/UDP 验收；未通过目标禁止登录写入，其他目标继续。\n${JSON.stringify(current)}`,metadata:{proxy:status}}
    }
    if(input.card.role==='planner'&&input.metadata?.patrolDisposition!=='unresolved'&&(!status.items.length||status.items.some(row=>!row.independent)))throw Error('proxy-finalization-needs-independent-review')
  }
  async invoke(input:CompletionCheck,raw:string,args:any,invoke:(args:any)=>Promise<any>){
    const policy=input.task.design!.proxy!,db=this.db(),now=new Date().toISOString()
    if(raw==='proxy_inspect') {
      const inventory=db.prepare("SELECT inventory_json FROM dsh_patrol_inventory WHERE batch_id=?").get(input.batch.id) as any
      if(!inventory||!JSON.parse(inventory.inventory_json).nodes.some((n:any)=>n.ip===args.ip&&n.readAuthorized&&!input.task.design?.browserPatrol?.excludedNodeIds?.includes(n.nodeId)))throw Error('proxy-target-not-in-inventory')
      return invoke(args)
    }
    if(raw==='proxy_status'){
      const row=db.prepare('SELECT * FROM dsh_proxy_calls WHERE operation_id=? AND spec_id=? AND card_id=?').get(args.operationId,input.task.id,input.card.id) as any
      if(!row)throw Error('proxy-operation-not-owned-by-session')
      const value=await invoke(args);this.observe(input,row,decoded(value));return value
    }
    if(!['proxy_verify','proxy_repair'].includes(raw))throw Error('proxy-tool-unsupported')
    const action=raw==='proxy_repair'?'repair':'verify',requestId=proxyRequestId(input.sessionId,args.requestId)
    const item=db.prepare('SELECT * FROM dsh_proxy_round_items WHERE batch_id=? AND round=? AND ip=?').get(input.batch.id,input.card.round??0,args.ip) as any
    const inventory=db.prepare("SELECT inventory_json FROM dsh_patrol_inventory WHERE batch_id=?").get(input.batch.id) as any
    if(!inventory||!JSON.parse(inventory.inventory_json).nodes.some((n:any)=>n.ip===args.ip&&n.readAuthorized&&!input.task.design?.browserPatrol?.excludedNodeIds?.includes(n.nodeId)))throw Error('proxy-target-not-in-inventory')
    if(action==='repair'&&(input.card.role!=='proxy'||input.profileId!==policy.agentId||item?.action!=='repair'))throw Error('proxy-repair-not-in-frozen-plan')
    if(input.card.role==='proxy'&&!item)throw Error('proxy-target-not-in-frozen-plan')
    let row=db.prepare('SELECT * FROM dsh_proxy_calls WHERE request_id=?').get(requestId) as any
    if(row&&(row.ip!==args.ip||row.action!==action))throw Error('proxy-request-id-conflict')
    if(!row)this.store.kernel.compose(()=>{
      if(db.prepare("SELECT 1 FROM dsh_proxy_calls WHERE ip=? AND state IN ('running','unknown')").get(args.ip))throw Error('proxy-node-busy-or-unknown')
      let issue:any
      if(action==='repair'){
        db.prepare("INSERT OR IGNORE INTO dsh_proxy_issues(spec_id,ip,state) VALUES (?,?,'open')").run(input.task.id,args.ip)
        issue=db.prepare("SELECT * FROM dsh_proxy_issues WHERE spec_id=? AND ip=? AND state='open'").get(input.task.id,args.ip)
        if(issue.attempts>=policy.maxAttempts)throw Error('proxy-repair-budget-exhausted')
        db.prepare('UPDATE dsh_proxy_issues SET attempts=attempts+1 WHERE id=?').run(issue.id)
      }
      db.prepare("INSERT INTO dsh_proxy_calls VALUES (?,?,?,?,?,?,?,?,NULL,'running',NULL,?,?)").run(requestId,input.task.id,input.batch.id,input.card.id,input.sessionId,args.ip,action,issue?.id??null,now,now)
      row=db.prepare('SELECT * FROM dsh_proxy_calls WHERE request_id=?').get(requestId)
      this.store.kernel.recordEvent(input.card.id,'proxy_operation',{requestId,ip:args.ip,action,state:'requested'})
    })
    try{
      const value=await invoke({...args,requestId});const result=decoded(value)
      if(result?.operationId&&result.ip===args.ip&&result.action===action){
        db.prepare('UPDATE dsh_proxy_calls SET operation_id=? WHERE request_id=?').run(result.operationId,requestId)
        this.observe(input,{...row,operation_id:result.operationId},result)
      }else if(result?.ok===false&&['proxy-scope-denied','proxy-node-busy-or-unknown','request-id-conflict','invalid-proxy-arguments'].includes(result.reason)){
        db.prepare("UPDATE dsh_proxy_calls SET state='blocked',updated_at=? WHERE request_id=?").run(now,requestId)
      }else db.prepare("UPDATE dsh_proxy_calls SET state='unknown',updated_at=? WHERE request_id=?").run(now,requestId)
      return value
    }catch(e){
      let denied=false
      try{const r=JSON.parse(e instanceof Error?e.message:'');denied=r.ok===false&&['proxy-scope-denied','proxy-node-busy-or-unknown','request-id-conflict','invalid-proxy-arguments'].includes(r.reason)}catch{}
      db.prepare('UPDATE dsh_proxy_calls SET state=?,updated_at=? WHERE request_id=?').run(denied?'blocked':'unknown',now,requestId);throw e
    }
  }
  private observe(input:CompletionCheck,row:any,value:any){
    if(!value||value.operationId!==row.operation_id||value.ip!==row.ip||value.action!==row.action||Date.parse(value.startedAt)<Date.parse(row.created_at)-1000)return
    const db=this.db(),state=['running','unknown','blocked','succeeded'].includes(value.state)?value.state:'unknown'
    const at=new Date().toISOString(),accepted=validProxyProof(value,input.task.design!.proxy!.lineId,input.batch.firedAt)
    const checked=accepted?new Date(value.result.evidence.verifiedAt).toISOString():at
    this.store.kernel.compose(()=>{
      db.prepare('UPDATE dsh_proxy_calls SET state=?,result_json=?,updated_at=? WHERE request_id=?').run(state,JSON.stringify(value),at,row.request_id)
      if(state!==row.state)this.store.kernel.recordEvent(input.card.id,'proxy_operation',{operationId:row.operation_id,ip:row.ip,action:row.action,state,reason:value.result?.reason??null})
      if(state==='succeeded'||state==='blocked'||state==='unknown'){
        db.prepare('INSERT INTO dsh_proxy_checks VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET checked_at=excluded.checked_at,accepted=excluded.accepted,result_json=excluded.result_json').run(row.operation_id,input.batch.id,input.card.id,row.session_id,input.card.role??'',row.ip,checked,Number(accepted),JSON.stringify(value))
        if(accepted&&input.card.role==='reviewer')db.prepare("UPDATE dsh_proxy_issues SET state='resolved' WHERE spec_id=? AND ip=? AND state='open'").run(input.task.id,row.ip)
      }
      if(state!==row.state)this.store.kernel.recordEvent(input.card.id,'proxy_snapshot',this.status(input))
    })
  }
  /** Read local operation ownership only; never SSH/poll the remote from the host. */
  pending(input:CompletionCheck){
    if(!input.task.design?.proxy)return undefined
    const rows=this.db().prepare("SELECT operation_id FROM dsh_proxy_calls WHERE session_id=? AND state='running'").all(input.sessionId) as any[]
    if(!rows.length)return undefined
    let local:Database.Database|undefined
    try{
      local=new Database(join(process.env.DSH_PROXY_STATE_DIR??join(homedir(),'.local/state/dsh-proxy'),'proxy.db'),{readonly:true,fileMustExist:true})
      for(const row of rows){const operation=local.prepare('SELECT state,updated_at FROM proxy_operations WHERE id=?').get(row.operation_id) as any
        if(operation?.state==='running'&&Date.now()-Date.parse(operation.updated_at)<180_000)return '代理操作仍运行；查询同一个 proxy_status，不能提前结束或换编号重试'}
    }catch{/* Missing local state cannot be proof of a completed proxy operation. */}finally{local?.close()}
    return undefined
  }
}
