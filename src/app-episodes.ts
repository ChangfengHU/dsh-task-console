/** Local App-owned episode launches. No manifest commands or browser paths run. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export async function readAppBinding(presetPath: string, agentId: string) {
  let owner: any
  try { owner = JSON.parse(await readFile(join(dirname(presetPath), 'app-owner.json'), 'utf8')) }
  catch (e: any) { if (e.code === 'ENOENT') return; throw e }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(owner.appId)) throw Error('Invalid App owner')
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const receipt = JSON.parse(await readFile(join(home, 'apps', owner.appId + '.json'), 'utf8'))
  const enabled = receipt.status === 'installed' && receipt.enabled !== false && receipt.managedAgents?.includes(agentId)
  return { id: owner.appId, name: receipt.displayName ?? owner.appId, version: receipt.version, enabled: !!enabled,
    sourceKind: receipt.sourceKind, workspace: owner.workspace, episodeActions: receipt.episodeActions === true }
}

export async function launchAppEpisode(input: { presetPath: string; agentId: string; requestId: string; actionId: string; revision: string; text: string }, start: (text: string, cwd: string, sessionId: string) => Promise<any>) {
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)) throw Error('Invalid episode requestId')
  const app = await readAppBinding(input.presetPath, input.agentId)
  if (!app?.enabled || !app.episodeActions || typeof app.workspace !== 'string' || !app.workspace.startsWith('/')) throw Error('App episode action is not enabled')
  const root = resolve(app.workspace)
  const runtime = JSON.parse(await readFile(join(root, 'STUDIO_RUNTIME.json'), 'utf8'))
  if (runtime.workspaceRoot !== root) throw Error('App workspace binding mismatch')
  const episodeId = createHash('sha256').update(input.agentId + ':' + input.requestId).digest('hex').slice(0,24)
  const cwd = join(root, 'episodes', episodeId), record = join(cwd, 'EPISODE_LAUNCH.json')
  const digest = createHash('sha256').update(JSON.stringify({ agentId: input.agentId, actionId: input.actionId, revision: input.revision, text: input.text })).digest('hex')
  await mkdir(cwd, { recursive: true, mode: 0o700 })
  const lock = join(cwd, '.launch-lock')
  try { await mkdir(lock) } catch (e: any) { if (e.code === 'EEXIST') throw Error('本次制作正在启动；请沿原请求重试，不要新建请求'); throw e }
  const atomic = async (path: string, value: unknown) => { const tmp = path + '.tmp'; await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(tmp, path) }
  try {
    let prior: any
    try { prior = JSON.parse(await readFile(record, 'utf8')) } catch (e: any) { if (e.code !== 'ENOENT') throw e }
    if (prior) {
      if (prior.inputSha256 !== digest) throw Error('同一请求的内容已改变；不能重复启动')
      if (prior.state === 'started') return prior
      throw Error('上次启动结果未确认，保留原会话 ID 核对；不会重复启动')
    }
    const sessionId = `agent-${input.agentId}-episode-${episodeId}`
    const intent = { schema: 1, appId: app.id, agentId: input.agentId, requestId: input.requestId, actionId: input.actionId, actionRevision: input.revision,
      inputSha256: digest, episodeId, workspace: cwd, sessionId, state: 'starting', requestedAt: new Date().toISOString() }
    await atomic(record, intent)
    await atomic(join(cwd, 'STUDIO_RUNTIME.json'), { ...runtime, workspaceRoot: cwd })
    const text = `本次制作使用隔离工作目录 ${cwd}，以会话 cwd 和此目录 STUDIO_RUNTIME.json 为准，不使用 preset 中旧的工作目录。新作品不得读取其他作品；明确指定的返修目标可只读用于对照。本次 operation=${input.requestId}，恢复时先读本集台账与原任务 ID，禁止重复提交状态未知的任务。\n\n${input.text}`
    try {
      const result = await start(text, cwd, sessionId)
      const proof = { ...intent, ...result, state: 'started' }
      await atomic(record, proof)
      await atomic(join(cwd, 'DSH_SESSION.json'), proof)
      return proof
    } catch (e) { await atomic(record, { ...intent, state: 'unknown' }); throw e }
  } finally { await rm(lock, { recursive: true }) }
}
