/**
 * Agent specs ⇄ preset directories.
 *
 * A dsh agent preset is a directory holding `agent.cordis.yml`; what that
 * file lists is exactly what the model gets — tools not in it have no
 * schema. So the editor's "tool whitelist" is not a policy we enforce, it is
 * the composition we write. This module turns an {@link AgentSpec} into that
 * composition and reads it back.
 *
 * The YAML is templated, not `yaml.stringify`d: the skill row needs a `!!js`
 * tag the library cannot emit, and the shipped `cordis` preset uses the same
 * expression, so it is copied verbatim.
 *
 * @module dsh-task-console/presets
 */

import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { stringify as toYaml } from 'yaml'
import { publicToolName } from './filtered-mcp-client.ts'
import { WORKER_TOOL_NAMES } from './worker-tools.ts'
import type { AgentSpec, NativeTool, Preview, SkillEntry } from './wire.ts'

/** Preset ids become directory names, so containment is a property of the id. */
export const ID_RE = /^[a-z0-9][a-z0-9-]*$/

/** Native tools the editor offers, each mapping to one composition row. */
export const NATIVE_TOOLS: readonly (NativeTool & { rows: string; schemaNames: string[] })[] = [
  { id: 'ask-user', label: 'ask_user_question', group: '交互', writes: false,
    description: '停下来问人。没有它,拿不准的事只能失败重来。',
    schemaNames: ['ask_user_question'],
    rows: "- id: tool-ask-user\n  name: '@deepseek-ai/dsh-tool-ask-user'" },
  { id: 'bash', label: 'bash', group: '本机', writes: true,
    description: '在 dsh 宿主机执行 shell。',
    schemaNames: ['bash'],
    rows: "- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n  disabled: !!js process.platform === 'win32'" },
  { id: 'fs', label: 'read / write / edit / read_image', group: '本机', writes: true,
    description: '读写改文件并读取本地图片。',
    schemaNames: ['edit', 'read', 'read_image', 'write'],
    rows: "- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'" },
  { id: 'fs-search', label: 'glob / grep', group: '本机', writes: false,
    description: '找文件、搜内容,只读。',
    schemaNames: ['glob', 'grep'],
    rows: "- id: tool-fs-search\n  name: '@deepseek-ai/dsh-tool-fs-search'\n  config:\n    sampleOverCapGlobResults: false" },
  { id: 'str-replace-editor', label: 'str_replace_editor', group: '本机', writes: true,
    description: '精确替换式编辑器。',
    schemaNames: ['str_replace_editor'],
    rows: "- id: tool-str-replace-editor\n  name: '@deepseek-ai/dsh-tool-str-replace-editor'" },
  { id: 'web', label: 'web_search / fetch', group: '网络', writes: false,
    description: '搜网页、抓页面。',
    schemaNames: ['web_fetch', 'web_search'],
    rows: "- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'" },
  { id: 'jobs', label: 'job_list / job_output / job_kill', group: '本机', writes: false,
    description: '收后台任务的输出、停掉它。',
    schemaNames: ['job_kill', 'job_list', 'job_output'],
    rows: "- id: tool-jobs\n  name: '@deepseek-ai/dsh-tool-jobs'" },
  { id: 'todo', label: 'todo_write', group: '交互', writes: false,
    description: '给自己记待办。',
    schemaNames: ['todo_write'],
    rows: "- id: tool-todo\n  name: '@deepseek-ai/dsh-tool-todo'\n  config:\n    allowParallelInProgress: true" },
  { id: 'fleet-onboard-runtime', label: 'Fleet onboard runtime', group: 'Fleet', writes: true,
    description: '确定性的节点评估、事务恢复与报告；不向模型暴露任意 shell。',
    schemaNames: ['fleet_onboard_start', 'fleet_onboard_status', 'fleet_onboard_resume', 'fleet_onboard_report'],
    rows: "- id: fleet-onboard-runtime\n  name: 'dsh-task-console/fleet-onboard-tools'" },
]

/** Tools that make an agent "可写" rather than merely "受限可写". */
const DANGEROUS = new Set(['bash', 'fs', 'str-replace-editor'])

