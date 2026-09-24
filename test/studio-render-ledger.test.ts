import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {StudioRenderLedger} from '../src/studio-render-ledger.js'
const h=(c:string)=>c.repeat(64)
function fixture(t:any){const db=new Database(':memory:');t.after(()=>db.close());const i={task:{id:'T',cwd:'/project',design:{studio:{width:1080,height:1920,fps:30}}},batch:{id:'B'},card:{id:'e1',role:'executor',round:1},sessionId:'s1'};const store:any={kernel:{db},s:{runs:new Map([['r1',{id:'r1',cardId:'e1',sessionId:'s1',status:'running'}]])}};return {i,store,db,ledger:new StudioRenderLedger(store)}}
const args={composition:'composition',output:'film.mp4'}
function result(intent:any,changes:any={}){return {ok:true,intentId:intent.intentId,jobId:h('a'),inputSha256:h('b'),state:'completed',composition:'composition',output:'film.mp4',outputSha256:h('c'),bytes:1000,width:1080,height:1920,fps:30,durationSeconds:100,helperSha256:h('d'),helperPath:'/trusted/render.py',runtimePath:'/trusted/runtime',...changes}}
const candidate={sha256:h('c'),width:1080,height:1920,fps:30,durationSeconds:100}
test('host intent survives a lost reply/restart, preserves origin and consumes exact completed bytes',t=>{
 const {ledger,i,store}=fixture(t),intent=ledger.prepare(i,'start',args,{renderJobScript:'/trusted/render.py',renderJobSha256:h('d'),renderRuntime:'/trusted/runtime'})
 const newRun={...i,sessionId:'s2'};store.s.runs.set('r2',{id:'r2',cardId:'e1',sessionId:'s2',status:'running'})
 const restored=new StudioRenderLedger(store),retry=restored.prepare(newRun,'start',args,{renderJobScript:'/trusted/render.py',renderJobSha256:h('d'),renderRuntime:'/trusted/runtime'})
 assert.equal(retry.intentId,intent.intentId);assert.equal(retry.originRunId,'r1')
 restored.record(newRun,retry,result(retry,{state:'running'}))
 assert.throws(()=>restored.requireCandidate(newRun,candidate,'/project/film.mp4'),/render-still-pending/)
 const polled=restored.prepare(newRun,'status',{jobId:h('a')});restored.record(newRun,polled,result(retry))
 const proof=restored.requireCandidate(newRun,candidate,'/project/film.mp4')
 assert.equal(proof.originSessionId,'s1');assert.equal(proof.originRunId,'r1')
 assert.throws(()=>restored.requireCandidate(newRun,{...candidate,sha256:h('e')},'/project/film.mp4'),/current-render-required/)
 assert.throws(()=>restored.requireCandidate(newRun,candidate,'/project/old.mp4'),/current-render-required/)
})
test('unknown prior submission prevents new jobs; other rounds cannot adopt status or reused replies',t=>{
 const {ledger,i}=fixture(t),intent=ledger.prepare(i,'start',args,{renderJobScript:'/trusted/render.py',renderJobSha256:h('d'),renderRuntime:'/trusted/runtime'})
 assert.throws(()=>ledger.prepare(i,'start',{...args,output:'other.mp4'},{renderJobScript:'/trusted/render.py',renderJobSha256:h('d'),renderRuntime:'/trusted/runtime'}),/prior-job-pending/)
 assert.throws(()=>ledger.prepare(i,'status',{jobId:h('a')}),/not-owned/)
 ledger.record(i,intent,result(intent))
 const next={...i,card:{...i.card,id:'e2',round:2},sessionId:'s2'}
 assert.throws(()=>ledger.prepare(next,'status',{jobId:h('a')}),/not-owned/)
 assert.throws(()=>ledger.requireCandidate(next,candidate,'/project/film.mp4'),/current-render-required/)
 assert.throws(()=>ledger.record(next,intent,result(intent,{reused:true})),/not-owned/)
 assert.throws(()=>ledger.record(i,intent,result(intent,{intentId:h('f')})),/provenance-mismatch/)
 assert.throws(()=>ledger.record(i,intent,result(intent,{helperSha256:h('f')})),/helper-version-changed/)
})

test('ambiguous helper error preserves pending ownership and pinned origin configuration',t=>{
 const {ledger,i}=fixture(t),config={renderJobScript:'/trusted/render.py',renderJobSha256:h('d'),renderRuntime:'/trusted/runtime'}
 const intent=ledger.prepare(i,'start',args,config)
 ledger.record(i,intent,{ok:false,errorCode:'output_reserved_by_other_job'})
 const saved=ledger.prepare(i,'start',args,{...config,renderJobSha256:h('e'),renderJobScript:'/new/render.py'})
 assert.equal(saved.state,'unknown');assert.equal(saved.helperSha256,h('d'));assert.equal(saved.helperPath,'/trusted/render.py')
 assert.throws(()=>ledger.prepare(i,'start',{...args,output:'new.mp4'},config),/prior-job-pending/)
})
