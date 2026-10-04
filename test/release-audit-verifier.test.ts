import test from 'node:test'
import assert from 'node:assert/strict'
import {verifyArchive,VERIFIER_SHA256} from '../src/release-audit-verifier.js'
import {releaseArchive} from './fixtures/release-archive.js'

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
