/** Optional maintenance entrypoint: attaches to the existing runner without replacing it. */
import type {Context} from '@deepseek-ai/cordis'
import {TypertRemoteService} from '@deepseek-ai/dsh-typert-protocol'
import {CONSOLE_INVOCATIONS,PKG} from './wire.js'
import {reconcileStudioImageOperation} from './studio-image-reconciliation.js'

export const name='studio-image-recovery-api'
export const inject=['taskConsole','sessionPersistence','typert']
const namespace='studioRecovery'
const remap=(source:string,method:string)=>{
 const descriptor=CONSOLE_INVOCATIONS.find(d=>d.method===source)!
 return {...descriptor,id:`${PKG}#${namespace}/${method}`,service:namespace,namespace,method}
}
export const RECOVERY_MANIFEST={package:PKG+'-studio-recovery',face:'host',schemas:[],invocations:[remap('catalog','status'),remap('reconcileStudioImageOperation','reconcileImage')],model:{services:[],events:[],objects:[]}}
export class StudioRecoveryService extends TypertRemoteService {
 static inject=['taskConsole','sessionPersistence']
 constructor(ctx:Context){super(ctx,namespace)}
 private owner(){
  const owner=(this.ctx as any).get('taskConsole'),persistence=(this.ctx as any).get('sessionPersistence')
  if(!owner?.runner?.store?.kernel?.db||typeof owner.runner.store.transition!=='function'||typeof persistence?.inspect!=='function')throw Error('studio-recovery-existing-host-required')
  return {owner,persistence}
 }
 async status(){
  const {owner}=this.owner()
  return JSON.stringify({ready:true,scope:'operator-reconciliation-only',sharesExistingRunner:true,startsRunner:false,activeRuns:[...owner.runner.store.s.runs.values()].filter((r:any)=>r.status==='running').length,qualityApproved:false})
 }
 async reconcileImage(payload:string){
  const {owner,persistence}=this.owner()
  return JSON.stringify(await reconcileStudioImageOperation(owner.runner.store,JSON.parse(payload),id=>persistence.inspect(id)))
 }
}
export async function apply(ctx:Context){
 await ctx.plugin(StudioRecoveryService)
 ;(ctx as any).get('typert').register(RECOVERY_MANIFEST)
}
