import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const INSTALLER = 'https://skill.vyibc.com/dsh-config-bootstrap/release/install-dsh-config-bootstrap.sh'
const ROOT = join(homedir(), '.config', 'dsh-config-bootstrap', 'imports')

export interface RuntimeBootstrapState { jobId: string; state: 'running' | 'complete' | 'failed'; message?: string }

function shell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
function jobPath(jobId: string): string {
  if (!/^[a-f0-9]{24}$/.test(jobId)) throw Error('运行时安装任务编号无效')
  return join(ROOT, jobId)
}

export async function startRuntimeBootstrap(configUrl: string, token: string): Promise<RuntimeBootstrapState> {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw Error('配置包未携带有效的运行时引导授权')
  const jobId = createHash('sha256').update(`${configUrl}\0${Date.now()}\0${Math.random()}`).digest('hex').slice(0, 24)
  const dir = jobPath(jobId), status = join(dir, 'status.json'), installer = join(dir, 'installer.sh'), tokenFile = join(dir, 'token')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const response = await fetch(INSTALLER, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw Error(`运行时安装器下载失败（HTTP ${response.status}）`)
  const source = await response.text()
  if (!source.startsWith('#!/usr/bin/env bash') || !source.includes('--bootstrap-token-file')) throw Error('运行时安装器版本不支持安全的一键导入')
  await writeFile(installer, source, { mode: 0o700 }); await chmod(installer, 0o700)
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 })
  await writeFile(status, JSON.stringify({ jobId, state: 'running' }), { mode: 0o600 })
  const runner = join(dir, 'run.sh')
  const failedStatus = join(dir, 'failed.json'), completeStatus = join(dir, 'complete.json')
  await writeFile(failedStatus, JSON.stringify({ jobId, state: 'failed', message: '运行时安装或配置导入失败，请查看任务日志' }), { mode: 0o600 })
  await writeFile(completeStatus, JSON.stringify({ jobId, state: 'complete' }), { mode: 0o600 })
  await writeFile(runner, `#!/usr/bin/env bash\nset -euo pipefail\nstatus=${shell(status)}\ntoken_file=${shell(tokenFile)}\nfailed_status=${shell(failedStatus)}\ntrap 'cp "$failed_status" "$status"; rm -f "$token_file"' ERR\n${shell(installer)} --bootstrap-token-file "$token_file" --config-url ${shell(configUrl)}\ncp ${shell(completeStatus)} "$status"\nrm -f "$token_file"\n`, { mode: 0o700 })
  const logFd = openSync(join(dir, 'install.log'), 'a', 0o600)
  const child = spawn('/bin/bash', [runner], { detached: true, stdio: ['ignore', logFd, logFd] })
  closeSync(logFd)
  child.unref()
  return { jobId, state: 'running' }
}

export async function runtimeBootstrapStatus(jobId: string): Promise<RuntimeBootstrapState> {
  let parsed: RuntimeBootstrapState
  try { parsed = JSON.parse(await readFile(join(jobPath(jobId), 'status.json'), 'utf8')) }
  catch { throw Error('运行时安装任务不存在') }
  if (parsed.jobId !== jobId || !['running', 'complete', 'failed'].includes(parsed.state)) throw Error('运行时安装状态无效')
  return parsed
}
