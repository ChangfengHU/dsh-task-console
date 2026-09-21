/** Fixed SSH adapter: credentials stay in Vault/ssh-agent memory, never model arguments. */
import { spawn } from 'node:child_process'
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { authorizeProxy, privateFile, proxyIp, type ProxyPolicy } from './proxy-policy.ts'
import type { ProxyAction, ProxyResult, ProxyTransport } from './proxy-service.ts'

type Line={id:string;config_url:string;expected_ip:string}
export function tokenFromFile(text:string,key?:string){
  if(!key)return text.trim()
  const lines=text.split('\n').filter(line=>line.startsWith(key+'='))
  if(lines.length!==1)throw new Error('credential-file-invalid')
  const value=lines[0].slice(key.length+1).trim()
  return /^(["']).*\1$/.test(value)?value.slice(1,-1):value
}
async function rpc(policy:ProxyPolicy,capability:string,tool:string,args:unknown,tokenFile:string,key?:string){
  const token=tokenFromFile(await privateFile(tokenFile),key)
  if(!token||token.length>8192||/[\r\n]/.test(token))throw new Error('credential-file-invalid')
  const r=await fetch(policy.vaultOrigin+'/mcp/'+capability,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:args}}),signal:AbortSignal.timeout(25000)})
  if(!r.ok)throw new Error('proxy-provider-http-'+r.status)
  const raw=await r.text();if(raw.length>262144)throw new Error('proxy-provider-response-too-large')
  const body=JSON.parse(raw)
  if(body.error||body.result?.isError)throw new Error('proxy-provider-denied')
  for(const c of body.result?.content??[])if(c.type==='text'){try{const value=JSON.parse(c.text);if(value.ok===true)return value}catch{}}
  throw new Error('proxy-provider-invalid-response')
}
export async function proxyMaterial(policy:ProxyPolicy,ip:string,action:ProxyAction){
  const node=authorizeProxy(policy,ip,action==='repair')
  // The narrow resolver refuses unknown/unregistered SSH targets. No root-password fallback.
  const ssh=await rpc(policy,'fleet-onboard-vault','vyibc-fleet-onboard-vault_resolve_ssh',{ip},policy.sshResolveTokenFile,policy.sshResolveTokenKey)
  if(ssh.ip!==ip||ssh.username!=='claude'||ssh.source!=='vault'||typeof ssh.private_key!=='string'||ssh.private_key.length>65536)throw new Error('managed-ssh-key-unavailable')
  const source=await rpc(policy,'vault','vyibc-vault_get_config',{key:'clash:lines'},policy.vaultTokenFile)
  if(!Array.isArray(source.value))throw new Error('proxy-lines-invalid')
  const matches=source.value.filter((line:any)=>line?.id===node.lineId)
  if(matches.length!==1)throw new Error('approved-proxy-line-unavailable')
  const line=matches[0] as Line
  if(typeof line.config_url!=='string'||line.config_url.length>8192)throw new Error('approved-proxy-line-invalid')
  const url=new URL(line.config_url)
  if(url.protocol!=='https:'||url.username||url.password||url.hash||!proxyIp.safeParse(line.expected_ip).success)throw new Error('approved-proxy-line-invalid')
  return {key:ssh.private_key.replace(/\n*$/,'\n'),line}
}
function capture(command:string,args:string[],input:string,env:NodeJS.ProcessEnv,timeout:number,max=262144){
  return new Promise<{code:number|null;stdout:string}>(resolve=>{
    const child=spawn(command,args,{env,stdio:['pipe','pipe','pipe']});let stdout='',size=0
    const timer=setTimeout(()=>child.kill('SIGTERM'),timeout)
    child.stdout.on('data',b=>{size+=b.length;if(size>max)child.kill('SIGTERM');else stdout+=b.toString()})
    child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(input)
    child.on('error',()=>{clearTimeout(timer);resolve({code:-1,stdout:''})})
    child.on('close',code=>{clearTimeout(timer);resolve({code,stdout})})
  })
}
export function proxyTransport(policy:ProxyPolicy|undefined):ProxyTransport {
  return async(action,ip,operationId,emit,receiptAction)=>{
    // A failed receipt lookup says nothing about the earlier mutation's outcome.
    const untouched=action!=='receipt'
    if(!policy)return {ok:false,reason:'proxy-policy-unconfigured',quiescent:untouched}
    let material:Awaited<ReturnType<typeof proxyMaterial>>,source:string,machineId:string
    try{
      material=await proxyMaterial(policy,ip,action)
      source=await readFile(new URL('../src/proxy-remote.py',import.meta.url),'utf8')
      machineId=(await readFile('/etc/machine-id','utf8')).trim()
      if(!/^[a-f0-9]{32}$/.test(machineId))throw new Error('operator-identity-unavailable')
      const known=await stat(policy.knownHostsFile);if(!known.isFile()||(known.mode&0o022))throw new Error('known-hosts-unavailable')
      const trusted=await capture('/usr/bin/ssh-keygen',['-F',ip,'-f',policy.knownHostsFile],'',{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},5000,65536)
      if(trusted.code!==0)throw new Error('known-host-target-unavailable')
    }catch(e){return {ok:false,reason:e instanceof Error&&/^[a-z][a-z0-9-]{1,95}$/.test(e.message)?e.message:'proxy-provider-or-host-configuration-unavailable',quiescent:untouched}}
    const dir=await mkdtemp(join(tmpdir(),'dsh-proxy-agent-')),socket=join(dir,'agent.sock')
    const env={PATH:'/usr/bin:/bin',LANG:'C.UTF-8',SSH_AUTH_SOCK:socket}
    const agent=spawn('/usr/bin/ssh-agent',['-D','-a',socket],{env,stdio:'ignore'});let agentFailed=false;agent.on('error',()=>{agentFailed=true})
    try{
      for(let i=0;i<40;i++){if(agentFailed)break;if(await stat(socket).then(s=>s.isSocket()).catch(()=>false))break;await delay(50)}
      const added=await capture('/usr/bin/ssh-add',['-'],material.key,env,5000,1024)
      material.key=''
      if(agentFailed||added.code!==0)return {ok:false,reason:'ssh-agent-unavailable',quiescent:untouched}
      emit({stage:'ssh-connect',lineId:material.line.id,expectedIp:material.line.expected_ip})
      const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'"
      const args=['-F','/dev/null','-T','-o','BatchMode=yes','-o','IdentityFile=none','-o','IdentitiesOnly=no',
        '-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+policy.knownHostsFile,'-o','GlobalKnownHostsFile=/dev/null',
        '-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-o','ControlMaster=no',
        'claude@'+ip,'sudo -n /usr/bin/python3 -c '+quote(source)]
      // stdin only; no credentials/URL in argv or unfiltered subprocess output.
      const input=JSON.stringify({action,operationId,operatorMachineId:machineId,lineId:material.line.id,...(action==='receipt'?{receiptAction}:{}),
        configUrl:material.line.config_url,expectedIp:material.line.expected_ip})
      return await new Promise<ProxyResult>(resolve=>{
        const child=spawn('/usr/bin/ssh',args,{env,stdio:['pipe','pipe','pipe']});let buffer='',bytes=0,result:ProxyResult|undefined
        const timer=setTimeout(()=>child.kill('SIGTERM'),1500000)
        child.stdout.on('data',data=>{bytes+=data.length;if(bytes>262144){child.kill('SIGTERM');return}buffer+=data.toString()
          for(;;){const i=buffer.indexOf('\n');if(i<0)break;const line=buffer.slice(0,i);buffer=buffer.slice(i+1)
            try{const row=JSON.parse(line);if(row.event)emit(row.event);if(row.result)result=row.result}catch{/* never forward raw output */}}
        })
        child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(input)
        child.on('error',()=>{clearTimeout(timer);resolve({ok:false,reason:'ssh-process-unavailable',quiescent:untouched})})
        child.on('close',()=>{clearTimeout(timer);resolve(result??{ok:false,reason:'ssh-outcome-unknown',quiescent:false})})
      })
    }finally{
      agent.kill('SIGTERM');await rm(dir,{recursive:true,force:true})
    }
  }
}
