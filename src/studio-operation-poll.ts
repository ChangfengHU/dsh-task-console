import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
/** Fixed read-only provider calls. Transport and authentication are host-owned. */
export async function pollStudioOperation(config:any,operation:any){
 if(config?.transport!=='streamable-http'||typeof config.url!=='string')throw Error('studio-operation-poll-http-transport-required')
 if(typeof operation.job_id!=='string'||!operation.job_id||operation.job_id.length>200)throw Error('studio-operation-poll-job-required')
 const image=/vyibc-image_generate_image$/.test(operation.tool),voice=/vyibc-voice_(synthesize|retry_segments)$/.test(operation.tool)
 if(!image&&!voice)throw Error('studio-operation-poll-provider-unsupported')
 const name=image?'vyibc-image_get_task':'vyibc-voice_status',args=image?{taskId:operation.job_id}:{job_id:operation.job_id}
 const client=new Client({name:'dsh-studio-operation-reconciliation',version:'1.0.0'},{capabilities:{}})
 const transport=new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.headers}})
 try{await client.connect(transport,{timeout:15000});return {name,args,result:await client.callTool({name,arguments:args},undefined,{timeout:15000})}}
 catch{throw Error('studio-operation-poll-unavailable')}
 finally{await client.close().catch(()=>{});await transport.close().catch(()=>{})}
}
