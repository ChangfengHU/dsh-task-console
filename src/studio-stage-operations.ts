import {studioStageFor} from './studio-stages.js'

/** Parallel specialists wait for their own media jobs, not the sibling stage. */
export function requireSettledStudioOperations(input:any,snapshot:any):void {
 const stage=studioStageFor(input)
 const kind=stage?.id==='visual'?'imageCalls':stage?.id==='sound'?'voiceSegments':undefined
 const pending=snapshot.operations.filter((op:any)=>
  (!stage||!!kind&&op.kind===kind)&&['dispatching','unknown','submitted'].includes(op.state))
 if(pending.length)throw Error('studio-generation-reconcile-required: '+JSON.stringify({
  error_code:'studio-generation-reconcile-required',stage:stage?.id??input.card.role,
  operations:pending.map((op:any)=>({tool:op.tool,state:op.state,jobId:op.job_id??null})),
  action:'Query original jobs and reconcile their terminal outcomes before handoff. Do not resubmit or cancel a sibling stage.',
 }))
}
