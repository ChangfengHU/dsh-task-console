/** Mechanical staging only. Never edits a live profile or restarts a service. */
import {readFile,writeFile,mkdir,readdir,copyFile} from 'node:fs/promises'
import {resolve,join,relative} from 'node:path'
import {createHash} from 'node:crypto'
const root=resolve(process.argv[2]??'.'),revision=process.argv[3]
if(!/^[a-f0-9]{40}$/.test(revision??''))throw Error('Full source revision required')
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
const uiName=`studio-task-console-ui-${revision.slice(0,12)}`,ui=join(root,'ui-package')
await mkdir(ui,{recursive:true})
await writeFile(join(ui,'package.json'),JSON.stringify({name:uiName,version:pkg.version,type:'module',license:pkg.license,main:'./host.js',exports:{'.':{default:'./host.js'},'./client':{default:'./client.js'},'./package.json':'./package.json'},dsh:pkg.dsh},null,2)+'\n')
const client=(await readFile(join(root,'lib/client.js'),'utf8')).replace(`id: ${JSON.stringify(pkg.name)},`,`id: ${JSON.stringify(uiName)},`).replaceAll('/dsh-task-console/client-heavy.js',`/${uiName}/client-heavy.js`)
if(!client.includes(`id: ${JSON.stringify(uiName)},`))throw Error('Client module staging failed')
await writeFile(join(ui,'client.js'),client)
await copyFile(join(root,'lib/client-heavy.js'),join(ui,'client-heavy.js'))
await writeFile(join(ui,'host.js'),`import {readFile} from 'node:fs/promises';\nexport const inject=['webServer'];\nexport function apply(ctx){ctx.effect(()=>ctx.webServer.register({kind:'exact',path:${JSON.stringify('/'+uiName+'/client-heavy.js')},handler:async(req,res)=>{if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}try{const body=await readFile(new URL('./client-heavy.js',import.meta.url));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'public, max-age=31536000, immutable'});res.end(req.method==='HEAD'?undefined:body);}catch{res.writeHead(404);res.end();}}}),'versioned task console frontend');}\n`)
for(const dir of [root,ui])await writeFile(join(dir,'SOURCE_REVISION'),revision+'\n')
const sha=b=>createHash('sha256').update(b).digest('hex')
async function manifest(base,paths){const rows={};async function walk(path){const full=join(base,path);const stat=await (await import('node:fs/promises')).lstat(full);if(stat.isDirectory())for(const name of await readdir(full))await walk(join(path,name));else if(stat.isFile())rows[relative(base,full)]=sha(await readFile(full));else throw Error('Nonregular release member')}for(const path of paths)await walk(path);return rows}
await writeFile(join(ui,'DEPLOY_MANIFEST.json'),JSON.stringify(await manifest(ui,['package.json','host.js','client.js','client-heavy.js','SOURCE_REVISION']),null,2)+'\n')
const files=await manifest(root,['package.json','SOURCE_REVISION','source.bundle','lib','studio','LICENSE','NOTICE','studio-host.json'])
await writeFile(join(root,'DEPLOY_MANIFEST.json'),JSON.stringify(files,null,2)+'\n')
console.log(JSON.stringify({staged:true,activated:false,version:pkg.version,revision,uiName,files:Object.keys(files).length}))
