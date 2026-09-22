import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import worker, { assetKey } from '../deployment/dsh-loopback-proxy.mjs'

test('only versioned public scripts qualify, never API/session/auth traffic', () => {
  for (const path of ['/?session=x', '/api/session.list', '/plugins/events', '/plugins/test/client.js', '/plugins/test/client.js?rev=abcdef123456&token=x']) assert.equal(assetKey(new Request('https://dsh.test'+path)), null)
  const url='https://dsh.test/plugins/test/client.js?rev=abcdef123456'
  assert.ok(assetKey(new Request(url)))
  assert.equal(assetKey(new Request(url,{headers:{authorization:'Bearer fake'}})),null)
  assert.equal(assetKey(new Request(url,{method:'POST'})),null)
})

test('verified bundle caches once; wrong revision does not cache; invalid registration fails loud', async t => {
  const realFetch=globalThis.fetch, realCaches=globalThis.caches
  t.after(()=>{globalThis.fetch=realFetch;globalThis.caches=realCaches})
  const entries=new Map();let calls=0;let payload='window.__ModuleLoader__.load({id:"test",factory:()=>({})});'
  globalThis.caches={default:{match:async k=>entries.get(k.url)?.clone(),put:async(k,r)=>entries.set(k.url,r)}}
  globalThis.fetch=async req=>{calls++;assert.equal(req.headers.has('cookie'),false);return new Response(payload,{headers:{'content-type':'text/javascript'}})}
  const rev=createHash('sha1').update(payload).digest('hex').slice(0,12)
  const request=new Request('https://dsh.test/plugins/test/client.js?rev='+rev,{headers:{cookie:'private=fake'}})
  let pending=[];const ctx={waitUntil:p=>pending.push(p)}
  const first=await worker.fetch(request,{},ctx);assert.equal(first.headers.get('x-dsh-asset-cache'),'MISS');await Promise.all(pending)
  const second=await worker.fetch(request,{},ctx);assert.equal(second.headers.get('x-dsh-asset-cache'),'HIT');assert.equal(calls,1)
  const mismatch=await worker.fetch(new Request('https://dsh.test/plugins/test/client.js?rev=abcdef123456'),{},ctx)
  assert.equal(mismatch.headers.get('cache-control'),'no-store');assert.equal(entries.size,1)
  payload='<html>upstream error</html>'
  const bad=await worker.fetch(new Request('https://dsh.test/plugins/test/client.js?rev=abcdef123457'),{},ctx)
  assert.equal(bad.status,502);assert.equal(entries.size,1)
})
