/** Thin DSH adapter. Deployment implementation is owned by fleet-probe-runner. */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const name = 'task-console-fleet-runner-tools'
export const inject = ['tools']

type Job = { sessionId: string; operation: 'inspect' | 'ensure'; child: ChildProcess; events: unknown[]; result?: any; startedAt: string; done: Promise<any> }
const key = Symbol.for('dsh.fleet-runner.jobs')
const jobs: Map<string, Job> = (globalThis as any)[key] ??= new Map()
export function runnerIp(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[1-9]\d{0,2}|0)(?:\.(?:[1-9]\d{0,2}|0)){3}$/.test(value) || value.split('.').some(x => Number(x)>255)) throw new Error('需要完整 IPv4')
  return value
}
const output = { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] }

export async function apply(ctx: any, config: { readOnly?: boolean } = {}): Promise<void> {
  const defineTool: (x: any) => any = process.env.NODE_ENV === 'test' ? x => x : (await import('@deepseek-ai/dsh-tools')).defineTool
  const root = process.env.FLEET_RUNNER_OPERATOR_ROOT || ''
  const state = process.env.FLEET_RUNNER_STATE_DIR || join(homedir(), '.local/state/fleet-runner-operator')
  const entry = join(root, 'operator/cli.mjs')
  const available = isAbsolute(root) && await stat(entry).then(s => s.isFile()).catch(() => false)
  const owned = new Set<Job>()
  const start = async (ip: string, operation: 'inspect' | 'ensure', sessionId: string) => {
    if (!available) return { ok: false, phase: 'blocked', reason: 'Runner operator release is not installed on DSH host' }
    const active = jobs.get(ip)
    if (active && !active.result) return { ok: false, phase: 'busy', sessionId: active.sessionId, events: active.events }
    await mkdir(state, { recursive: true, mode: 0o700 })
    const child = spawn('/usr/bin/flock', ['--nonblock', '--no-fork', join(state, ip + '.lock'), '/usr/bin/node', entry], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let resolve!: (value: any) => void
    const job: Job = { child, sessionId, operation, events: [], startedAt: new Date().toISOString(), done: new Promise(r => resolve = r) }
    jobs.set(ip, job); owned.add(job)
    let pending = '', bytes = 0
    const finish = (result: any) => { if (job.result) return; job.result = result; clearTimeout(timer); resolve(result) }
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish({ ok: false, phase: 'blocked', reason: 'Runner operation timeout; verify external state before retry', events: job.events }) }, 900_000)
    timer.unref()
    child.stdout!.on('data', data => {
      bytes += data.length
      if (bytes > 262144) { child.kill('SIGTERM'); return }
      pending += data.toString()
      for (;;) {
        const at = pending.indexOf('\n'); if (at < 0) break
        const line = pending.slice(0, at); pending = pending.slice(at + 1)
        try { const row = JSON.parse(line); if (row.event) job.events.push(row.event); if (row.result) finish(row.result) } catch { /* fail closed at process end */ }
      }
    })
    child.stderr!.resume()
    child.on('error', () => finish({ ok: false, phase: 'blocked', reason: 'Runner operator process unavailable' }))
    child.on('close', code => finish({ ok: false, phase: 'blocked', reason: code === 1 ? 'Runner target locked or operator failed' : 'Runner process stopped without a verified result', events: job.events }))
    child.stdin!.on('error', () => undefined)
    child.stdin!.end(JSON.stringify({ ip, operation, sessionId }))
    return operation === 'inspect' ? await job.done : { ok: true, phase: 'running', ip, sessionId, startedAt: job.startedAt, note: '调用 fleet_runner_status 查看实际阶段；未完成前不要交卷。' }
  }
  const specs = [
    ['fleet_runner_inspect', '只读检查指定已注册节点的 Runner、基础装机残留进程、服务状态和签名巡检注册。不执行装机或组件修复。'],
    ['fleet_runner_ensure', '异步启动 Runner 专项幂等部署/恢复。只操作 Runner release、配置、服务和既有隧道的新 ingress；不修改 Clash、浏览器或账户。'],
    ['fleet_runner_status', '查看真实部署阶段、最终验收报告和签名作业 ID；没有返回 complete 就不能宣称部署完成。'],
    ['fleet_runner_cancel', '取消本会话启动的 Runner 操作。保留记录；取消不是远端已恢复或已停止的证明，之后需要 inspect。'],
  ]
  const disposers = specs.filter(([name]) => !config.readOnly || ['fleet_runner_inspect','fleet_runner_status'].includes(name)).map(([name, description]) => {
    const tool = defineTool({ name, description, parameters: { ip: { type: 'string', required: true } }, output,
      async execute(args: any, exec: any) {
        if (!args || Object.keys(args).some(k => k !== 'ip')) throw new Error('只允许 ip，不接受命令、凭据或配置')
        const ip = runnerIp(args.ip), sessionId = String(exec?.agent?.session?.id || exec?.agent?.session?.header?.id || '')
        if (!sessionId) return { ok: false, phase: 'blocked', reason: 'DSH session identity unavailable' }
        if (name === 'fleet_runner_status') {
          const active = jobs.get(ip)
          if (active && (active.operation === 'ensure' || !active.result)) { if (!active.result) await Promise.race([active.done, new Promise(r => setTimeout(r, 2500))]); return active.result || { ok: true, phase: 'running', ip, sessionId: active.sessionId, startedAt: active.startedAt, events: active.events } }
          return readFile(join(state, ip + '.json'), 'utf8').then(JSON.parse).catch(() => ({ ok: false, phase: 'not_started' }))
        }
        if (name === 'fleet_runner_cancel') {
          const active = jobs.get(ip)
          if (!active || active.result) return { ok: true, phase: 'no_active_operation' }
          if (active.sessionId !== sessionId) return { ok: false, phase: 'blocked', reason: 'Only the owning session can cancel' }
          active.child.kill('SIGTERM'); return { ok: true, phase: 'cancellation_requested', note: '检查 status 和 inspect，不把请求取消当作完成。' }
        }
        return start(ip, name === 'fleet_runner_inspect' ? 'inspect' : 'ensure', sessionId)
      },
    })
    if (tool.parameters?.type === 'object') tool.parameters = { ...tool.parameters, additionalProperties: false }
    return ctx.tools.register(tool)
  })
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
    for (const job of owned) { if (!job.result) job.child.kill('SIGTERM') }
  })
}
