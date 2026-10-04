import { PluginPublisher } from './plugin-publisher.ts'

export const name='task-console-plugin-publisher-tools'
export const inject=['tools']
export async function registerPluginPublisher(ctx:any,adapter:Pick<PluginPublisher,'start'|'status'>,readOnly=false){
 const defineTool=process.env.NODE_ENV==='test'?(value:any)=>value:(await import('@deepseek-ai/dsh-tools')).defineTool
 const disposers=[]
 for(const operation of readOnly?['status']:['start','status']){
  const tool=defineTool({
   name:operation==='start'?'fleet_plugin_publish':'fleet_plugin_publish_status',
   description:operation==='start'?'发布管理员已在 Fleet 批准的不可变插件版本包。只接受 releaseId；保留原插件与授权范围。running 时持续调用 status，超时未知结果不可声称成功。':'读取 Fleet 插件发布状态。仅 verified 表示官方更新并回读完成；不是 MCP 业务调用验收。',
   parameters:{releaseId:{type:'string',required:true,description:'Fleet Task Signal 目标中的版本记录 UUID。'}},
   output:{schema:{type:'object',additionalProperties:true},render:(_args:unknown,result:unknown)=>[{type:'text',text:JSON.stringify(result)}]},
   async execute(args:any){
    if(!args||Object.keys(args).some(k=>k!=='releaseId')||!/^[a-f0-9-]{36}$/.test(args.releaseId||''))throw Error('invalid_release')
    if(operation==='status')await new Promise(r=>setTimeout(r,process.env.NODE_ENV==='test'?0:4000))
    return operation==='start'?adapter.start(args.releaseId):adapter.status(args.releaseId)
   },
  })
  if(tool.parameters.type==='object')tool.parameters={...tool.parameters,additionalProperties:false}
  else tool.parameters={type:'object',properties:tool.parameters,required:['releaseId'],additionalProperties:false}
  disposers.push(ctx.tools.register(tool))
 }
 return ()=>disposers.reverse().forEach(fn=>fn())
}
export async function apply(ctx:any,config:{readOnly?:boolean}={}){
 const dispose=await registerPluginPublisher(ctx,new PluginPublisher({token:process.env.DSH_TASK_INTAKE_TOKEN||''}),config.readOnly===true)
 ctx.effect(()=>dispose)
}
