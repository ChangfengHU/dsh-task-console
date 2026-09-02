import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyAgentPermission } from '../src/agent-session.ts'
import { TaskConsoleService } from '../src/service.ts'

test('applyAgentPermission pins the authored preset and fails closed without the DSH service', () => {
  const calls: string[] = []
  const session = { id: 's', events: [] }
  const spec = { permissionPreset: 'danger-full-access' } as any
  applyAgentPermission({ get: () => ({ set: (target: unknown, name: string) => calls.push(`${target === session}:${name}`) }) }, spec, session)
  assert.deepEqual(calls, ['true:danger-full-access'])
  assert.throws(() => applyAgentPermission({ get: () => undefined }, spec, session), /没有会话权限服务/)
})

test('startAgentSession applies permission before dispatching the first user message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tc-permission-'))
  const presetDir = join(root, 'fleet-installer')
  await mkdir(presetDir)
  await writeFile(join(presetDir, 'task-console.json'), JSON.stringify({
    id: 'fleet-installer', name: '装机者', description: '', persona: '', model: 'p/m', effort: 'high',
    permissionPreset: 'danger-full-access', tools: ['bash'], mcpTools: {}, mcpPolicy: {}, skills: [],
  }))
  const order: string[] = []
  const session = { id: 'pending', events: [] }
  const handle = {
    agent: {
      session,
      followup: () => { order.push('followup') },
    },
    dispose: async () => { order.push('dispose') },
  }
  const ctx = {
    agents: { create: async (options: any) => {
      session.id = options.sessionId
      order.push('create')
      await options.setup({})
      return handle
    } },
    get: (name: string) => {
      if (name === 'agentPresets') return {
        resolve: async () => ({ id: 'fleet-installer', name: '装机者', path: join(presetDir, 'agent.cordis.yml') }),
        mount: async () => { order.push('mount') },
      }
      if (name === 'permissionPresets') return { set: (_session: unknown, preset: string) => order.push(`permission:${preset}`) }
      return undefined
    },
  }
  const service = {
    ctx,
    chats: new Map(),
    workspaces: () => [{ path: root }],
    defaultModel: () => ({ provider: 'p', model: 'm' }),
  }
  const value = await TaskConsoleService.prototype.startAgentSession.call(service as any, JSON.stringify({
    agentId: 'fleet-installer', text: '开始', cwd: root,
  }))
  assert.equal(JSON.parse(value).agentPreset, 'fleet-installer')
  assert.deepEqual(order, ['create', 'mount', 'permission:danger-full-access', 'followup'])
})
