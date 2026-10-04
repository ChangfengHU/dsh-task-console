import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { handleTaskSignalHttp } from '../src/task-intake-http.ts'

function request(method: string, payload?: unknown, token = 'test-token'): any {
  const stream: any = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
  stream.method = method; stream.url = '/dsh-task-console/api/task-signals'; stream.headers = { authorization: `Bearer ${token}` }
  return stream
}

function response() {
  let status = 0; let text = ''
  return {
    writeHead(value: number) { status = value }, end(value?: string) { text = value ?? '' },
    get status() { return status }, get body() { return JSON.parse(text) },
  }
}

test('Task Signal HTTP bridge is fail-closed and returns an async receipt', async () => {
  const service = {
    submitTaskSignal: async () => JSON.stringify({ signal: { id: 'sig-1' }, status: 'received' }),
    taskSignal: async () => JSON.stringify({ signal: { id: 'sig-1' }, status: 'materialized' }),
    taskSignals: async () => JSON.stringify([]),
  }
  let res: any = response()
  await handleTaskSignalHttp(request('POST', {}, 'wrong'), res, service, 'test-token')
  assert.equal(res.status, 401)
  res = response()
  await handleTaskSignalHttp(request('POST', { schemaVersion: 1 }), res, service, 'test-token')
  assert.equal(res.status, 202)
  assert.equal(res.body.signal.id, 'sig-1')
  res = response()
  await handleTaskSignalHttp(request('GET'), res, service, '')
  assert.equal(res.status, 503)
})

test('only explicit authenticated retry query forwards the triage retry request', async () => {
  const received:any[]=[]
  const service={submitTaskSignal:async(payload:string)=>{received.push(JSON.parse(payload));return JSON.stringify({status:'received'})}}
  const denied=request('POST',{id:'retry-1'},'wrong');denied.url+='?retry=1'
  await handleTaskSignalHttp(denied,response(),service,'test-token')
  assert.equal(received.length,0)
  const retry=request('POST',{id:'retry-1'});retry.url+='?retry=1'
  await handleTaskSignalHttp(retry,response(),service,'test-token')
  assert.equal(received[0].retry,true)
  await handleTaskSignalHttp(request('POST',{id:'retry-1'}),response(),service,'test-token')
  assert.equal(received[1].retry,undefined)
})
