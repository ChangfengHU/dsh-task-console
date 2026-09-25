import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {StudioOperations} from '../src/studio-operations.ts'
test('known-job reconciliation CAS binds intent/kind/job/state and never regresses terminal or sibling rows',async t=>{
 const db=new Database(':memory:');t.after(()=>db.close());const ops=new StudioOperations({kernel:{db}}),input={task:{id:'t'},batch:{id:'b'}}
 const add=(id:string)=>db.prepare('INSERT INTO dsh_studio_operations VALUES(?,?,?,?,?,?,?,?,?)').run('t','b',id,'vyibc-voice_synthesize','voiceSegments',1,'submitted','same-job','{}')
 add('first');add('second');const operation=db.prepare("SELECT * FROM dsh_studio_operations WHERE intent='first'").get()
 const poll=(op:any=operation,canApply=()=>true,status='completed')=>ops.invoke(input,'vyibc-voice_status',{job_id:'same-job'},async()=>({status,job_id:'same-job'}),undefined,undefined,{operation:op,canApply})
 await poll(operation,()=>false);assert.equal(db.prepare("SELECT state FROM dsh_studio_operations WHERE intent='first'").get().state,'submitted')
 await poll({...operation,kind:'imageCalls'});assert.equal(db.prepare("SELECT state FROM dsh_studio_operations WHERE intent='first'").get().state,'submitted')
 await poll();assert.equal(db.prepare("SELECT state FROM dsh_studio_operations WHERE intent='first'").get().state,'completed');assert.equal(db.prepare("SELECT state FROM dsh_studio_operations WHERE intent='second'").get().state,'submitted')
 await poll(operation,()=>true,'failed');assert.equal(db.prepare("SELECT state FROM dsh_studio_operations WHERE intent='first'").get().state,'completed')
 assert.equal(db.prepare('SELECT SUM(units) n FROM dsh_studio_operations').get().n,2)
})
