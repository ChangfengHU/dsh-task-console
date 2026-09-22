/** Local candidate RPC for read-only browser acceptance. Never instantiate a runner. */
import { createServer } from 'node:http'
import Database from 'better-sqlite3'
import { fold } from '../src/fold.ts'
import { EventStore } from '../src/tasks.ts'
import { TaskConsoleService } from '../src/service.ts'
import { ledgerPage } from '../src/ledger-page.ts'

const db = new Database(process.env.DTC_TEST_DB!, { readonly: true })
const events = db.prepare('SELECT payload_json FROM dsh_events ORDER BY rowid').all().map((r: any) => JSON.parse(r.payload_json))
const service: any = Object.create(TaskConsoleService.prototype)
service.runner = { store: { s: fold(events), kernel: { db }, all: () => events, graphSnapshot: EventStore.prototype.graphSnapshot } }
createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk
    const request = JSON.parse(body), method = request.method.split('/').at(-1)
    if (!['taskGraph', 'taskSnapshot', 'sessionTurns'].includes(method)) throw new Error('Read-only preview method denied')
    let value: string
    if (method === 'sessionTurns') {
      const args = JSON.parse(request.payload.args.payload)
      const original = { ...request, payload: { args: { payload: JSON.stringify({sessionId:args.sessionId}) } } }
      const response: any = await (await fetch('http://127.0.0.1:3080/api/taskConsole/sessionTurns', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(original) })).json()
      if (!response.result.ok) throw Error('Trace source unavailable')
      value = JSON.stringify(ledgerPage(JSON.parse(response.result.value), args.page ?? 1))
    } else value = await service[method](request.payload.args.payload)
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }))
  } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: String(e) })) }
}).listen(3287, '127.0.0.1', () => console.log('read-only detail preview ready'))
