/** Optional stdio MCP; importing/installing the Task plugin grants nobody this capability. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { pathToFileURL } from 'node:url'
import { loadProxyPolicy } from './proxy-policy.ts'
import { ProxyService } from './proxy-service.ts'
import { proxyTransport } from './proxy-transport.ts'

export function createProxyMcp(service:ProxyService){
  const server=new Server({name:'vyibc-proxy',version:'0.1.0'},{capabilities:{tools:{}}})
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:service.tools() as any}))
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    try{const result=await service.call(request.params.name,request.params.arguments??{});return {content:[{type:'text',text:JSON.stringify(result)}],isError:result.ok===false}}
    catch(e){return {content:[{type:'text',text:JSON.stringify({ok:false,reason:e instanceof Error&&/^[a-z][a-z0-9-]{1,95}$/.test(e.message)?e.message:'proxy-request-rejected'})}],isError:true}}
  })
  return server
}
async function main(){
  process.umask(0o077)
  const args=process.argv.slice(2)
  if(args.length && (args.length!==2||args[0]!=='--config'))throw new Error('invalid-startup-arguments')
  const policy=args.length?await loadProxyPolicy(args[1]):undefined
  const service=await ProxyService.open(policy,proxyTransport(policy)),server=createProxyMcp(service)
  await server.connect(new StdioServerTransport())
  process.stdin.once('end',()=>{void service.close()})
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(()=>{process.stderr.write('proxy-mcp startup failed: check protected host policy\n');process.exitCode=1})
