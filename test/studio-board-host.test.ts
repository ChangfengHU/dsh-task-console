import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {compileStudioStoryboard} from '../src/studio-host.ts'

async function fixture(t:any){
 const cwd=await mkdtemp(join(tmpdir(),'studio-board-host-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 const script=join(cwd,'fixed-compiler.py'),body='import json,sys\nprint(json.dumps({"ok":False,"errorType":"ValueError","reason":"fixture-rejection","qualityApproved":False,"args":sys.argv[1:]}))\n'
 await writeFile(script,body)
 return {cwd,script,config:{storyboardCompilerScript:script,storyboardCompilerSha256:createHash('sha256').update(body).digest('hex')}}
}
test('actual Python host transport uses the pinned compiler and preserves a rejection',async t=>{
 const f=await fixture(t),args={boardPath:join(f.cwd,'.studio-boards','hash.json'),outputDirectory:'composition-r1'}
 const result=await compileStudioStoryboard({cwd:f.cwd},args,{config:f.config})
 assert.equal(result.ok,false);assert.equal(result.qualityApproved,false);assert.equal(result.reason,'fixture-rejection')
 assert.deepEqual(result.args,['--project-root',f.cwd,'--board',args.boardPath,'--output','composition-r1'])
})
test('missing configuration or changed compiler refuses execution',async t=>{
 const f=await fixture(t),args={boardPath:'data.json',outputDirectory:'r1'};let executions=0
 const execute=async()=>{executions++;return {ok:true,qualityApproved:false}}
 await assert.rejects(compileStudioStoryboard({cwd:f.cwd},args,{config:{},execute}),/host-not-configured/)
 await writeFile(f.script,'changed')
 await assert.rejects(compileStudioStoryboard({cwd:f.cwd},args,{config:f.config,execute}),/compiler-changed/)
 assert.equal(executions,0)
})
test('host never accepts a compiler quality approval or untyped success',async t=>{
 const f=await fixture(t)
 for(const result of [{ok:true,qualityApproved:true},{ok:'true',qualityApproved:false},null])await assert.rejects(compileStudioStoryboard({cwd:f.cwd},{boardPath:'b.json',outputDirectory:'r1'},{config:f.config,execute:async()=>result}),/host-result-invalid/)
})
