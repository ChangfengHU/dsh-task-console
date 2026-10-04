import test from 'node:test'
import assert from 'node:assert/strict'
import {publicCharacterReference} from '../src/studio-character-source.js'
const ref={id:'profile-asset',assetId:'profile-asset',path:'/private/local/reference.png',sha256:'a'.repeat(64)}
test('verified character source is exact and SHA bound without local paths',()=>{
 const sourceUrl='https://cdn.vyibc.com/actual/reference.png',value=publicCharacterReference({...ref,sourceUrl,sourceSha256:ref.sha256})
 assert.equal(value.sourceUrl,sourceUrl);assert.equal(value.sourceSha256,ref.sha256);assert.ok(!('path' in value));assert.match(value.sourceNotice,/not a guarantee/)
 for(const url of ['https://cdn.vyibc.com/a?token=SECRET','https://user:SECRET@cdn.vyibc.com/a','https://evil/a','http://cdn.vyibc.com/a'])assert.throws(()=>publicCharacterReference({...ref,sourceUrl:url,sourceSha256:ref.sha256}),(e:any)=>{assert.equal(e.message,'studio-character-source-invalid');return true})
 assert.throws(()=>publicCharacterReference({...ref,sourceUrl,sourceSha256:'b'.repeat(64)}),/invalid/)
})
test('legacy cache offers exact catalog ID lookup and never manufactures a source URL',()=>{
 const result=publicCharacterReference(ref)
 assert.deepEqual(result.sourceLookup,{tool:'asset_get',arguments:{id:ref.assetId},field:'asset.source_url'});assert.ok(!('sourceUrl' in result));assert.ok(!('path' in result))
 const {assetId,...old}=ref;assert.ok(!('sourceLookup' in publicCharacterReference(old)));assert.ok(!('sourceUrl' in publicCharacterReference(old)))
})
