import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,chmod,rm,symlink,cp,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve,join} from 'node:path'
import {execFileSync} from 'node:child_process'

const helpers=resolve('studio/helpers')
function python(code,args=[],env={}){return JSON.parse(execFileSync('python3',['-B','-c',code,helpers,...args],{encoding:'utf8',env:{...process.env,...env}}))}
test('both audio helpers bind the host model before credentials, separate cache requests, and retain exact-word rejection',()=>{
 const result=python(`import sys,os,json,tempfile,pathlib,io,wave,math,struct,hashlib
sys.path.insert(0,sys.argv[1])
import audio_observe_host as a,speech_check_host as s
from audio_review import payload
from observation_cache import digest,encoded
calls=[];requests=[];credential_calls=[]
def credentials():
 credential_calls.append(True);return 'FIXTURE_PROVIDER_KEY'
def observe(audio,**kwargs):
 model=kwargs['model'];context=kwargs.get('context');purpose=kwargs.get('purpose','speech')
 body,duration=payload(audio,model=model,context=context,purpose=purpose)
 assert '测试词' not in body['messages'][0]['content'][1]['text']
 calls.append({'model':model,'purpose':purpose})
 return {'input_modality':'input_audio','finish_reason':'stop','audio_sha256':hashlib.sha256(audio).hexdigest(),'duration_seconds':duration,'requested_model':model,'source_interval':context,'observer_purpose':purpose,'prompt_sha256':digest(body['messages'][0]['content'][1]['text'].encode()),'observation':json.dumps({'heard_words':'测试词'},ensure_ascii=False)}
def observe_cached(signature,fresh,validate):
 requests.append(signature['request_sha256']);result=fresh();validate(result);return result
a.credentials=s.credentials=credentials;a.observe=s.observe=observe;a.observe_cached=observe_cached
buf=io.BytesIO()
with wave.open(buf,'wb') as wav:
 wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000)
 wav.writeframes(b''.join(struct.pack('<h',int(12000*math.sin(2*math.pi*440*i/16000))) for i in range(16000)))
with tempfile.TemporaryDirectory() as temporary:
 root=pathlib.Path(temporary).resolve();path=root/'fixture.wav';path.write_bytes(buf.getvalue());os.environ['STUDIO_PROJECT_ROOT']=str(root)
 runs=[]
 for model in ('qwen3.8-omni-flash',None):
  if model is None:os.environ.pop('STUDIO_AUDIO_OBSERVER_MODEL',None)
  else:os.environ['STUDIO_AUDIO_OBSERVER_MODEL']=model
  media=a.run(str(path),0,1);speech=s.run(str(path),'测试词','final',0,1)
  runs.append({'mediaModel':media['requested_model'],'speechModel':speech['observation']['requested_model'],'gate':speech['content_gate'],'qualityPass':speech['quality_pass']})
 os.environ['STUDIO_AUDIO_OBSERVER_MODEL']='qwen3.8-omni-flash'
 mismatch=s.run(str(path),'测试词语','final',0,1)
 rejected=[]
 for model in ('unreviewed',''):
  os.environ['STUDIO_AUDIO_OBSERVER_MODEL']=model
  for run in (lambda:a.run(str(path)),lambda:s.run(str(path),'测试词')):
   before=len(credential_calls)
   try:run();rejected.append(False)
   except ValueError:rejected.append(len(credential_calls)==before)
 print(json.dumps({'runs':runs,'calls':calls,'cacheRequests':requests,'invalidRejectedBeforeCredentials':rejected,'mismatchGate':mismatch['content_gate'],'mismatchCodes':[i['code'] for i in mismatch['issues']]}))`)
 assert.deepEqual(result.runs,[
  {mediaModel:'qwen3.8-omni-flash',speechModel:'qwen3.8-omni-flash',gate:'pass',qualityPass:false},
  {mediaModel:'qwen3-omni-flash',speechModel:'qwen3-omni-flash',gate:'pass',qualityPass:false},
 ])
 assert.deepEqual(result.calls.slice(0,4),[
  {model:'qwen3.8-omni-flash',purpose:'media'},{model:'qwen3.8-omni-flash',purpose:'speech'},
  {model:'qwen3-omni-flash',purpose:'media'},{model:'qwen3-omni-flash',purpose:'speech'},
 ])
 assert.equal(result.cacheRequests.length,2);assert.notEqual(result.cacheRequests[0],result.cacheRequests[1])
 assert.deepEqual(result.invalidRejectedBeforeCredentials,[true,true,true,true])
 assert.equal(result.mismatchGate,'blocked');assert.ok(result.mismatchCodes.includes('speech_delete'))
})
test('native macOS process identity is non-null for live worker and unavailable identities never mean alive',()=>{
 const result=python(`import sys,os,json,tempfile,pathlib,time
sys.path.insert(0,sys.argv[1])
import render_job_host as m
identity=m.process_identity(os.getpid())
with tempfile.TemporaryDirectory() as temporary:
 root=pathlib.Path(temporary).resolve();job='a'*64
 m.atomic(m.job_dir(root)/(job+'.json'),{'jobId':job,'state':'running','pid':os.getpid(),'processStart':None,'createdAt':time.time()})
 status=m.status(root,job)
print(json.dumps({'platform':sys.platform,'identity':identity,'unavailableState':status['state']}))`)
 if(result.platform==='darwin')assert.match(result.identity,/^darwin:/)
 else if(result.platform==='linux')assert.match(result.identity,/^\d+$/)
 assert.equal(result.unavailableState,'unknown')
})
test('both asset helpers use the distinct fixed-endpoint host credential and reject bad explicit references without fallback',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'studio-token-reference-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const token=join(root,'bridge.token'),profile=join(root,'profile.yml'),linked=join(root,'linked.token')
 await writeFile(token,'FIXTURE_BRIDGE',{mode:0o600});await symlink(token,linked)
 await writeFile(profile,'    - id: mcp-vyibc-cartoon-assets\n      config:\n        url: https://fleet.vyibc.com/api/hub/plugin-bootstrap/mcp/vyibc-cartoon-assets\n        headers:\n          Authorization: Bearer FIXTURE_PROFILE\n')
 const script=`import sys,json,os
sys.path.insert(0,sys.argv[1]);import preflight_host as p,download_existing_asset as d
def check(fn):
 try:
  url,auth=fn();return {'ok':True,'fixed':url==d.MCP_URL,'bridge':auth=='Bearer FIXTURE_BRIDGE','profile':auth=='Bearer FIXTURE_PROFILE'}
 except Exception:return {'ok':False}
print(json.dumps({'preflight':check(p.asset_auth),'download':check(lambda:d.asset_auth(sys.argv[2]))}))`
 const env={STUDIO_ASSET_TOKEN_FILE:token,STUDIO_DSH_PROFILE:profile,STUDIO_VAULT_TOKEN_FILE:join(root,'missing-vault-token')}
 const ok=python(script,[profile],env)
 for(const value of Object.values(ok)){assert.equal(value.ok,true);assert.equal(value.fixed,true);assert.equal(value.bridge,true)}
 for(const assetTokenFile of [join(root,'missing'),linked,'relative-token']){
  const bad=python(script,[profile],{...env,STUDIO_ASSET_TOKEN_FILE:assetTokenFile})
  assert.deepEqual(bad,{preflight:{ok:false},download:{ok:false}})
 }
 await chmod(token,0o644);assert.deepEqual(python(script,[profile],env),{preflight:{ok:false},download:{ok:false}})
 const legacy=python(script,[profile],{...env,STUDIO_ASSET_TOKEN_FILE:''})
 for(const value of Object.values(legacy)){assert.equal(value.ok,true);assert.equal(value.profile,true)}
})

