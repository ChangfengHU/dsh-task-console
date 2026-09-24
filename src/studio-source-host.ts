import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {resolveStudioSources,type StudioSourceTool} from './studio-source-discovery.js'

const READ_TOOLS=['character_search','character_get','character_assets','asset_get'] as const
type Host={serverName:string;live?:boolean;disabled?:boolean;tools?:string[];config:Record<string,unknown>}
type Connection={connect:()=>Promise<void>;call:(name:StudioSourceTool,args:any)=>Promise<any>;close:()=>Promise<void>}
function connection(config:Record<string,any>):Connection{
 if(config.transport!=='streamable-http'||typeof config.url!=='string')throw Error('studio-source-transport-unavailable')
 const client=new Client({name:'dsh-studio-source-discovery',version:'1.0.0'},{capabilities:{}})
 const transport=new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.headers}})
 return {connect:async()=>{await client.connect(transport,{timeout:10_000})},
  call:(name,args)=>client.callTool({name,arguments:args},undefined,{timeout:10_000}),
  close:async()=>{await client.close().catch(()=>{});await transport.close().catch(()=>{})}}
}
/** Fixed, read-only discovery. Transport references come from the host, never model input. */
export async function discoverStudioSourcesFromHost(args:{query?:string;characterId?:string},hosts:Host[],dependencies:{connection?:(config:Record<string,unknown>)=>Connection}={}){
 const candidates=hosts.filter(h=>h.serverName==='vyibc-cartoon-assets'&&h.live===true&&h.disabled!==true)
 if(candidates.length!==1)throw Error('studio-source-catalog-missing-or-ambiguous')
 const host=candidates[0]
 if(READ_TOOLS.some(name=>!host.tools?.includes(name)))throw Error('studio-source-read-tools-unavailable')
 let client:Connection|undefined,connected:Promise<void>|undefined,closed=false
 try{
  return await resolveStudioSources(args,async(name,input)=>{
   if(!(READ_TOOLS as readonly string[]).includes(name))throw Error('studio-source-read-tool-required')
   client??=(dependencies.connection??connection)(host.config)
   connected??=client.connect();await connected
   if(closed)throw Error('studio-source-connection-closed')
   return client.call(name,input)
  })
 }finally{closed=true;await client?.close().catch(()=>{})}
}
