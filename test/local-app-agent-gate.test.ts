import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { TaskConsoleService } from '../src/service.ts'

test('local App Agent startup checks ownership and defaults to its bound workspace', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tc-local-app-gate-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => { if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved })
  const preset = join(home, 'preset'), workspace = join(home, 'new-workspace')
  await mkdir(preset); await mkdir(workspace); await mkdir(join(home, 'apps'))
  await writeFile(join(preset, 'task-console.json'), JSON.stringify({
    id: 'fresh-studio', name: 'fresh', description: '', persona: '',
    model: 'p/m', effort: 'medium', permissionPreset: 'workspace-write',
    tools: ['fs'], mcpTools: {}, mcpPolicy: {}, skills: [],
  }))
  await writeFile(join(preset, 'app-owner.json'), JSON.stringify({ appId: 'studio-local', workspace }))
  await writeFile(join(workspace, 'STUDIO_RUNTIME.json'), JSON.stringify({ workspaceRoot: workspace }))
  let created = 0, actualCwd: string | undefined
  const scopes: Context[] = []
  t.after(() => { for (const scope of scopes) scope.fiber.dispose() })
  const ctx = {
    get: (name: string) => {
      if (name === 'agentPresets') return {
        resolve: async () => ({ id: 'fresh-studio', path: join(preset, 'agent.cordis.yml') }),
        mount: async () => {},
      }
      if (name === 'permissionPresets') return { set: () => {} }
    },
    agents: { create: async (options: any) => {
      created++; actualCwd = options.meta.cwd
      const scope = new Context(); scopes.push(scope); await options.setup(scope)
      return { agent: { session: { id: options.sessionId, events: [] }, followup: () => {} } }
    } },
  }
  const service = { ctx, chats: new Map(), workspaces: () => [{ path: home }], defaultModel: () => undefined }
  const start = () => TaskConsoleService.prototype.startAgentSession.call(service as any, JSON.stringify({ agentId: 'fresh-studio' }))
  await assert.rejects(start(), /ENOENT/)
  const receiptFile = join(home, 'apps/studio-local.json')
  const receipt = { status: 'installed', enabled: false, managedAgents: ['fresh-studio'] }
  await writeFile(receiptFile, JSON.stringify(receipt))
  await assert.rejects(start(), /未启用/)
  await writeFile(receiptFile, JSON.stringify({ ...receipt, enabled: true, managedAgents: ['unrelated'] }))
  await assert.rejects(start(), /未启用/)
  await writeFile(receiptFile, JSON.stringify({ ...receipt, enabled: true }))
  await writeFile(join(workspace, 'STUDIO_RUNTIME.json'), JSON.stringify({ workspaceRoot: home }))
  await assert.rejects(start(), /binding/)
  assert.equal(created, 0)
  await writeFile(join(workspace, 'STUDIO_RUNTIME.json'), JSON.stringify({ workspaceRoot: workspace }))
  assert.equal(JSON.parse(await start()).agentPreset, 'fresh-studio')
  assert.equal(created, 1)
  assert.equal(actualCwd, workspace)
})