/** Session-local tools registered only by the managed Task Intake coordinator. */
const TASK_INTAKE_SESSION_TOOLS = ['task_intake_context', 'task_intake_decide'] as const

/** Where a person's own presets live (dsh derives the same root). */
export function userPresetRoot(home = homedir()): string {
  return join(process.env.DSH_HOME ?? join(home, '.dsh'), '.agent-presets')
}

/** Skill roots the editor can copy from, in the order dsh ranks them. */
export function skillRoots(home = homedir()): { root: string; label: string }[] {
  return [
    { root: join(process.env.DSH_HOME ?? join(home, '.dsh'), 'skills'), label: 'user-dsh' },
    { root: join(process.env.DSH_AGENTS_HOME ?? join(home, '.agents'), 'skills'), label: 'user-agents' },
  ]
}

/** Read `name`/`description` out of a SKILL.md frontmatter, tolerantly. */
function frontmatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line)
    if (kv) out[kv[1] as 'name' | 'description'] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

/** Every skill bundle under the user roots. */
export async function scanSkills(home = homedir()): Promise<SkillEntry[]> {
  const rows: SkillEntry[] = []
  for (const { root, label } of skillRoots(home)) {
    let names: string[] = []
    try { names = await readdir(root) } catch { continue }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue
      const dir = join(root, name)
      try {
        if (!(await stat(dir)).isDirectory()) continue
        const text = await readFile(join(dir, 'SKILL.md'), 'utf8')
        const fm = frontmatter(text)
        rows.push({ name: fm.name ?? name, dir, description: fm.description ?? '', root: label })
      } catch { /* not a bundle */ }
    }
  }
  return rows
}

/** Which permission the selected tools add up to. */
export function permissionOf(spec: Pick<AgentSpec, 'tools' | 'mcpTools'>, mcpWrites: (server: string, tool: string) => boolean): Preview['permission'] {
  const native = spec.tools.map(id => NATIVE_TOOLS.find(t => t.id === id)).filter(Boolean) as NativeTool[]
  if (native.some(t => DANGEROUS.has(t.id))) return 'write'
  if (native.some(t => t.writes) || Object.entries(spec.mcpTools).some(([server, tools]) => tools.some(tool => mcpWrites(server, tool)))) return 'limited-write'
  return 'read-only'
}

/** Indent every line of a block by `n` spaces. */
function indent(text: string, n: number): string {
  const pad = ' '.repeat(n)
  return text.split('\n').map(l => (l.length ? pad + l : l)).join('\n')
}

