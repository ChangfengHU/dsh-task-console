// Explicit operator command; recipient IDs come from the reviewed Task, never broadcast.
import { readFile } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { resendPatrolReport } from '../src/patrol-resend.ts'

const [file,taskId,requestId,credentialFile,origin]=process.argv.slice(2)
if(!file?.startsWith('/')||!credentialFile?.startsWith('/')||!origin)throw Error('Expected DB, Task, request ID, existing credential file and HTTPS origin')
const token=(await readFile(credentialFile,'utf8')).trim()
const db=new Database(file);db.pragma('busy_timeout=5000')
try {
  const result=await resendPatrolReport(db,taskId,requestId,origin,async args=>{
    const response=await fetch('https://fleet.vyibc.com/mcp/wecom',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:requestId,method:'tools/call',params:{name:'vyibc-wecom_send_message',arguments:args}}),signal:AbortSignal.timeout(45000)})
    if(!response.ok)throw Error('MCP HTTP failure')
    const rpc:any=await response.json();if(rpc.error||rpc.result?.isError)throw Error('MCP rejected')
    return rpc.result?.structuredContent??JSON.parse(rpc.result.content.filter((r:any)=>r.type==='text').map((r:any)=>r.text).join(''))
  })
  console.log(JSON.stringify(result))
}finally{db.close()}
