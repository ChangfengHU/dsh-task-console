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

import { cp, mkdir, readFile, readdir, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { stringify as toYaml } from 'yaml'
import type { AgentSpec, NativeTool, Preview, SkillEntry } from './wire.ts'

/** Preset ids become directory names, so containment is a property of the id. */
export const ID_RE = /^[a-z0-9][a-z0-9-]*$/

/** Native tools the editor offers, each mapping to one composition row. */
export const NATIVE_TOOLS: readonly (NativeTool & { rows: string })[] = [
  { id: 'ask-user', label: 'ask_user_question', group: '交互', writes: false,
    description: '停下来问人。没有它,拿不准的事只能失败重来。',
    rows: "- id: tool-ask-user\n  name: '@deepseek-ai/dsh-tool-ask-user'" },
  { id: 'bash', label: 'bash', group: '本机', writes: true,
    description: '在 dsh 宿主机执行 shell。',
    rows: "- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n  disabled: !!js process.platform === 'win32'" },
  { id: 'fs', label: 'read / write / edit', group: '本机', writes: true,
    description: '读写改文件。',
    rows: "- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'" },
  { id: 'fs-search', label: 'glob / grep', group: '本机', writes: false,
    description: '找文件、搜内容,只读。',
    rows: "- id: tool-fs-search\n  name: '@deepseek-ai/dsh-tool-fs-search'\n  config:\n    sampleOverCapGlobResults: false" },
  { id: 'str-replace-editor', label: 'str_replace_editor', group: '本机', writes: true,
    description: '精确替换式编辑器。',
    rows: "- id: tool-str-replace-editor\n  name: '@deepseek-ai/dsh-tool-str-replace-editor'" },
  { id: 'web', label: 'web_search / fetch', group: '网络', writes: false,
    description: '搜网页、抓页面。',
    rows: "- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'" },
  { id: 'jobs', label: 'job_list / job_output / job_kill', group: '本机', writes: false,
    description: '收后台任务的输出、停掉它。',
    rows: "- id: tool-jobs\n  name: '@deepseek-ai/dsh-tool-jobs'" },
  { id: 'todo', label: 'todo_write', group: '交互', writes: false,
    description: '给自己记待办。',
    rows: "- id: tool-todo\n  name: '@deepseek-ai/dsh-tool-todo'" },
]

/** Tools that make an agent "可写" rather than merely "受限可写". */
const DANGEROUS = new Set(['bash', 'fs', 'str-replace-editor'])

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
export function permissionOf(spec: Pick<AgentSpec, 'tools' | 'mcp'>, mcpWrites: (server: string) => boolean): Preview['permission'] {
  const native = spec.tools.map(id => NATIVE_TOOLS.find(t => t.id === id)).filter(Boolean) as NativeTool[]
  if (native.some(t => DANGEROUS.has(t.id))) return 'write'
  if (native.some(t => t.writes) || spec.mcp.some(mcpWrites)) return 'limited-write'
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
  /** The entry's full `config` block, headers included — copied verbatim. */
  config: Record<string, unknown>
  /** Whether the host still runs it, which forces a rename to avoid the name clash. */
  live: boolean
}

/** Render `agent.cordis.yml` for a spec. Pure; the caller writes it. */
export function renderComposition(spec: AgentSpec, hostMcp: HostMcp[]): Preview {
  const parts: string[] = []
  const renamed: Preview['renamed'] = []
  parts.push(`# ${spec.name || spec.id} — 由 dsh-task-console 生成。可以直接改;dsh 热读取 preset 根,保存即生效。`)
  parts.push(`# 只有列在这里的工具会有 schema;没写的,模型看不到。`)

  const persona = (spec.persona.trim() || '你是一个助手。').split('\n').map(l => '      ' + l).join('\n')
  parts.push(`- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: |-\n${persona}`)

  for (const id of spec.tools) {
    const tool = NATIVE_TOOLS.find(t => t.id === id)
    if (tool) parts.push(tool.rows)
  }

  for (const serverName of spec.mcp) {
    const host = hostMcp.find(h => h.serverName === serverName)
    if (!host) { parts.push(`# mcp ${serverName}: 宿主里没有这个服务,跳过`); continue }
    let name = serverName
    if (host.live) { name = `${serverName}-${spec.id}`; renamed.push({ from: serverName, to: name }) }
    const config = { ...host.config, serverName: name }
    const body = toYaml(config, { lineWidth: 0 }).trimEnd()
    parts.push(`${host.live ? `# 宿主层仍有同名 ${serverName},改名挂载;宿主那行摘掉后可改回\n` : ''}- id: mcp-${name}\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n${indent(body, 4)}`)
  }

  if (spec.skills.length) {
    parts.push(`# skills/ 随 preset 走;baseUrl 是 preset 自己的目录\n- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'\n  config:\n    providerName: preset-${spec.id}\n    includeDefaultRoots: false\n    customSkillDirs:\n      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"\n- id: tool-skill\n  name: '@deepseek-ai/dsh-tool-skill'`)
  }

  return { yml: parts.join('\n\n') + '\n', renamed, permission: permissionOf(spec, () => false) }
}

/** The spec file we keep beside the composition. */
const SPEC_FILE = 'task-console.json'

export function validateSpec(raw: unknown): AgentSpec {
  const s = (raw ?? {}) as Partial<AgentSpec>
  const id = String(s.id ?? '').trim()
  if (!ID_RE.test(id)) throw new Error('id 只能用 a-z 0-9 和 -,且以字母或数字开头')
  const name = String(s.name ?? '').trim()
  if (!name) throw new Error('名字必填')
  const list = (v: unknown) => Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))] : []
  const effort = s.effort === 'low' || s.effort === 'medium' || s.effort === 'high' ? s.effort : ''
  return {
    id, name,
    description: String(s.description ?? '').trim(),
    persona: String(s.persona ?? ''),
    model: String(s.model ?? '').trim(),
    effort,
    tools: list(s.tools).filter(t => NATIVE_TOOLS.some(n => n.id === t)),
    mcp: list(s.mcp),
    skills: list(s.skills),
  }
}

/** Write (or rewrite) one preset directory from a spec. Returns its path. */
export async function writePreset(spec: AgentSpec, hostMcp: HostMcp[], library: SkillEntry[], root = userPresetRoot()): Promise<{ path: string; preview: Preview }> {
  const dir = resolve(root, spec.id)
  if (!dir.startsWith(resolve(root) + '/')) throw new Error('非法 id')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700).catch(() => undefined)

  const preview = renderComposition(spec, hostMcp)
  await writeFile(join(dir, 'agent.cordis.yml'), preview.yml, { mode: 0o600 })
  await writeFile(join(dir, 'preset.yml'), `name: ${JSON.stringify(spec.name)}\ndescription: ${JSON.stringify(spec.description)}\n`, { mode: 0o600 })
  await writeFile(join(dir, SPEC_FILE), JSON.stringify(spec, null, 2) + '\n', { mode: 0o600 })

  // skills/: exactly the chosen bundles, nothing stale from a previous save.
  const skillsDir = join(dir, 'skills')
  await rm(skillsDir, { recursive: true, force: true })
  if (spec.skills.length) {
    await mkdir(skillsDir, { recursive: true, mode: 0o700 })
    for (const name of spec.skills) {
      const entry = library.find(s => s.name === name) ?? library.find(s => basename(s.dir) === name)
      if (!entry) continue
      await cp(entry.dir, join(skillsDir, basename(entry.dir)), { recursive: true, dereference: true })
    }
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