/** Hide bearer tokens and URL credentials wherever they appear in YAML text. */
export function mask(text: string): string {
  return text
    .replace(/(Authorization:\s*)(["']?)Bearer\s+\S+/gi, '$1$2Bearer ••••')
    .replace(/((?:token|secret|password|api[-_]?key)\s*:\s*)(["']?)[^\s"'#]+/gi, '$1$2••••')
    .replace(/\/\/[^@\s/]+@/g, '//••••@')
}

/** Host MCP entries the generator copies rows from. */
export interface HostMcp {
  serverName: string
  /** Loader entry holding the real transport configuration. New presets persist only this reference. */
  sourceEntryId?: string
  /** Raw tools currently advertised by this server. */
  tools?: string[]
  /** Legacy inline config. New generated presets reference sourceEntryId instead of copying it. */
  config: Record<string, unknown>
  /** Whether the host still runs it, which forces a rename to avoid the name clash. */
  live: boolean
}

/** Render `agent.cordis.yml` for a spec. Pure; the caller writes it. */
export function renderComposition(spec: AgentSpec, hostMcp: HostMcp[], inheritedTools: string[] = []): Preview {
  const parts: string[] = []
  const renamed: Preview['renamed'] = []
  const allowedToolNames = new Set<string>()
  parts.push(`# ${spec.name || spec.id} — 由 dsh-task-console 生成。可以直接改;dsh 热读取 preset 根,保存即生效。`)
  parts.push(`# 只有列在这里的工具会有 schema;没写的,模型看不到。`)

  const persona = (spec.persona.trim() || '你是一个助手。').split('\n').map(l => '      ' + l).join('\n')
  parts.push(`- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: |-\n${persona}`)

  for (const id of spec.tools) {
    const tool = NATIVE_TOOLS.find(t => t.id === id)
    if (tool) {
      parts.push(tool.rows)
      for (const name of tool.schemaNames) allowedToolNames.add(name)
    }
  }

  for (const [serverName, selected] of Object.entries(spec.mcpTools)) {
    const host = hostMcp.find(h => h.serverName === serverName)
    if (!host) { parts.push(`# mcp ${serverName}: 宿主里没有这个服务,跳过`); continue }
    const allowedTools = selected.includes('*') ? host.tools ?? [] : selected
    if (!allowedTools.length) { parts.push(`# mcp ${serverName}: 没有选择工具,跳过`); continue }
    let name = serverName
    if (host.live) { name = `${serverName}-${spec.id}`; renamed.push({ from: serverName, to: name }) }
    for (const tool of allowedTools) allowedToolNames.add(publicToolName(name, tool))
    const toolRules = spec.mcpPolicy[serverName] ?? {}
    // Never copy credentials or transport headers into a generated preset.
    // The scoped adapter resolves the authoritative host entry at mount time.
    const config = host.sourceEntryId
      ? { sourceEntryId: host.sourceEntryId, serverName: name, allowedTools, ...(Object.keys(toolRules).length ? { toolRules } : {}) }
      : { ...host.config, serverName: name, allowedTools, ...(Object.keys(toolRules).length ? { toolRules } : {}) }
    const body = toYaml(config, { lineWidth: 0 }).trimEnd()
    parts.push(`${host.live ? `# 宿主层仍有同名 ${serverName},preset 围栏会隐藏宿主副本\n` : ''}- id: mcp-${name}\n  name: 'dsh-task-console/filtered-mcp-client'\n  config:\n${indent(body, 4)}`)
  }

  if (spec.skills.length) {
    allowedToolNames.add('skill')
    parts.push(`# skills/ 随 preset 走;baseUrl 是 preset 自己的目录\n- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'\n  config:\n    providerName: preset-${spec.id}\n    includeDefaultRoots: false\n    customSkillDirs:\n      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"\n- id: tool-skill\n  name: '@deepseek-ai/dsh-tool-skill'`)
  }

  // Preset plugins are ancestor scopes of the final Agent tool view. The fence
  // snapshots current inherited names into a deny-list, while its guard keeps
  // later registrations fail-closed. Task terminators are admitted only when
  // the runner registers them inside a task-owned session.
  void inheritedTools // retained as an API-compatible argument for older callers
  for (const name of WORKER_TOOL_NAMES) allowedToolNames.add(name)
  if (spec.id === 'task-intake') for (const name of TASK_INTAKE_SESSION_TOOLS) allowedToolNames.add(name)
  const fence = toYaml({ selected: [...allowedToolNames].sort() }, { lineWidth: 0 }).trimEnd()
  parts.push(`- id: inherited-tool-fence\n  name: 'dsh-task-console/agent-tool-fence'\n  config:\n${indent(fence, 4)}`)

  return { yml: parts.join('\n\n') + '\n', renamed, permission: permissionOf(spec, () => true) }
}

/** The spec file we keep beside the composition. */
const SPEC_FILE = 'task-console.json'
export const SKILL_LOCK_FILE = 'skills.lock.json'

export interface SkillLockEntry {
  name: string
  sourceRoot: string
  sourceBasename: string
  sha256: string
}

export interface SkillCopyStatus {
  name: string
  status: 'in-sync' | 'unlocked' | 'missing-source' | 'missing-copy' | 'source-drift' | 'copy-drift' | 'source-and-copy-drift'
  lockedSha256?: string
  sourceSha256?: string
  copySha256?: string
}

interface SkillLock { version: 1; skills: SkillLockEntry[] }

function managedSkillEntry(name: string): boolean {
  return name !== '__pycache__' && name !== '.DS_Store' && !name.endsWith('.pyc') && !name.endsWith('.pyo')
}

function selectedSkill(specName: string, library: SkillEntry[]): SkillEntry | undefined {
  return library.find(skill => skill.name === specName) ?? library.find(skill => basename(skill.dir) === specName)
}

/** Stable content digest of a skill tree; paths and bytes count, timestamps do not. */
export async function hashSkillTree(root: string): Promise<string> {
  const digest = createHash('sha256')
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (!managedSkillEntry(entry.name)) continue
      const path = join(dir, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const info = await stat(path) // follows selected skill symlinks, matching cp({ dereference: true })
      if (info.isDirectory()) {
        digest.update(`d\0${relative}\0`)
        await walk(path, relative)
      } else if (info.isFile()) {
        const body = await readFile(path)
        digest.update(`f\0${relative}\0${body.length}\0`)
        digest.update(body)
      }
    }
  }
  await walk(root, '')
  return digest.digest('hex')
}

function parseSkillLock(raw: string): SkillLock | null {
  try {
    const value = JSON.parse(raw) as Partial<SkillLock>
    if (value.version !== 1 || !Array.isArray(value.skills)) return null
    if (value.skills.some(row => !row || typeof row.name !== 'string' || typeof row.sourceRoot !== 'string' || typeof row.sourceBasename !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256))) return null
    return value as SkillLock
  } catch { return null }
}

/** Compare selected source skills, copied preset skills, and the save-time lock. */
export async function verifyPresetSkills(spec: Pick<AgentSpec, 'skills'>, library: SkillEntry[], dir: string): Promise<SkillCopyStatus[]> {
  const lock = await readFile(join(dir, SKILL_LOCK_FILE), 'utf8').then(parseSkillLock).catch(() => null)
  const locked = new Map((lock?.skills ?? []).map(row => [row.name, row]))
  const rows: SkillCopyStatus[] = []
  for (const name of spec.skills) {
    const source = selectedSkill(name, library)
    const copied = join(dir, 'skills', source ? basename(source.dir) : name)
    const sourceSha256 = source ? await hashSkillTree(source.dir).catch(() => undefined) : undefined
    const copySha256 = await hashSkillTree(copied).catch(() => undefined)
    const lockedSha256 = locked.get(name)?.sha256
    let status: SkillCopyStatus['status']
    if (!sourceSha256) status = 'missing-source'
    else if (!copySha256) status = 'missing-copy'
    else if (!lockedSha256) status = 'unlocked'
    else if (sourceSha256 !== lockedSha256 && copySha256 !== lockedSha256) status = 'source-and-copy-drift'
    else if (sourceSha256 !== lockedSha256) status = 'source-drift'
    else if (copySha256 !== lockedSha256) status = 'copy-drift'
    else status = 'in-sync'
    rows.push({ name, status, ...(lockedSha256 ? { lockedSha256 } : {}), ...(sourceSha256 ? { sourceSha256 } : {}), ...(copySha256 ? { copySha256 } : {}) })
  }
  return rows
}

/** Replace only a preset's copied skills and lock; never touches MCP config or credentials. */
export async function syncPresetSkills(spec: Pick<AgentSpec, 'skills'>, library: SkillEntry[], dir: string): Promise<SkillLock> {
  const sources = spec.skills.map(name => {
    const entry = selectedSkill(name, library)
    if (!entry) throw new Error(`Skill 不存在:${name}`)
    return { name, entry }
  })
  const skillsDir = join(dir, 'skills')
  const lockPath = join(dir, SKILL_LOCK_FILE)
  const staged = join(dir, `.skills-next-${randomUUID()}`)
  const stagedLock = join(dir, `.skills-lock-next-${randomUUID()}`)
  const backup = join(dir, `.skills-backup-${randomUUID()}`)
  const backupLock = join(dir, `.skills-lock-backup-${randomUUID()}`)
  const lock: SkillLock = { version: 1, skills: [] }
  let skillsBackedUp = false
  let lockBackedUp = false
  let newSkillsInstalled = false
  let newLockInstalled = false
  await mkdir(staged, { recursive: true, mode: 0o700 })
  try {
    for (const { name, entry } of sources) {
      const target = join(staged, basename(entry.dir))
      await cp(entry.dir, target, {
        recursive: true,
        dereference: true,
        filter: source => managedSkillEntry(basename(source)),
      })
      const sourceSha256 = await hashSkillTree(entry.dir)
      const copySha256 = await hashSkillTree(target)
      if (sourceSha256 !== copySha256) throw new Error(`Skill 拷贝校验失败:${name}`)
      lock.skills.push({ name, sourceRoot: entry.root, sourceBasename: basename(entry.dir), sha256: sourceSha256 })
    }
    await writeFile(stagedLock, JSON.stringify(lock, null, 2) + '\n', { mode: 0o600 })
    const hadSkills = await stat(skillsDir).then(() => true).catch(() => false)
    const hadLock = await stat(lockPath).then(() => true).catch(() => false)
    if (hadSkills) { await rename(skillsDir, backup); skillsBackedUp = true }
    if (hadLock) { await rename(lockPath, backupLock); lockBackedUp = true }
    try {
      if (sources.length) { await rename(staged, skillsDir); newSkillsInstalled = true }
      else await rm(staged, { recursive: true, force: true })
      await rename(stagedLock, lockPath); newLockInstalled = true
    } catch (error) {
      if (newSkillsInstalled) await rm(skillsDir, { recursive: true, force: true })
      if (newLockInstalled) await rm(lockPath, { force: true })
      if (skillsBackedUp) { await rename(backup, skillsDir); skillsBackedUp = false }
      if (lockBackedUp) { await rename(backupLock, lockPath); lockBackedUp = false }
      throw error
    }
    if (skillsBackedUp) { await rm(backup, { recursive: true, force: true }); skillsBackedUp = false }
    if (lockBackedUp) { await rm(backupLock, { force: true }); lockBackedUp = false }
    return lock
  } catch (error) {
    await rm(staged, { recursive: true, force: true })
    await rm(stagedLock, { force: true })
    // If restoring the original copy failed, keep the backups for recovery.
    if (!skillsBackedUp) await rm(backup, { recursive: true, force: true })
    if (!lockBackedUp) await rm(backupLock, { force: true })
    throw error
  }
}

export function validateSpec(raw: unknown): AgentSpec {
  const s = (raw ?? {}) as Partial<AgentSpec> & { mcp?: unknown }
  const id = String(s.id ?? '').trim()
  if (!ID_RE.test(id)) throw new Error('id 只能用 a-z 0-9 和 -,且以字母或数字开头')
  const name = String(s.name ?? '').trim()
  if (!name) throw new Error('名字必填')
  const list = (v: unknown) => Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))] : []
  const effort = s.effort === 'low' || s.effort === 'medium' || s.effort === 'high' ? s.effort : ''
  const permissionPreset = s.permissionPreset === 'danger-full-access' ? 'danger-full-access' : 'workspace-write'
  const mcpTools: Record<string, string[]> = {}
  if (s.mcpTools && typeof s.mcpTools === 'object' && !Array.isArray(s.mcpTools)) {
    for (const [server, tools] of Object.entries(s.mcpTools)) {
      const clean = list(tools)
      if (server.trim() && clean.length) mcpTools[server.trim()] = clean
    }
  } else {
    // 0.18 and earlier persisted whole-server selections as `mcp: string[]`.
    for (const server of list(s.mcp)) mcpTools[server] = ['*']
  }
  const mcpPolicy: AgentSpec['mcpPolicy'] = {}
  if (s.mcpPolicy && typeof s.mcpPolicy === 'object' && !Array.isArray(s.mcpPolicy)) {
    for (const [server, policies] of Object.entries(s.mcpPolicy)) {
      if (!policies || typeof policies !== 'object' || Array.isArray(policies)) continue
      const serverPolicies: AgentSpec['mcpPolicy'][string] = {}
      for (const [tool, candidate] of Object.entries(policies)) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
        const rule = candidate as { requiredArguments?: unknown; valuesOrPrefixes?: unknown; patterns?: unknown }
        const cleanMap = (value: unknown): Record<string, string[]> => {
          const out: Record<string, string[]> = {}
          if (!value || typeof value !== 'object' || Array.isArray(value)) return out
          for (const [argument, choices] of Object.entries(value)) {
            const clean = list(choices)
            if (argument.trim() && clean.length) out[argument.trim()] = clean
          }
          return out
        }
        const patterns: Record<string, string> = {}
        if (rule.patterns && typeof rule.patterns === 'object' && !Array.isArray(rule.patterns)) {
          for (const [argument, pattern] of Object.entries(rule.patterns)) if (argument.trim() && typeof pattern === 'string' && pattern) {
            try { new RegExp(pattern) } catch { throw new Error(`MCP policy regex 无效:${server}/${tool}/${argument}`) }
            patterns[argument.trim()] = pattern
          }
        }
        const valuesOrPrefixes = cleanMap(rule.valuesOrPrefixes)
        const requiredArguments = list(rule.requiredArguments)
        if (requiredArguments.length || Object.keys(valuesOrPrefixes).length || Object.keys(patterns).length) serverPolicies[tool] = {
          ...(requiredArguments.length ? { requiredArguments } : {}),
          ...(Object.keys(valuesOrPrefixes).length ? { valuesOrPrefixes } : {}),
          ...(Object.keys(patterns).length ? { patterns } : {}),
        }
      }
      if (Object.keys(serverPolicies).length) mcpPolicy[server] = serverPolicies
    }
  }
  return {
    id, name,
    description: String(s.description ?? '').trim(),
    persona: String(s.persona ?? ''),
    model: String(s.model ?? '').trim(),
    effort,
    permissionPreset,
    tools: list(s.tools).filter(t => NATIVE_TOOLS.some(n => n.id === t)),
    mcpTools,
    mcpPolicy,
    skills: list(s.skills),
  }
}

/** Write (or rewrite) one preset directory from a spec. Returns its path. */
export async function writePreset(spec: AgentSpec, hostMcp: HostMcp[], library: SkillEntry[], root = userPresetRoot(), inheritedTools: string[] = []): Promise<{ path: string; preview: Preview }> {
  const dir = resolve(root, spec.id)
  if (!dir.startsWith(resolve(root) + '/')) throw new Error('非法 id')
  // Fail before changing any authored files if a selected source vanished.
  for (const name of spec.skills) if (!selectedSkill(name, library)) throw new Error(`Skill 不存在:${name}`)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700).catch(() => undefined)

  const preview = renderComposition(spec, hostMcp, inheritedTools)
  const staged = resolve(root, `.${spec.id}-next-${randomUUID()}`)
  const backup = resolve(root, `.${spec.id}-backup-${randomUUID()}`)
  let backedUp = false
  await mkdir(staged, { recursive: true, mode: 0o700 })
  try {
    await writeFile(join(staged, 'agent.cordis.yml'), preview.yml, { mode: 0o600 })
    await writeFile(join(staged, 'preset.yml'), `name: ${JSON.stringify(spec.name)}\ndescription: ${JSON.stringify(spec.description)}\n`, { mode: 0o600 })
    await writeFile(join(staged, SPEC_FILE), JSON.stringify(spec, null, 2) + '\n', { mode: 0o600 })
    await syncPresetSkills(spec, library, staged)
    const existed = await stat(dir).then(() => true).catch(() => false)
    if (existed) { await rename(dir, backup); backedUp = true }
    try {
      await rename(staged, dir)
    } catch (error) {
      if (backedUp) { await rename(backup, dir); backedUp = false }
      throw error
    }
    if (backedUp) { await rm(backup, { recursive: true, force: true }); backedUp = false }
  } catch (error) {
    await rm(staged, { recursive: true, force: true })
    // Keep an irreplaceable backup if restoration itself failed.
    if (!backedUp) await rm(backup, { recursive: true, force: true })
    throw error
  }
  return { path: dir, preview }
}

/** Our spec for a preset directory, when we authored it. */
export async function readSpec(dir: string): Promise<AgentSpec | null> {
  try { return validateSpec(JSON.parse(await readFile(join(dir, SPEC_FILE), 'utf8'))) } catch { return null }
}

/** Delete one authored preset directory. */
export async function removePreset(id: string, root = userPresetRoot()): Promise<void> {
  if (!ID_RE.test(id)) throw new Error('非法 id')
  const dir = resolve(root, id)
  if (!dir.startsWith(resolve(root) + '/')) throw new Error('非法 id')
  await rm(dir, { recursive: true, force: true })
}