test('character preflight accepts the real nullable voice recommendation shape without inventing voice approval',()=>{
 const result=python(`import sys,json,pathlib,tempfile,hashlib
sys.path.insert(0,sys.argv[1]);import preflight_host as p
image=b'fixture downloaded character image';sha=hashlib.sha256(image).hexdigest();asset_id='e'*64
base={'character_id':'xiaban','profile_asset_id':asset_id,'profile_version':1,'lifecycle':'active','profile':{'personality':['生活观察']},'selected_voice_asset_id':None,'scene_asset_ids':[],'preproduction':{},'warnings':[],'note':'catalogue fixture'}
p.ensure_project_git=lambda root:{'scope':'fixture_project'}
p.prepare_execution_assets=lambda root:{}
p.run_cmd=lambda *args,**kwargs:b'{}'
def no_render(*args,**kwargs):raise RuntimeError('Fixture does not render')
p.render_hyperframes_smoke=no_render
cases={}
for label,recommendation in [('null',None),('missing','MISSING'),('explicit',{'voice_id':'fixture-selected-voice'}),('invalid',[])]:
 with tempfile.TemporaryDirectory() as temporary:
  root=pathlib.Path(temporary).resolve();character=dict(base)
  if recommendation!='MISSING':character['voice_recommendation']=recommendation
  reads=[];downloads=[]
  def rpc(name,args):
   reads.append({'name':name,'args':args})
   if name=='character_get':return character
   if name=='asset_get':return {'asset':{'id':asset_id,'source_url':'https://cdn.vyibc.com/fixture/character.png','object':{'sha256':sha}}}
   raise AssertionError('Unexpected lookup')
  def download(url,path,limit=300_000_000):
   downloads.append(url);path.write_bytes(image)
  p.rpc=rpc;p.download=download
  task={'cwd':str(root),'design':{'studio':{'characterId':'xiaban','referenceSha256':sha,'referenceUrl':'https://cdn.vyibc.com/fixture/reference.mp4'}}}
  value=p.run(task);proof=value['capabilities']['character'];saved=json.loads(pathlib.Path(proof['proofPath']).read_text())
  cases[label]={'proof':{k:proof.get(k) for k in ['ok','voice','characterId','imageSha256','sourceSha256','scope','error_type']},'persisted':saved=={k:v for k,v in proof.items() if k!='proofPath'},'quality_pass':value['quality_pass'],'lookups':reads,'character_downloaded':downloads.count('https://cdn.vyibc.com/fixture/character.png')==1}
print(json.dumps(cases))`)
 for(const label of ['null','missing','explicit']){
  const value=result[label]
  assert.equal(value.proof.ok,true)
  assert.equal(value.proof.voice,label==='explicit'?'fixture-selected-voice':null)
  assert.equal(value.proof.characterId,'xiaban');assert.equal(value.proof.scope,'actual_character_get')
  assert.match(value.proof.imageSha256,/^[a-f0-9]{64}$/);assert.equal(value.proof.sourceSha256,value.proof.imageSha256)
  assert.equal(value.persisted,true);assert.equal(value.quality_pass,false);assert.equal(value.character_downloaded,true)
  assert.deepEqual(value.lookups,[{name:'character_get',args:{character_id:'xiaban'}},{name:'asset_get',args:{id:'e'.repeat(64)}}])
 }
 assert.equal(result.invalid.proof.ok,false);assert.equal(result.invalid.proof.error_type,'ValueError')
 assert.equal(result.invalid.quality_pass,false)
})

