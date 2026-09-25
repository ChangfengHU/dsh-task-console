import {studioStageFor} from './studio-stages.js'

/** Ownership comes from the persisted operation kind, never its tool spelling.
 * Missing/invalid legacy kinds remain unresolved for every consumer. */
export function studioOperationInStage(input:any,operation:{kind?:unknown}):boolean {
 const stage=studioStageFor(input)
 if(!stage||!['imageCalls','voiceSegments'].includes(String(operation.kind)))return true
 return stage.id==='visual'?operation.kind==='imageCalls':stage.id==='sound'?operation.kind==='voiceSegments':false
}

/** Parallel specialists wait for their own media jobs, not the sibling stage. */
export function requireSettledStudioOperations(input:any,snapshot:any):void {
 const stage=studioStageFor(input)
 const pending=snapshot.operations.filter((op:any)=>
  studioOperationInStage(input,op)&&['dispatching','unknown','submitted'].includes(op.state))
 if(pending.length)throw Error('studio-generation-reconcile-required: '+JSON.stringify({
  error_code:'studio-generation-reconcile-required',stage:stage?.id??input.card.role,
  operations:pending.map((op:any)=>({tool:op.tool,state:op.state,jobId:op.job_id??null})),
  action:'Query original jobs and reconcile their terminal outcomes before handoff. Do not resubmit or cancel a sibling stage.',
 }))
}
