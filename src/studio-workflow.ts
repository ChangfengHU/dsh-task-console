import {createHash,randomUUID} from 'node:crypto'
import {validateStudioPolicy} from './studio-policy.js'
import {evaluateStudioReview} from './studio-evidence.mjs'

const NAMES=['frames','audio','audio_calibration','render','character','reference'] as const
const HASH=/^[a-f0-9]{64}$/i
const safeReason=(value:unknown)=>typeof value==='string'?value.replace(/https?:\/\/[^\s]+/g,'[url]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/(?:token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,'[credential redacted]').replace(/[A-Za-z0-9_+/=-]{32,}/g,'[opaque]').replace(/[\r\n\t]/g,' ').slice(0,160):undefined
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
const strict=(v:any,keys:string[],label:string)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw Error(`studio-${label}-schema`)}
export interface StudioCapability {name:typeof NAMES[number];status:'passed'|'failed'|'access_denied'|'unknown';proofSha256?:string;checkedAt:string;expiresAt:string;reason?:string;method?:string}
/** Host-only ledger, not an OS security boundary: same-UID unrestricted shell can tamper with SQLite. */
export class StudioWorkflow {
  private db:any
  constructor(private store:any){
    this.db=store.kernel.db
    this.db.exec(`CREATE TABLE IF NOT EXISTS dsh_studio_capabilities(task_id TEXT,name TEXT,policy_hash TEXT,payload TEXT,PRIMARY KEY(task_id,name));
CREATE TABLE IF NOT EXISTS dsh_studio_preflight(task_id TEXT PRIMARY KEY,policy_hash TEXT,payload TEXT);
CREATE TABLE IF NOT EXISTS dsh_studio_state(task_id TEXT,batch_id TEXT,kind TEXT,payload TEXT,PRIMARY KEY(task_id,batch_id,kind));
CREATE TABLE IF NOT EXISTS dsh_studio_receipts(id TEXT PRIMARY KEY,task_id TEXT,batch_id TEXT,session_id TEXT,candidate_sha256 TEXT,policy_hash TEXT,payload TEXT);`)
  }
  private policy(task:any){if(task?.design?.evidenceContract!=='studio-video-v1')throw Error('studio-contract-required');if(typeof task.id!=='string'||!task.id)throw Error('studio-task-id-required');return validateStudioPolicy(task.design.studio)}
  private key(input:any){this.policy(input.task);if(!input.batch?.id||!input.sessionId)throw Error('studio-live-context-required');return [input.task.id,input.batch.id]}
  private write(input:any,kind:string,value:any){const [task,batch]=this.key(input);this.db.prepare('INSERT INTO dsh_studio_state VALUES(?,?,?,?) ON CONFLICT(task_id,batch_id,kind) DO UPDATE SET payload=excluded.payload').run(task,batch,kind,JSON.stringify(value))}
  private read(input:any,kind:string){const [task,batch]=this.key(input);const r=this.db.prepare('SELECT payload FROM dsh_studio_state WHERE task_id=? AND batch_id=? AND kind=?').get(task,batch,kind);return r?JSON.parse(r.payload):undefined}
  stageReceipt(input:any,id:string){return this.read(input,`stage:${input.card.round}:${id}`)}
  recordStageReceipt(input:any,value:any){this.write(input,`stage:${input.card.round}:${value.stage}`,value)}
  recordCapability(task:any,value:StudioCapability){
    const policy=this.policy(task);strict(value,['name','status','proofSha256','checkedAt','expiresAt','reason','method'],'capability')
    if(!NAMES.includes(value.name)||!['passed','failed','access_denied','unknown'].includes(value.status))throw Error('studio-capability-status')
    const start=Date.parse(value.checkedAt),end=Date.parse(value.expiresAt)
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||start>Date.now()+1000)throw Error('studio-capability-time')
    if(value.status==='passed'&&(!HASH.test(value.proofSha256??'')||(value.reason&&/access.denied|forbidden|permission.denied|\b403\b/i.test(value.reason))))throw Error('studio-capability-invalid-pass')
    if(value.status==='passed'&&['audio','audio_calibration'].includes(value.name)&&value.method!=='actual_audio')throw Error('studio-actual-audio-proof-required')
    this.db.prepare('INSERT INTO dsh_studio_capabilities VALUES(?,?,?,?) ON CONFLICT(task_id,name) DO UPDATE SET policy_hash=excluded.policy_hash,payload=excluded.payload').run(task.id,value.name,sha(policy),JSON.stringify(value))
    this.db.prepare('DELETE FROM dsh_studio_preflight WHERE task_id=?').run(task.id)
  }
  preflight(task:any){
    const policy=this.policy(task),ph=sha(policy),now=Date.now()
    const rows=this.db.prepare('SELECT * FROM dsh_studio_capabilities WHERE task_id=?').all(task.id)
    const checks=NAMES.map(name=>{const r=rows.find((r:any)=>r.name===name),p=r?JSON.parse(r.payload):undefined;return {name,ok:!!p&&r.policy_hash===ph&&p.status==='passed'&&Date.parse(p.expiresAt)>now,status:!p?'missing':r.policy_hash!==ph?'policy_mismatch':Date.parse(p.expiresAt)<=now?'expired':p.status,...(p?{proofSha256:p.proofSha256,method:p.method,reason:safeReason(p.reason)}:{})}})
    const ok=checks.every(c=>c.ok),result={ok,status:ok?'ready':'blocked_quality_capability',...(ok?{}:{reason:`blocked_quality_capability: ${checks.filter(c=>!c.ok).map(c=>`${c.name}=${c.status}${c.reason?` (${c.reason})`:''}`).join('; ')}`}),checks}
    this.db.prepare('INSERT INTO dsh_studio_preflight VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET policy_hash=excluded.policy_hash,payload=excluded.payload').run(task.id,ph,JSON.stringify(result))
    return result
  }
  private requirePreflight(task:any){const row=this.db.prepare('SELECT * FROM dsh_studio_preflight WHERE task_id=?').get(task.id);if(!row||row.policy_hash!==sha(this.policy(task)))throw Error('blocked_quality_capability: studio-preflight-required');const current=this.preflight(task);if(!current.ok)throw Error(`blocked_quality_capability: ${current.reason}`)}
  plan(input:any){this.key(input);if(input.card?.role!=='planner')throw Error('studio-planner-required');this.requirePreflight(input.task);if(this.read(input,'runtime_enforcement')===true){const refs=(this.read(input,'reference_receipts')??[]).filter((r:any)=>r.sessionId===input.sessionId);if(!this.script(input)||!refs.some((r:any)=>r.kind==='frames')||!refs.some((r:any)=>r.kind==='audio'))throw Error('studio-plan-requires-script-and-direct-reference')}return {ok:true,status:'ready' as const}}
  recordCandidate(input:any,candidate:any){
    if(input.card?.role!=='executor')throw Error('studio-producer-required')
    strict(candidate,['sha256','manifestSha256','referenceSha256','revision','durationSeconds','width','height','fps'],'candidate')
    if(!HASH.test(candidate.sha256??'')||!HASH.test(candidate.manifestSha256??'')||!Number.isInteger(candidate.revision)||candidate.revision<1)throw Error('studio-candidate-invalid')
    const previous=this.read(input,'candidate');if(previous&&(candidate.revision<=previous.candidate.revision))throw Error('studio-candidate-revision-must-increase')
    this.write(input,'candidate',{candidate,producerSessionId:input.sessionId,policyHash:sha(this.policy(input.task))})
  }
  recordReceipt(input:any,receipt:any){
    if(input.card?.role!=='reviewer')throw Error('studio-reviewer-required')
    strict(receipt,['candidateSha256','kind','ranges','sha256'],'receipt')
    const current=this.read(input,'candidate');if(!current||receipt.candidateSha256!==current.candidate.sha256||!HASH.test(receipt.sha256??'')||!['frames','audio','probe','source'].includes(receipt.kind))throw Error('studio-receipt-invalid')
    if(!Array.isArray(receipt.ranges)||!receipt.ranges.length||receipt.ranges.some((r:any)=>!Array.isArray(r)||r.length!==2||!Number.isFinite(r[0])||!Number.isFinite(r[1])||r[0]<0||r[1]<=r[0]||r[1]>current.candidate.durationSeconds))throw Error('studio-receipt-ranges')
    const id=randomUUID(),stored={...receipt,id,sessionId:input.sessionId};const [task,batch]=this.key(input)
    this.db.prepare('INSERT INTO dsh_studio_receipts VALUES(?,?,?,?,?,?,?)').run(id,task,batch,input.sessionId,receipt.candidateSha256,sha(this.policy(input.task)),JSON.stringify(stored));return stored
  }
  recordReview(input:any,review:any){
    if(input.card?.role!=='reviewer')throw Error('studio-reviewer-required')
    strict(review,['candidateSha256','referenceSha256','revision','checks','issues'],'review')
    this.write(input,'review',{...review,reviewerSessionId:input.sessionId})
  }
  recordBudget(input:any,budget:any){strict(budget,['repairRounds','used','limits','exceeded','maxRepairRounds'],'budget');this.write(input,'budget',budget)}
  recordSkillLoad(input:any,receipt:any){
    if(input.card?.role!=='executor'||!HASH.test(receipt.sha256??'')||typeof receipt.name!=='string'||typeof receipt.callId!=='string'||!Number.isInteger(receipt.bytes)||receipt.bytes<1)throw Error('studio-skill-load-invalid')
    const rows=(this.read(input,'skill_loads')??[]).filter((r:any)=>r.sessionId!==input.sessionId||r.name!==receipt.name)
    this.write(input,'skill_loads',[...rows,{...receipt,sessionId:input.sessionId,policyHash:sha(this.policy(input.task)),at:new Date().toISOString()}])
  }
  recordIntervention(input:any,reason:string){if(typeof reason!=='string'||!reason.trim())throw Error('studio-intervention-reason');this.write(input,'interventions',[...(this.read(input,'interventions')??[]),{reason,at:new Date().toISOString()}])}
  status(input:any){
    this.key(input)
    const current=this.read(input,'candidate'),ph=sha(this.policy(input.task))
    return {...(input.task.design?.studioStages?{stages:input.task.design.studioStages.map((s:any)=>({id:s.id,agentId:s.agentId,receipt:this.stageReceipt(input,s.id)??null}))}:{}),candidate:current?.policyHash===ph?current.candidate:null,review:current?.policyHash===ph?(this.read(input,'review')??null):null,budget:this.read(input,'budget')??null,interventions:this.read(input,'interventions')??[],preflight:this.preflight(input.task),script:this.script(input),speechPlan:this.speechPlan(input),speechChecks:this.read(input,'speech_checks')??[],referenceReceipts:this.read(input,'reference_receipts')??[],skillLoads:this.read(input,'skill_loads')??[]}
  }
  recordCandidateLocation(input:any,location:{path:string;manifestPath:string;sha256:string}){
    if(input.card?.role!=='executor')throw Error('studio-producer-required')
    strict(location,['path','manifestPath','sha256'],'candidate-location')
    const current=this.read(input,'candidate'),ph=sha(this.policy(input.task))
    if(!current||current.policyHash!==ph||current.producerSessionId!==input.sessionId||location.sha256!==current.candidate.sha256)throw Error('studio-candidate-location-mismatch')
    if(typeof location.path!=='string'||!location.path.startsWith('/')||location.path.includes('\0')||typeof location.manifestPath!=='string'||!location.manifestPath.startsWith('/')||location.manifestPath.includes('\0'))throw Error('studio-candidate-location-path')
    this.write(input,'candidate_location',{...location,policyHash:ph})
  }
  candidateLocation(input:any){
    const current=this.read(input,'candidate'),location=this.read(input,'candidate_location'),ph=sha(this.policy(input.task))
    if(!current||!location||current.policyHash!==ph||location.policyHash!==ph||location.sha256!==current.candidate.sha256)throw Error('studio-candidate-location-mismatch')
    return {path:location.path,manifestPath:location.manifestPath,sha256:location.sha256}
  }
  enforceRuntime(input:any){this.write(input,'runtime_enforcement',true)}
  recordReferenceReceipt(input:any,receipt:any){
    this.key(input);const policy=this.policy(input.task)
    if(!['planner','executor','reviewer','studio-stage'].includes(input.card?.role)||receipt.referenceSha256!==policy.referenceSha256||!HASH.test(receipt.sha256??'')||!['frames','audio','image'].includes(receipt.kind))throw Error('studio-reference-receipt-invalid')
    const stored={...receipt,id:randomUUID(),sessionId:input.sessionId,role:input.card.role,policyHash:sha(policy)}
    this.write(input,'reference_receipts',[...(this.read(input,'reference_receipts')??[]),stored]);return stored
  }
  script(input:any){return this.read(input,'script')??null}
  recordScript(input:any,value:any){
    if(input.card?.role!=='planner'||!HASH.test(value.sha256??'')||!Array.isArray(value.lines)||!value.lines.length||value.lines.length>80)throw Error('studio-script-invalid')
    const ids=new Set();for(const line of value.lines){if(typeof line.id!=='string'||!line.id||ids.has(line.id)||typeof line.text!=='string'||!line.text.trim()||line.text.length>300)throw Error('studio-script-lines-invalid');ids.add(line.id)}
    const previous=this.script(input),review=this.read(input,'review'),candidate=this.read(input,'candidate')?.candidate
    if(previous&&previous.sha256!==value.sha256&&(!review||review.candidateSha256!==candidate?.sha256||!review.issues?.some((i:any)=>['major','blocker'].includes(i.severity))))throw Error('studio-script-change-requires-independent-review')
    this.write(input,'script',value)
  }
  speechPlan(input:any){const plan=this.read(input,'speech_plan'),current=this.read(input,'candidate');return plan&&plan.candidateSha256===current?.candidate.sha256&&plan.scriptSha256===this.script(input)?.sha256?plan:null}
  recordSpeechPlan(input:any,plan:any){
    if(input.card?.role!=='executor')throw Error('studio-producer-required')
    const candidate=this.read(input,'candidate')?.candidate,script=this.script(input)
    if(!candidate||!script||plan.candidateSha256!==candidate.sha256||plan.scriptSha256!==script.sha256||!HASH.test(plan.planSha256??'')||!Array.isArray(plan.lines)||plan.lines.length!==script.lines.length)throw Error('studio-speech-plan-invalid')
    const seen=new Set();for(const line of plan.lines){const original=script.lines.find((x:any)=>x.id===line.id);if(!original||original.text!==line.text||seen.has(line.id))throw Error('studio-speech-plan-script-mismatch');seen.add(line.id)}
    this.write(input,'speech_plan',plan);this.write(input,'speech_checks',[])
  }
  recordSpeechCheck(input:any,value:any){
    if(input.card?.role!=='reviewer')throw Error('studio-reviewer-required')
    const plan=this.speechPlan(input),line=plan?.lines.find((x:any)=>x.id===value.lineId)
    if(!plan||!line||value.candidateSha256!==plan.candidateSha256||value.planSha256!==plan.planSha256||!['source','final'].includes(value.stage)||!HASH.test(value.audioSha256??'')||value.result?.audio_sha256!==value.audioSha256)throw Error('studio-speech-check-invalid')
    const stored={...value,sessionId:input.sessionId};const checks=(this.read(input,'speech_checks')??[]).filter((x:any)=>!(x.lineId===value.lineId&&x.stage===value.stage&&x.sessionId===input.sessionId));this.write(input,'speech_checks',[...checks,stored])
  }
  hasRejection(input:any){
    if(input.card?.role!=='reviewer')return false
    const review=this.read(input,'review'),candidate=this.read(input,'candidate')?.candidate
    return !!review&&review.reviewerSessionId===input.sessionId&&review.candidateSha256===candidate?.sha256&&review.checks?.some((c:any)=>c.status==='fail')&&review.issues?.some((i:any)=>['major','blocker'].includes(i.severity)&&['open','pending'].includes(i.status))
  }
  complete(input:any){
    this.key(input)
    // A grounded rejection can be handed back during an unrelated dependency
    // outage. Full evidence validation below still applies; no success shortcut.
    if(!this.hasRejection(input))this.requirePreflight(input.task)
    const saved=this.read(input,'candidate'),review=this.read(input,'review'),budget=this.read(input,'budget')
    const policy=this.policy(input.task),role=input.card?.role
    if(!saved||!budget||saved.policyHash!==sha(policy))throw Error('studio-version-bound-trusted-review-required')
    const base={candidateSha256:saved.candidate.sha256,revision:saved.candidate.revision}
    if(role==='executor'){
      if(this.read(input,'runtime_enforcement')===true&&!this.speechPlan(input))throw Error('studio-speech-plan-required')
      if(saved.producerSessionId!==input.sessionId)throw Error('studio-producer-session-mismatch')
      const validation=evaluateStudioReview({policy,candidate:saved.candidate,review:{},producerSessionId:input.sessionId,reviewerSessionId:'host-review-pending',receipts:[],budget})
      const budgetErrors=validation.issues.filter((x:string)=>x.startsWith('budget:'))
      if(budgetErrors.length)throw Error(`studio-budget-invalid: ${budgetErrors.join('; ')}`)
      return {summary:'Candidate delivered for independent review; quality is not approved.',metadata:{workflowOutcome:'candidate_handoff',...base}}
    }
    if(!['planner','reviewer'].includes(role))throw Error('studio-independent-review-required')
    if(!review)throw Error('studio-version-bound-trusted-review-required')
    if(role==='reviewer'&&review.reviewerSessionId!==input.sessionId)throw Error('studio-review-session-mismatch')
    const receipts=this.db.prepare('SELECT payload FROM dsh_studio_receipts WHERE task_id=? AND batch_id=? AND policy_hash=?').all(input.task.id,input.batch.id,sha(policy)).map((r:any)=>JSON.parse(r.payload))
    const result=evaluateStudioReview({policy,candidate:saved.candidate,review,producerSessionId:saved.producerSessionId,reviewerSessionId:review.reviewerSessionId,receipts,budget,interventions:this.read(input,'interventions')??[]})
    if(role==='reviewer'){
      if(!Array.isArray(review.checks)||review.checks.some((c:any)=>!['pass','fail','pending'].includes(c?.status)))throw Error('studio-review-check-status-invalid')
      // A real, complete negative review must reach the planner. Only integrity failures block handoff.
      // Rejection is not approval: an absent audio stream cannot produce an audio
      // observation. Permit explicitly PENDING dimensions on a grounded rejection,
      // while retaining identity/hash/range checks and every rule for PASS/FAIL.
      const groundedFailure=review.checks.some((c:any)=>c.status==='fail'&&Array.isArray(c.evidenceReceiptIds)&&c.evidenceReceiptIds.length>0&&!result.issues.some((x:string)=>x.startsWith(`check.${c.dimension}: `)&&x!==`check.${c.dimension}: not passed`))
      const rejection=groundedFailure&&review.issues?.some((i:any)=>['blocker','major'].includes(i.severity)&&['open','pending'].includes(i.status))
      const pendingOmission=(x:string)=>rejection&&review.checks.some((c:any)=>c.status==='pending'&&Array.isArray(c.evidenceReceiptIds)&&(
        (c.evidenceReceiptIds.length===0&&x===`check.${c.dimension}: missing or duplicate evidence receipts`)||
        ['audio','frames','probe','source'].some(kind=>x===`check.${c.dimension}: requires ${kind} evidence`)))
      const integrity=result.issues.filter((x:string)=>!pendingOmission(x)&&!/^check\.[^:]+: not passed$/.test(x)&&!/^issue\..+: unresolved (blocker|major|minor|info)$/.test(x)&&!x.startsWith('budget:')&&!x.startsWith('autonomy:')&&!/^candidate: (duration outside policy|width mismatch|height mismatch|fps mismatch)$/.test(x))
      if(integrity.length)throw Error(`studio-review-integrity-failed: ${integrity.join('; ')}`)
      return {summary:result.ok?'Independent review completed; planner must verify final acceptance.':'Independent review found issues; return to planner for repairs.',metadata:{workflowOutcome:result.ok?'review_complete':'review_needs_changes',...base,reviewerSessionId:review.reviewerSessionId,issues:result.issues}}
    }
    if(this.read(input,'runtime_enforcement')===true){
      const audioRanges=receipts.filter((r:any)=>r.sessionId===review.reviewerSessionId&&r.candidateSha256===saved.candidate.sha256&&r.kind==='audio').flatMap((r:any)=>r.ranges).sort((a:any,b:any)=>a[0]-b[0]);let covered=0
      for(const range of audioRanges){if(range[0]>covered+0.04)throw Error('studio-entire-film-audio-review-required');covered=Math.max(covered,range[1])}
      if(covered<saved.candidate.durationSeconds-0.04)throw Error('studio-entire-film-audio-review-required')
      const reference=(this.read(input,'reference_receipts')??[]).filter((r:any)=>r.sessionId===review.reviewerSessionId&&r.referenceSha256===policy.referenceSha256)
      if(!reference.some((r:any)=>r.kind==='frames')||!reference.some((r:any)=>r.kind==='audio'))throw Error('studio-reference-direct-review-required')
      const plan=this.speechPlan(input),checks=this.read(input,'speech_checks')??[]
      if(!plan||plan.lines.some((line:any)=>['source','final'].some(stage=>!checks.some((c:any)=>c.lineId===line.id&&c.stage===stage&&c.sessionId===review.reviewerSessionId&&c.candidateSha256===saved.candidate.sha256&&c.result?.content_gate==='pass'))))throw Error('studio-speech-coverage-not-passed')
    }
    if(!result.ok)throw Error(`studio-quality-gate-failed: ${result.issues.join('; ')}`)
    return {summary:'Machine-assessed candidate; not human aesthetic approval.',metadata:{workflowOutcome:'machine_assessed_candidate',...base,reviewerSessionId:review.reviewerSessionId}}
  }
}
