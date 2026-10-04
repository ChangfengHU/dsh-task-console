/** New contract: trusted verifier + independent sessions, not independent programs. */
import {createHash,randomUUID} from 'node:crypto'
import {open,realpath,mkdir,readFile,writeFile} from 'node:fs/promises'
import {constants} from 'node:fs'
import {resolve,relative,sep} from 'node:path'
import type {WorkflowExtension,WorkflowEvidencePort,WorkflowReceipt} from './workflow-extensions.js'
import type {CompletionCheck} from './runner.js'
import {verifyArchive,VERIFIER_SHA256} from './release-audit-verifier.js'
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex')
const HASH=/^[a-f0-9]{64}$/
function policy(value:any){
 if(!value||typeof value!=='object'||Object.keys(value).some(k=>!['archive','archiveSha256','commit'].includes(k))||value.archive!=='candidate.tgz'||!HASH.test(value.archiveSha256??'')||!/^[a-f0-9]{40}$/.test(value.commit??''))throw Error('release-audit-policy-invalid')
 return {archive:value.archive,archiveSha256:value.archiveSha256,commit:value.commit}
}
async function frozenBytes(input:CompletionCheck){
 const p=policy(input.task.design!.extension!.policy),root=await realpath(input.task.cwd),path=resolve(root,p.archive)
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
 try{const s=await file.stat();if(!s.isFile()||s.size>32*1024*1024)throw Error('release-audit-input-size');const bytes=await file.readFile();if(digest(bytes)!==p.archiveSha256)throw Error('release-audit-frozen-input-changed');return bytes}finally{await file.close()}
}
function own(host:WorkflowEvidencePort,kind:string){return host.receipts('run').filter(r=>r.kind===kind).at(-1)}
function reportAt(host:WorkflowEvidencePort,round:number,role:string){return host.receipts('batch').filter(r=>r.kind==='report'&&r.round===round&&r.role===role).at(-1)}
function recorded(host:WorkflowEvidencePort,r:WorkflowReceipt){
 const artifacts=host.artifacts()
 if(!r.data.files?.every((file:any)=>artifacts.some(a=>a.sessionId===r.sessionId&&a.runId===r.runId&&a.originalPath===file.path&&a.sha256===file.sha256)))throw Error('release-audit-upstream-artifacts-not-registered')
}
async function reportBytes(input:CompletionCheck,r:WorkflowReceipt){
 const root=await realpath(input.task.cwd)
 for(const file of r.data.files??[]){
  const path=await realpath(file.path),rel=relative(root,path)
  if(!rel||rel.startsWith('..'+sep)||rel==='..'||digest(await readFile(path))!==file.sha256)throw Error('release-audit-report-bytes-changed')
 }
}
function port(host?:WorkflowEvidencePort){if(!host)throw Error('release-audit-host-evidence-required');host.assertActive();return host}
const extension:WorkflowExtension={
 id:'release-audit',version:'1.0.0',hostApi:2,implementationSha256:'0'.repeat(64),toolAccess:'scoped-only',validatePolicy:policy,
 beforeStart:async(input,host)=>{port(host);await frozenBytes(input);port(host)},
 beforePlanRound:async(input,_items,_proxy,host)=>{port(host);if(input.card.role!=='planner')throw Error('release-audit-planner-required');return undefined},
 registerTools:async(ctx,input,host)=>{
  const disposers:(()=>void)[]=[]
  const add=(name:string,description:string,parameters:any,execute:(a:any)=>Promise<any>)=>disposers.push(ctx.tools.register({name:'release_audit_'+name,description,parameters,output:{schema:{type:'object',additionalProperties:true},render:(_:any,v:any)=>[{type:'text',text:JSON.stringify(v)}]},execute}))
  const view=(r:WorkflowReceipt)=>({id:r.id,kind:r.kind,role:r.role,round:r.round,sessionId:r.sessionId,data:r.data})
  add('status','Read frozen input policy and actual evidence in this batch. No package contents, shell, model-authored receipts or approval. Workers call verify then report then task_complete with returned artifact paths; planner starts task_plan_round and later task_finalize only after independently checked reports.',{},async()=>({policy:policy(input.task.design!.extension!.policy),role:input.card.role,round:input.card.round,contract:'trusted-verifier-independent-sessions-v1',scope:'byte-integrity-only',evidence:host.receipts('batch').map(view)}))
  if(['executor','reviewer'].includes(input.card.role??'')){
   add('verify','Recompute frozen archive and every member using the trusted read-only verifier in YOUR current run. Never executes or extracts archive code. Returns actual bounded facts and host receipt; does not itself complete the task.',{},async()=>{
    const bytes=await frozenBytes(input);host.assertActive();const p=policy(input.task.design!.extension!.policy)
    const facts=await verifyArchive(bytes,p.archiveSha256,p.commit);host.assertActive()
    const receipt=host.commit('verification',{verifierSha256:VERIFIER_SHA256,facts,factsSha256:digest(JSON.stringify(facts))})
    return view(receipt)
   })
   add('report','Submit your interpretation of YOUR current-run verification. Reviewer must cite the exact registered executor reportId after comparing facts. Host saves machine facts and your report to fixed private files; use returned artifacts in task_complete. Wrong conclusions or unverified upstream references are rejected.',{
    receiptId:{type:'string',required:true},conclusion:{type:'string',enum:['pass','fail'],required:true},summary:{type:'string',required:true},findings:{type:'array',items:{type:'string'},required:true},upstreamReportId:{type:'string'},
   },async args=>{
    const proof=own(host,'verification')
    if(!proof||proof.id!==args.receiptId)throw Error('release-audit-own-verification-required')
    if(args.conclusion!==proof.data.facts.status)throw Error('release-audit-conclusion-disagrees-with-facts')
    if(typeof args.summary!=='string'||args.summary.trim().length<10||args.summary.length>2000||!Array.isArray(args.findings)||args.findings.length>20||args.findings.some((x:any)=>typeof x!=='string'||x.length>500))throw Error('release-audit-report-schema')
    let upstream:WorkflowReceipt|undefined
    if(input.card.role==='reviewer'){
     upstream=reportAt(host,input.card.round??1,'executor')
     if(!upstream||upstream.id!==args.upstreamReportId||upstream.sessionId===input.sessionId)throw Error('release-audit-independent-upstream-required')
     recorded(host,upstream);await reportBytes(input,upstream)
     if(upstream.data.factsSha256!==proof.data.factsSha256)throw Error('release-audit-independent-facts-disagree')
    }else if(args.upstreamReportId)throw Error('release-audit-executor-cannot-claim-upstream')
    const requestSha256=digest(JSON.stringify({proofId:proof.id,conclusion:args.conclusion,summary:args.summary.trim(),findings:args.findings,upstreamReportId:upstream?.id??null}))
    const previous=host.receipts('run').find(r=>r.kind==='report'&&r.data.requestSha256===requestSha256)
    if(previous){await reportBytes(input,previous);return {report:view(previous),artifacts:previous.data.files.map((f:any)=>f.path)}}
    const root=await realpath(input.task.cwd),dir=resolve(root,'reports',randomUUID())
    await mkdir(dir,{recursive:true,mode:0o700})
    if(await realpath(dir)!==dir)throw Error('release-audit-report-directory-invalid')
    const body={schema:'release-audit-report-v1',contract:'trusted-verifier-independent-sessions-v1',scope:'byte-integrity-only',receiptId:proof.id,sessionId:input.sessionId,role:input.card.role,round:input.card.round,conclusion:args.conclusion,summary:args.summary.trim(),findings:args.findings,...(upstream?{upstreamReportId:upstream.id}:{}),verifierSha256:VERIFIER_SHA256,facts:proof.data.facts}
    const files=[]
    for(const [name,text] of [['report.json',JSON.stringify(body,null,2)+'\n'],['REPORT.md',`# Release package integrity\n\n${body.summary}\n\nResult: ${body.conclusion}\n\n${body.findings.map((x:string)=>'- '+x).join('\n')}\n\nScope: byte integrity only. This does not verify functionality, installation, licenses, runtime security, or media quality.\n\nVerification receipt: ${proof.id}\n`]]){
     host.assertActive();const path=resolve(dir,name);await writeFile(path,text,{flag:'wx',mode:0o600});files.push({path,sha256:digest(text)})
    }
    host.assertActive();const report=host.commit('report',{requestSha256,proofId:proof.id,factsSha256:proof.data.factsSha256,conclusion:args.conclusion,summary:body.summary,findings:body.findings,...(upstream?{upstreamReportId:upstream.id}:{}),files})
    return {report:view(report),artifacts:files.map(f=>f.path)}
   })
  }
  return ()=>disposers.forEach(d=>d())
 },
 beforeComplete:async(input,maybeHost)=>{
  const host=port(maybeHost);await frozenBytes(input);host.assertActive()
  if(input.card.role==='planner'){
   const round=(input.card.round??1)-1,a=reportAt(host,round,'executor'),b=reportAt(host,round,'reviewer')
   if(!a||!b||a.sessionId===b.sessionId||b.data.upstreamReportId!==a.id||a.data.conclusion!=='pass'||b.data.conclusion!=='pass'||a.data.factsSha256!==b.data.factsSha256)throw Error('release-audit-independent-passing-reports-required')
   if(!input.finalArtifactPath||!a.data.files.some((f:any)=>f.path.endsWith('/REPORT.md')&&f.path===resolve(input.task.cwd,input.finalArtifactPath!)))throw Error('release-audit-final-artifact-must-be-current-executor-report')
   recorded(host,a);recorded(host,b);await reportBytes(input,a);await reportBytes(input,b);host.assertActive()
   return {summary:'Frozen release package byte integrity verified by two separate role sessions using the pinned host verifier. Reports and exact artifacts verified; no functional or media quality claim.',metadata:{workflowOutcome:'passed',contract:'trusted-verifier-independent-sessions-v1',executorReport:a.id,reviewerReport:b.id,scope:'byte-integrity-only'}}
  }
  const report=own(host,'report'),proof=own(host,'verification')
  if(!report||!proof||report.data.proofId!==proof.id)throw Error('release-audit-current-run-report-required')
  const files=report.data.files as {path:string;sha256:string}[]
  if(input.artifactPaths?.length!==files.length||files.some(f=>!input.artifactPaths?.some(p=>resolve(input.task.cwd,p)===f.path)))throw Error('release-audit-required-report-artifacts')
  await reportBytes(input,report);host.assertActive()
  return {summary:`${input.card.role} completed byte-integrity verification and registered report; conclusion=${report.data.conclusion}. Independent final acceptance is separate.`,metadata:{workflowOutcome:report.data.conclusion==='pass'?'verified':'needs_changes',reportId:report.id,verificationId:proof.id,scope:'byte-integrity-only'},artifacts:files}
 },
}
export default extension
