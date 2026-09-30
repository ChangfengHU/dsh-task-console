/** Configuration assets only. No command execution, dependency installation or credentials. */
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { parseDocument, isSeq } from 'yaml'

export const MAX_ASSET_BYTES = 24 * 1024 * 1024
export const MAX_FILE_BYTES = 4 * 1024 * 1024
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export interface AssetFile { path: string; base64: string; sha256: string; executable: boolean; contentRef?: string }
export interface SkillAsset { name: string; agentId?: string; files: AssetFile[]; filesRef?: string }
export interface SecretRef { path: string; ref: string }
export interface HostConfigAsset {
  id: string; module: string; kind: 'mcp' | 'model' | 'plugin'; config: Record<string, unknown>
  wasDisabled: boolean; secrets: SecretRef[]
  tools: string[]
}
export interface ConfigAssets {
  schema: 'dsh-task-console/assets-v1'
  skills: SkillAsset[]
  hostConfigs: HostConfigAsset[]
  models: { defaultSelection: { provider: string; model: string } | null; providers: { id: string; models: string[] }[] }
  requirements: { module: string; version: string }[]
}
const skillKey = (s: SkillAsset) => `${s.agentId ?? 'library'}/${s.name}`
/** Same-name Skills with different bytes remain separate; only byte-identical trees share storage. */
export function deduplicateSkills(skills: SkillAsset[]): SkillAsset[] {
  const seen = new Map<string, string>()
  const blobs = new Set<string>()
  return skills.map(s => {
    const digest = hash(Buffer.from(JSON.stringify(s.files))), ref = seen.get(digest)
    if (ref) return { name: s.name, ...(s.agentId ? { agentId: s.agentId } : {}), files: [], filesRef: ref }
    seen.set(digest, skillKey(s))
    return { ...s, files: s.files.map(f => { if (blobs.has(f.sha256)) return { path: f.path, base64: '', sha256: f.sha256, executable: f.executable, contentRef: f.sha256 }; blobs.add(f.sha256); return f }) }
  })
}
export function materializeSkills(skills: SkillAsset[]): SkillAsset[] {
  const source = new Map<string, AssetFile[]>()
  const blobs = new Map<string, string>()
  return skills.map(s => {
    const rows = s.filesRef ? source.get(s.filesRef) : s.files; if (!rows) throw Error('Skill 文件引用不存在')
    const files = rows.map(f => { const base64 = f.contentRef ? blobs.get(f.contentRef) : f.base64; if (base64 === undefined) throw Error('Skill 文件内容引用不存在'); blobs.set(f.sha256, base64); return { path: f.path, base64, sha256: f.sha256, executable: f.executable } })
    source.set(skillKey(s), files); return { name: s.name, ...(s.agentId ? { agentId: s.agentId } : {}), files }
  })
}
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/
const SECRET_KEY = /token|secret|password|passwd|api.?key|authorization|cookie|credential|private.?key/i
const TOKEN_METRICS = /^(?:max[_-]?(?:input[_-]?|output[_-]?)?tokens|token(?:Budget|Limit|Count)|(?:total|prompt|completion)Tokens)$/i
const IGNORED = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store', '.dsm-backup', '.venv', 'venv'])
const PORTABLE_DOTFILES = new Set(['.gitignore', '.gitattributes', '.editorconfig', '.keep'])

export function assetPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || isAbsolute(value) || /[\\\x00-\x1f:]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.') && !PORTABLE_DOTFILES.has(p))) throw Error('资产文件路径不安全')
  return value
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !NAME.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw Error('资产名称无效')
  return value
}

/** Remove secret-bearing fields, headers/env values and opaque argument vectors.
 * CLI args can contain positional tokens, so preserve them as a private host reference,
 * not by guessing that only --token is sensitive. Rebind on the destination. */
