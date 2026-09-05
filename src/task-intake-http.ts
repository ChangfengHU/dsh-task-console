/** Authenticated HTTP bridge used by Fleet and other control planes to submit Task Signals. */

import { timingSafeEqual } from 'node:crypto'

const MAX_BODY = 64 * 1024

function reply(res: any, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function bearer(req: any): string {
  const value = String(req.headers?.authorization ?? '')
  return /^Bearer\s+/i.test(value) ? value.replace(/^Bearer\s+/i, '') : ''
}

function sameSecret(actual: string, expected: string): boolean {
  if (!actual || !expected) return false
  const a = Buffer.from(actual); const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function body(req: any): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY) throw Object.assign(new Error('Signal 超过 64 KiB'), { status: 413 })
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Object.assign(new Error('请求体不是 JSON'), { status: 400 }) }
}

export async function handleTaskSignalHttp(req: any, res: any, service: any, token = process.env.DSH_TASK_INTAKE_TOKEN ?? ''): Promise<void> {
  if (!token) { reply(res, 503, { ok: false, error: 'Task Signal API 未配置' }); return }
  if (!sameSecret(bearer(req), token)) { reply(res, 401, { ok: false, error: 'unauthorized' }); return }
  const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
  try {
    if (req.method === 'POST') {
      const value = JSON.parse(await service.submitTaskSignal(JSON.stringify({ signal: await body(req) })))
      reply(res, 202, { ok: true, ...value }); return
    }
    if (req.method === 'GET') {
      if (url.searchParams.get('capabilities') === '1') {
        reply(res,200,{ok:true,intakeProtocol:'bundle-v1',intakeAgentId:'task-intake'}); return
      }
      const id = url.searchParams.get('id')
      const value = id
        ? JSON.parse(await service.taskSignal(JSON.stringify({ id })))
        : JSON.parse(await service.taskSignals(JSON.stringify({ limit: Number(url.searchParams.get('limit')) || 50 })))
      reply(res, 200, id ? { ok: true, ...value } : { ok: true, signals: value }); return
    }
    reply(res, 405, { ok: false, error: 'method not allowed' })
  } catch (error) {
    const status = Number((error as { status?: number })?.status) || 400
    reply(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

export function registerTaskSignalHttp(ctx: any): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-task-console/api/task-signals',
    handler: (req: any, res: any) => {
      const service = ctx.get('taskConsole') ?? ctx.taskConsole
      if (!service) { reply(res, 503, { ok: false, error: 'Task Console 尚未就绪' }); return }
      return handleTaskSignalHttp(req, res, service)
    },
  })
}
