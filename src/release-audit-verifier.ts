/** Trusted deterministic reader. Does not extract or execute archive members. */
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
export const VERIFIER=String.raw`
import sys,io,json,tarfile,hashlib,posixpath,resource
resource.setrlimit(resource.RLIMIT_AS,(512*1024*1024,512*1024*1024))
resource.setrlimit(resource.RLIMIT_CPU,(20,20))
raw=sys.stdin.buffer.read(32*1024*1024+1)
expected,commit=sys.argv[1:3]
def sha(b):return hashlib.sha256(b).hexdigest()
def unique(pairs):
 d={}
 for k,v in pairs:
  if k in d:raise ValueError('duplicate-manifest-key')
  d[k]=v
 return d
try:
 if len(raw)>32*1024*1024:raise ValueError('archive-too-large')
 if sha(raw)!=expected:raise ValueError('frozen-archive-changed')
 rows=[];special={};seen=set();total=0
 with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as tf:
  for m in tf:
   n=m.name
   if len(rows)>=256 or len(n)>512:raise ValueError('archive-member-limit')
   if not n or n.startswith('/') or '\\' in n or any(x in ('','..','.') for x in n.split('/')) or posixpath.normpath(n)!=n:raise ValueError('unsafe-member-path')
   if n in seen:raise ValueError('duplicate-member')
   if not m.isfile():raise ValueError('non-regular-member')
   seen.add(n);total+=m.size
   if m.size>32*1024*1024 or total>96*1024*1024:raise ValueError('expanded-size-limit')
   f=tf.extractfile(m);h=hashlib.sha256();count=0;parts=[]
   while True:
    chunk=f.read(65536)
    if not chunk:break
    count+=len(chunk);h.update(chunk)
    if n in ('DEPLOY_MANIFEST.json','SOURCE_REVISION'):
     if count>256*1024:raise ValueError('metadata-too-large')
     parts.append(chunk)
   if count!=m.size:raise ValueError('member-size-mismatch')
   if parts:special[n]=b''.join(parts)
   rows.append({'name':n,'size':count,'sha256':h.hexdigest()})
 if 'DEPLOY_MANIFEST.json' not in special or 'SOURCE_REVISION' not in special:raise ValueError('metadata-missing')
 manifest=json.loads(special['DEPLOY_MANIFEST.json'],object_pairs_hook=unique)
 if not isinstance(manifest,dict) or set(manifest)!=seen-{'DEPLOY_MANIFEST.json'}:raise ValueError('manifest-coverage-mismatch')
 failed=[]
 for row in rows:
  if row['name']=='DEPLOY_MANIFEST.json':continue
  expected_member=manifest[row['name']]
  if not isinstance(expected_member,str) or len(expected_member)!=64 or any(c not in '0123456789abcdef' for c in expected_member):raise ValueError('manifest-hash-invalid')
  row['expectedSha256']=expected_member;row['matches']=row['sha256']==expected_member
  if not row['matches']:failed.append('member-hash-mismatch:'+row['name'])
 revision_matches=special['SOURCE_REVISION'].decode('utf-8').strip()==commit
 if not revision_matches:failed.append('source-revision-content-mismatch')
 print(json.dumps({'schema':'release-audit-facts-v1','status':'fail' if failed else 'pass','archiveSha256':sha(raw),'expectedCommit':commit,'revisionContentMatches':revision_matches,'manifestEntries':len(manifest),'members':rows,'failures':failed,'scope':'byte-integrity-only','verifierRuntime':sys.version.split()[0]}))
except Exception as e:
 print(json.dumps({'schema':'release-audit-facts-v1','status':'fail','archiveSha256':sha(raw),'expectedCommit':commit,'failures':[str(e) if isinstance(e,ValueError) else type(e).__name__],'members':[],'scope':'byte-integrity-only','verifierRuntime':sys.version.split()[0]}))
`
export const VERIFIER_SHA256=createHash('sha256').update(VERIFIER).digest('hex')
export function verifyArchive(bytes:Buffer,archiveSha256:string,commit:string):Promise<Record<string,any>>{
 if(bytes.length>32*1024*1024||!/^[a-f0-9]{64}$/.test(archiveSha256)||!/^[a-f0-9]{40}$/.test(commit))throw Error('release-audit-verifier-input-invalid')
 return new Promise((resolve,reject)=>{
  const child=spawn('python3',['-I','-c',VERIFIER,archiveSha256,commit],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8'}})
  let out='',err='',finished=false;const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('release-audit-verifier-timeout'))},60_000)
  const finish=(error?:Error,value?:any)=>{if(finished)return;finished=true;clearTimeout(timer);if(error)reject(error);else resolve(value)}
  child.on('error',e=>finish(e));child.stdin.on('error',()=>{})
  child.stdout.on('data',d=>{out+=d;if(Buffer.byteLength(out)>524288){child.kill('SIGKILL');finish(Error('release-audit-verifier-output-limit'))}})
  child.stderr.on('data',d=>{err+=d;if(err.length>4096){child.kill('SIGKILL');finish(Error('release-audit-verifier-error-limit'))}})
  child.on('close',code=>{if(code!==0)return finish(Error('release-audit-verifier-failed'));try{finish(undefined,JSON.parse(out))}catch{finish(Error('release-audit-verifier-invalid-json'))}})
  child.stdin.end(bytes)
 })
}