test('real pinned compiler dispatches configured ffprobe with Linux fallback unchanged and grants no quality approval',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'studio-portable-compiler-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const interpreter=execFileSync('python3',['-c','import sys,pathlib; print(pathlib.Path(sys.executable).resolve())'],{encoding:'utf8'}).trim()
 const probe=join(root,'selected-host-probe'),marker=join(root,'probe-selected.json')
 await writeFile(probe,`#!${interpreter}\nimport json,sys,pathlib\npathlib.Path(${JSON.stringify(marker)}).write_text(json.dumps(sys.argv[1:]))\nprint(json.dumps({'streams':[{'codec_type':'audio'}],'format':{'duration':'1.0'}}))\n`,{mode:0o700})
 await cp(resolve('studio/runtime-assets/gsap.min.js'),join(root,'gsap.min.js'));await cp(resolve('studio/runtime-assets/Chinese.ttf'),join(root,'Chinese.ttf'))
 await writeFile(join(root,'subject.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'))
 await writeFile(join(root,'tone.wav'),'fixture probe supplies technical metadata only')
 const board={schema:'studio-board-v1',duration:1,gsap:'gsap.min.js',font:'Chinese.ttf',script:[{id:'technical-only',text:'FIXTURE_NO_SPEECH'}],scenes:[{start:0,duration:1,layers:[{type:'image',role:'subject',src:'subject.png',width:100,height:100}]}],audio:[{src:'tone.wav',role:'voice',start:0,lineId:'technical-only',text:'FIXTURE_NO_SPEECH'}]}
 await writeFile(join(root,'board.json'),JSON.stringify(board))
 const result=JSON.parse(execFileSync(interpreter,['-B',join(helpers,'compiler_host_bridge.py'),'--project-root',root,'--board','board.json','--output','composition'],{encoding:'utf8',env:{...process.env,FFPROBE_PATH:probe,PATH:'/usr/bin:/bin'}}))
 assert.equal(result.ok,true);assert.equal(result.qualityApproved,false)
 assert.equal(JSON.parse(await readFile(marker,'utf8')).at(-1),join(root,'tone.wav'))
 const selection=python(`import sys,json,os
sys.path.insert(0,sys.argv[1]);import acquire_incompetech_source as a
calls=[]
class P:
 returncode=0;stdout=b'{"streams":[{"codec_type":"audio","codec_name":"mp3"}]}';stderr=b''
def run(argv,**kwargs):
 calls.append(argv[0]);p=P();p.stdout=b'out_time_us=1000000\\n' if len(calls)%2==0 else p.stdout;return p
a.subprocess.run=run
a.verify_mp3(b'ID3fixture')
os.environ.pop('FFPROBE_PATH',None);os.environ.pop('FFMPEG_PATH',None)
a.verify_mp3(b'ID3fixture')
print(json.dumps(calls))`,[],{FFPROBE_PATH:probe,FFMPEG_PATH:'/host/selected-ffmpeg'})
 assert.deepEqual(selection,[probe,'/host/selected-ffmpeg','ffprobe','ffmpeg'])
})
