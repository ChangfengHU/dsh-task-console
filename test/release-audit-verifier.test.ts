import test from 'node:test'
import assert from 'node:assert/strict'
import {verifyArchive,VERIFIER,VERIFIER_SHA256} from '../src/release-audit-verifier.js'
import {releaseArchive} from './fixtures/release-archive.js'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'

test('actual Python verifier separates revision text from byte digest and returns every member computation',async()=>{
 const {bytes,policy}=releaseArchive(),r=await verifyArchive(bytes,policy.archiveSha256,policy.commit)
 assert.equal(r.status,'pass');assert.equal(r.members.length,3);assert.equal(r.manifestEntries,2)
 const revision=r.members.find((m:any)=>m.name==='SOURCE_REVISION')
 assert.equal(revision.matches,true);assert.notEqual(revision.sha256,policy.commit);assert.equal(r.revisionContentMatches,true)
 assert.match(VERIFIER_SHA256,/^[a-f0-9]{64}$/)
})
for(const [mode,reason] of [['member','member-hash-mismatch'],['revision','source-revision-content-mismatch'],['duplicate','duplicate-member'],['traversal','unsafe-member-path'],['link','non-regular-member']])test('verifier rejects '+mode,async()=>{
 const {bytes,policy}=releaseArchive(mode),r=await verifyArchive(bytes,policy.archiveSha256,policy.commit)
 assert.equal(r.status,'fail');assert.match(r.failures.join(','),new RegExp(reason))
})
test('frozen archive mismatch is a failure before trusting member results',async()=>{
 const {bytes,policy}=releaseArchive(),r=await verifyArchive(bytes,'f'.repeat(64),policy.commit)
 assert.equal(r.status,'fail');assert.deepEqual(r.members,[]);assert.deepEqual(r.failures,['frozen-archive-changed'])
})

test('Darwin unsupported address-space limit uses bounded expansion; other platforms fail closed',()=>{
 const {bytes,policy}=releaseArchive()
 for(const platform of ['darwin','linux']){
  // Simulate the actual Darwin failure without changing production configuration.
  const prefix=String.raw`import resource,sys
original_limit=resource.setrlimit
def set_limit(kind,value):
 if kind==resource.RLIMIT_AS:raise ValueError('current limit exceeds maximum limit')
 original_limit(kind,value)
resource.setrlimit=set_limit
sys.platform=`+JSON.stringify(platform)+'\n'
  const r=spawnSync('python3',['-I','-c',prefix+VERIFIER,policy.archiveSha256,policy.commit],{input:bytes,encoding:'utf8'})
  if(platform==='darwin'){
   assert.equal(r.status,0,r.stderr);const facts=JSON.parse(r.stdout)
   assert.equal(facts.status,'pass');assert.equal(facts.addressSpacePolicy,'bounded-archive')
  }else{assert.notEqual(r.status,0);assert.equal(r.stdout,'')}
 }
})

test('compressed expansion is bounded before parsing tar headers, including on Darwin',()=>{
 // A smaller trusted test limit exercises the same bounded reader without a
 // 100 MiB fixture allocation in every full-suite run. There is no runtime knob.
 const bytes=gzipSync(Buffer.alloc(2*1024*1024)),digest=createHash('sha256').update(bytes).digest('hex')
 const bounded=VERIFIER.replace('MAX_EXPANDED_ARCHIVE=100*1024*1024','MAX_EXPANDED_ARCHIVE=1024*1024')
 const r=spawnSync('python3',['-I','-c',bounded,digest,'a'.repeat(40)],{input:bytes,encoding:'utf8'})
 assert.equal(r.status,0,r.stderr);const facts=JSON.parse(r.stdout)
 assert.equal(facts.status,'fail');assert.deepEqual(facts.members,[]);assert.deepEqual(facts.failures,['expanded-archive-limit'])
})
