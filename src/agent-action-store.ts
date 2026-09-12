import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateActions, type AgentAction } from './agent-actions.ts'
import { withPresetLock } from './preset-lock.ts'

export const ACTION_FILE = 'actions.json'
export async function readActions(dir: string): Promise<{ actions: AgentAction[]; revision: string }> {
  let content = ''
  try { content = await readFile(join(dir, ACTION_FILE), 'utf8') } catch (e: any) { if (e.code !== 'ENOENT') throw e }
  const parsed = content ? JSON.parse(content) : { version: 1, actions: [] }
  if (parsed.version !== 1) throw new Error('不支持的 Actions 配置版本')
  return { actions: validateActions(parsed.actions), revision: createHash('sha256').update(content).digest('hex') }
}
export async function saveActions(dir: string, raw: unknown, revision: string) {
  const actions = validateActions(raw)
  return withPresetLock(dir, async () => {
    if (!(await lstat(dir)).isDirectory()) throw new Error('Agent 目录不可写')
    const current = await readActions(dir)
    if (current.revision !== revision) throw new Error('Actions 已被其他页面修改，请重新加载后编辑')
    const staged = join(dir, `.actions-${randomUUID()}.json`)
    try {
      await writeFile(staged, JSON.stringify({ version: 1, actions }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      await rename(staged, join(dir, ACTION_FILE))
    } finally { await rm(staged, { force: true }) }
    return readActions(dir)
  })
}