export function portableHostConfig(id: string, module: string, kind: HostConfigAsset['kind'], config: Record<string, unknown>, wasDisabled = false, tools: string[] = []): HostConfigAsset {
  const secrets: SecretRef[] = []
  const omit = (path: string) => { secrets.push({ path, ref: `host-config:${id}:${path}` }); return null }
  const walk = (v: any, path: string, key: string): any => {
    if (v === undefined) return null
    if (TOKEN_METRICS.test(key) && typeof v === 'number' && Number.isFinite(v)) return v
    if (SECRET_KEY.test(key) || key === 'args' || key === 'headers' || key === 'env') return omit(path)
    if (typeof v === 'string') {
      if (/Bearer\s+\S+|-----BEGIN .*PRIVATE KEY-----/i.test(v)) return omit(path)
      if (/^https?:\/\//i.test(v)) {
        try { const url = new URL(v); if (url.username || url.password || url.search || url.hash) return omit(path) } catch { return omit(path) }
      }
      return v
    }
    if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return v
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}.${i}`, String(i)))
    if (v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, path ? `${path}.${k}` : k, k)]))
    throw Error(`配置 ${id}/${path} 不是可迁移 JSON；不读取宿主对象`)
  }
  return { id, module, kind, config: walk(config, '', ''), wasDisabled, secrets, tools }
}

export async function collectSkillAsset(skillName: string, dir: string, agentId?: string): Promise<SkillAsset> {
  name(skillName); if (agentId) name(agentId)
  const root = await realpath(dir), files: AssetFile[] = []
  let bytes = 0
  async function walk(current: string, prefix: string, depth: number) {
    if (depth > 20) throw Error(`Skill ${skillName} 目录过深`)
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED.has(entry.name) || entry.name.endsWith('.pyc')) continue
      if (entry.name.startsWith('.') && !PORTABLE_DOTFILES.has(entry.name)) throw Error(`Skill ${skillName} 含隐藏文件 ${entry.name}；请移出凭据/运行状态后导出`)
      const path = assetPath(prefix ? `${prefix}/${entry.name}` : entry.name), full = join(current, entry.name)
      const stat = await lstat(full)
      if (stat.isSymbolicLink()) throw Error(`Skill ${skillName}/${path} 是软链接；请先将所需资源整理为普通文件`)
      if (stat.isDirectory()) { await walk(full, path, depth + 1); continue }
      if (!stat.isFile()) throw Error(`Skill ${skillName}/${path} 不是普通文件`)
      if (stat.size > MAX_FILE_BYTES || bytes + stat.size > MAX_ASSET_BYTES || files.length >= 3000) throw Error('Skill 资产超过大小或文件数量限制')
      const data = await readFile(full); bytes += data.length
      if (/-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----|(?:Authorization\s*[:=]\s*["']?Bearer\s+)[A-Za-z0-9_./+-]{20,}/i.test(data.toString('utf8'))) throw Error(`Skill ${skillName}/${path} 疑似包含凭据，拒绝导出`)
      files.push({ path, base64: data.toString('base64'), sha256: hash(data), executable: !!(stat.mode & 0o111) })
    }
  }
  await walk(root, '', 0)
  if (!files.some(f => f.path === 'SKILL.md')) throw Error(`Skill ${skillName} 缺少 SKILL.md`)
  return { name: skillName, ...(agentId ? { agentId } : {}), files }
}

export function parseAssets(raw: any): ConfigAssets {
  if (raw?.schema !== 'dsh-task-console/assets-v1' || !Array.isArray(raw.skills) || raw.skills.length > 500 || !Array.isArray(raw.hostConfigs) || raw.hostConfigs.length > 300 || !Array.isArray(raw.requirements)) throw Error('资产清单无效')
  let total = 0, count = 0
  const skillIds = new Set<string>()
  const fileSets = new Map<string, AssetFile[]>()
  const blobs = new Map<string, string>()
  const skills = raw.skills.map((s: any): SkillAsset => {
    const skillName = name(s?.name), agentId = s.agentId === undefined ? undefined : name(s.agentId), id = `${agentId ?? ''}/${skillName}`
    if (skillIds.has(id) || !Array.isArray(s.files)) throw Error('Skill 重复或文件清单无效')
    skillIds.add(id)
    if (s.filesRef !== undefined) {
      if (typeof s.filesRef !== 'string' || !fileSets.has(s.filesRef) || s.files.length) throw Error('Skill 文件引用无效；只允许引用包内之前的完整文件集')
      return { name: skillName, ...(agentId ? { agentId } : {}), files: [], filesRef: s.filesRef }
    }
    const paths = new Set<string>()
    const files = s.files.map((f: any): AssetFile => {
      const path = assetPath(f?.path), folded = path.toLowerCase()
      if (paths.has(folded) || typeof f.base64 !== 'string' || f.base64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.base64)) throw Error('资产文件重复或内容无效')
      paths.add(folded)
      if (f.contentRef !== undefined && (f.contentRef !== f.sha256 || !blobs.has(f.contentRef) || f.base64 !== '')) throw Error('资产文件内容引用无效')
      const data = Buffer.from(f.contentRef ? blobs.get(f.contentRef)! : f.base64, 'base64'); if (!f.contentRef) total += data.length; count++
      if (total > MAX_ASSET_BYTES || count > 10000 || data.length > MAX_FILE_BYTES) throw Error('配置资产超过大小或文件数量限制')
      if (hash(data) !== f.sha256 || typeof f.executable !== 'boolean') throw Error('资产文件 SHA256 或权限校验失败')
      if (!f.contentRef) blobs.set(f.sha256, f.base64)
      return { path, base64: f.base64, sha256: f.sha256, executable: f.executable, ...(f.contentRef ? { contentRef: f.contentRef } : {}) }
    })
    for (const path of paths) if (path.split('/').slice(0, -1).some((_, i, a) => paths.has(a.slice(0, i + 1).join('/')))) throw Error('资产文件与目录路径冲突')
    if (!files.some(f => f.path === 'SKILL.md')) throw Error('Skill 缺少 SKILL.md')
    fileSets.set(`${agentId ?? 'library'}/${skillName}`, files)
    return { name: skillName, ...(agentId ? { agentId } : {}), files }
  })
  const hostIds = new Set<string>()
  const hostConfigs = raw.hostConfigs.map((h: any): HostConfigAsset => {
    const id = name(h?.id)
    if (hostIds.has(id) || typeof h.module !== 'string' || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?$/.test(h.module) || !['mcp','model','plugin'].includes(h.kind) || !h.config || Array.isArray(h.config) || typeof h.config !== 'object' || !Array.isArray(h.secrets) || typeof h.wasDisabled !== 'boolean') throw Error('宿主配置资产无效')
    hostIds.add(id)
    if (!Array.isArray(h.tools) || h.tools.length > 3000 || h.tools.some((t: any) => typeof t !== 'string')) throw Error('MCP 工具清单无效')
    const clean = portableHostConfig(id, h.module, h.kind, h.config, h.wasDisabled, h.tools)
    // Exported null placeholders may be redacted again; never accept secret values in a bundle.
    if (clean.secrets.some(s => s.path.split('.').reduce((v: any, k) => v?.[k], h.config) !== null)) throw Error('资产包不能包含宿主密钥值')
    const secrets = h.secrets.map((s: any): SecretRef => {
      if (typeof s.path !== 'string' || !/^[A-Za-z0-9_.-]{1,300}$/.test(s.path) || s.ref !== `host-config:${id}:${s.path}` || s.path.split('.').some((k: string) => ['__proto__','prototype','constructor'].includes(k))) throw Error('凭据引用无效')
      if (s.path.split('.').reduce((v: any, k) => v?.[k], h.config) !== null) throw Error('凭据引用必须指向 null 占位符')
      return { path: s.path, ref: s.ref }
    })
    for (const s of clean.secrets) if (!secrets.some(r => r.path === s.path)) throw Error('脱敏配置缺少凭据引用')
    return { id, module: h.module, kind: h.kind, config: clean.config, wasDisabled: h.wasDisabled, secrets, tools: h.tools }
  })
  const requirements = raw.requirements.map((r: any) => {
    if (typeof r?.module !== 'string' || typeof r.version !== 'string' || r.module.length > 160 || r.version.length > 100) throw Error('版本依赖无效')
    return { module: r.module, version: r.version }
  })
  const m = raw.models
  if (!m || !Array.isArray(m.providers) || m.providers.length > 100 || m.defaultSelection !== null && (typeof m.defaultSelection?.provider !== 'string' || typeof m.defaultSelection?.model !== 'string')) throw Error('模型配置清单无效')
  const providers = m.providers.map((p: any) => {
    if (typeof p?.id !== 'string' || !Array.isArray(p.models) || p.models.length > 2000 || p.models.some((x: any) => typeof x !== 'string')) throw Error('模型目录无效')
    return { id: p.id, models: p.models }
  })
  return { schema: 'dsh-task-console/assets-v1', skills, hostConfigs, requirements, models: { defaultSelection: m.defaultSelection, providers } }
}

export function remapPath(path: string, mappings: Record<string, string> = {}): string {
  const keys = Object.keys(mappings).sort((a, b) => b.length - a.length)
  for (const from of keys) {
    if (!isAbsolute(from) || !isAbsolute(mappings[from]) || /[\x00-\x1f]/.test(from + mappings[from])) throw Error('工作目录映射必须是绝对路径')
    const source = from.replace(/\/$/, '') || '/'
    if (path === source || path.startsWith(source === '/' ? '/' : `${source}/`)) return resolve(mappings[from], path.slice(source.length).replace(/^\//, ''))
  }
  return path
}

/** Fail closed on existing symlink ancestors, including the destination root. */
export async function safeDirectory(dir: string): Promise<void> {
  const target = resolve(dir), parent = dirname(target)
  if (parent !== target) await safeDirectory(parent)
  const info = await lstat(target).catch((e: any) => { if (e.code !== 'ENOENT') throw e; return null })
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw Error(`迁移目标不是普通目录:${target}`)
  if (!info) await mkdir(target, { mode: 0o700 })
}

export async function writeSkillAsset(asset: SkillAsset, root: string): Promise<string> {
  await safeDirectory(root)
  const target = resolve(root, name(asset.name))
  if (!target.startsWith(resolve(root) + sep)) throw Error('Skill 目标越界')
  const exists = await lstat(target).catch((e: any) => { if (e.code !== 'ENOENT') throw e; return null })
  if (exists) throw Error(`Skill ${asset.name} 已存在；迁移不会覆盖已有资产`)
  const staged = join(root, `.migration-${randomUUID()}`)
  await mkdir(staged, { mode: 0o700 })
  try {
    for (const file of asset.files) {
      const path = join(staged, assetPath(file.path)); await safeDirectory(dirname(path))
      await writeFile(path, Buffer.from(file.base64, 'base64'), { mode: file.executable ? 0o700 : 0o600, flag: 'wx' })
    }
    await rename(staged, target)
  } finally { await rm(staged, { recursive: true, force: true }) }
  return target
}

export function profilePatchPath(argv = process.argv, home = process.env.DSH_HOME ?? join(homedir(), '.dsh')): string {
  const flag = argv.indexOf('--profile'), inline = argv.find(a => a.startsWith('--profile='))
  const profile = flag >= 0 ? argv[flag + 1] : inline?.slice(10) ?? 'web'
  if (!profile || !NAME.test(profile)) throw Error('DSH profile 名称无效')
  return join(home, 'profiles', profile, 'cordis.patch.yml')
}

/** Add only missing configs, always disabled. Existing entries, credentials and comments survive. */
export async function stageHostConfigs(file: string, rows: HostConfigAsset[], backupDir: string, existingIds: Set<string>): Promise<string[]> {
  if (!rows.length) return []
  await safeDirectory(dirname(file)); await safeDirectory(backupDir)
  const info = await lstat(file).catch((e: any) => { if (e.code !== 'ENOENT') throw e; return null })
  if (info && (!info.isFile() || info.isSymbolicLink())) throw Error('profile patch 不是普通文件')
  const source = info ? await readFile(file, 'utf8') : '[]\n'
  const doc = parseDocument(source)
  if (doc.errors.length || !isSeq(doc.contents)) throw Error('现有 profile patch 无法安全编辑')
  const ids = new Set(existingIds)
  const walk = (items: any[]) => { for (const item of items) { if (item?.get?.('id')) ids.add(String(item.get('id'))); const inserted = item?.get?.('insert', true); if (isSeq(inserted)) walk(inserted.items) } }
  walk(doc.contents.items)
  // Plugin policies are retained in the recovery manifest, not inserted as a
  // second live service. Applying them requires the destination host's review.
  const added = rows.filter(r => r.kind !== 'plugin' && !ids.has(r.id))
  if (!added.length) return []
  if (info) await copyFile(file, join(backupDir, 'cordis.patch.yml.before'))
  if (info) await chmod(join(backupDir, 'cordis.patch.yml.before'), 0o600)
  doc.contents.add(doc.createNode({ insert: added.map(r => ({ id: r.id, name: r.module, disabled: true, config: r.config })) }))
  const staged = join(dirname(file), `.migration-${randomUUID()}.yml`)
  try { await writeFile(staged, doc.toString(), { mode: 0o600, flag: 'wx' }); await rename(staged, file) }
  finally { await rm(staged, { force: true }) }
  return added.map(r => r.id)
}

export async function backupPreset(dir: string, root: string, id: string): Promise<void> {
  const info = await lstat(dir).catch((e: any) => { if (e.code !== 'ENOENT') throw e; return null })
  if (!info) return
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('现有 Agent 目录不安全，拒绝覆盖')
  await safeDirectory(root)
  await cp(dir, join(root, name(id)), { recursive: true, dereference: false, errorOnExist: true, force: false })
}
