/** Safe artifact capture, legacy discovery, reading, and explicit HTML publishing. */

import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Artifact, Run, TaskSpec } from './fold.ts'
import { uploadPublicHtml, type PublicUploadConfig } from './public-upload.ts'

const MAX_CAPTURE_BYTES = 20 * 1024 * 1024
export const MAX_BROWSER_BYTES = 8 * 1024 * 1024

const MIMES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.csv': 'text/csv', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.zip': 'application/zip', '.py': 'text/x-python',
  '.js': 'text/javascript', '.ts': 'text/typescript', '.css': 'text/css', '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml',
}

export function mimeOf(path: string): string { return MIMES[extname(path).toLowerCase()] ?? 'application/octet-stream' }

function inside(child: string, parent: string): boolean {
  const r = relative(parent, child)
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r))
}

function safePart(value: string): string {
  return value.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100) || 'artifact'
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

export interface CaptureContext {
  root: string
  task: TaskSpec
  batchId: string
  cardId: string
  runId: string
  sessionId: string
  at: string
}

/** Snapshot declared files under the private task-console store. Every path must stay inside the task workspace. */
export async function captureArtifacts(ctx: CaptureContext, requested: string[]): Promise<Artifact[]> {
  if (!requested.length) return []
  if (requested.length > 20) throw new Error('一次最多登记 20 个产物')
  const workspace = await realpath(ctx.task.cwd)
  const checked: { original: string; name: string; size: number; sha: string }[] = []
  for (const raw of [...new Set(requested.map(x => String(x).trim()).filter(Boolean))]) {
    const candidate = resolve(ctx.task.cwd, raw)
    let original: string
    try { original = await realpath(candidate) } catch { throw new Error(`产物不存在:${raw}`) }
    if (!inside(original, workspace)) throw new Error(`产物必须位于任务工作区内:${raw}`)
    const info = await stat(original)
    if (!info.isFile()) throw new Error(`产物不是普通文件:${raw}`)
    if (info.size > MAX_CAPTURE_BYTES) throw new Error(`产物超过 20 MiB:${raw}`)
    checked.push({ original, name: safePart(basename(original)), size: info.size, sha: await sha256(original) })
  }
  const dir = join(ctx.root, 'artifacts', safePart(ctx.task.id), safePart(ctx.batchId), safePart(ctx.runId))
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const out: Artifact[] = []
  for (const file of checked) {
    const id = `a-${randomUUID()}`
    const storagePath = join(dir, `${id.slice(2, 10)}-${file.name}`)
    await copyFile(file.original, storagePath)
    out.push({
      id, taskId: ctx.task.id, batchId: ctx.batchId, cardId: ctx.cardId, runId: ctx.runId, sessionId: ctx.sessionId,
      name: file.name, mime: mimeOf(file.name), size: file.size, sha256: file.sha, createdAt: ctx.at,
      originalPath: file.original, storagePath,
    })
  }
  return out
}

const PATH_TOKEN = /(?:`|"|')?(\/[\w\p{L} ._@+~()\[\]-]+(?:\/[\w\p{L} ._@+~()\[\]-]+)*\.[A-Za-z0-9]{1,12})(?:`|"|')?/gu

/** Read-only compatibility projection for old summaries that mentioned a real workspace file but did not register it. */
export async function discoverLegacyArtifacts(task: TaskSpec, runs: Run[], knownOriginals: Set<string>): Promise<Artifact[]> {
  let workspace: string
  try { workspace = await realpath(task.cwd) } catch { return [] }
  const found = new Map<string, { run: Run; path: string }>()
  for (const run of runs) {
    for (const match of (run.summary ?? '').matchAll(PATH_TOKEN)) {
      const candidate = match[1].trim()
      if (!found.has(candidate)) found.set(candidate, { run, path: candidate })
    }
  }
  const out: Artifact[] = []
  for (const { run, path } of found.values()) {
    try {
      const original = await realpath(path)
      if (!inside(original, workspace) || knownOriginals.has(original)) continue
      const info = await stat(original)
      if (!info.isFile() || info.size > MAX_CAPTURE_BYTES) continue
      out.push({
        id: `legacy-${createHash('sha256').update(`${run.id}\0${original}`).digest('hex').slice(0, 24)}`,
        taskId: task.id, batchId: run.batchId, cardId: run.cardId, runId: run.id, sessionId: run.sessionId,
        name: safePart(basename(original)), mime: mimeOf(original), size: info.size, sha256: await sha256(original),
        createdAt: run.endedAt ?? run.startedAt, originalPath: original, storagePath: original, legacy: true,
      })
    } catch { /* an old handoff may contain a path that no longer exists */ }
  }
  return out
}

/** Resolve a stored file without accepting a browser-supplied filesystem path. */
export async function readArtifact(root: string, task: TaskSpec, artifact: Artifact): Promise<Buffer> {
  const file = await realpath(artifact.storagePath)
  const allowed = artifact.legacy ? await realpath(task.cwd) : await realpath(join(root, 'artifacts'))
  if (!inside(file, allowed)) throw new Error('产物路径越界')
  const info = await stat(file)
  if (!info.isFile()) throw new Error('产物已不存在')
  if (info.size > MAX_BROWSER_BYTES) throw new Error('产物超过 8 MiB,暂不能通过浏览器读取')
  return readFile(file)
}

export type PublishConfig = PublicUploadConfig

/** Upload only one explicitly selected HTML snapshot; the credential remains on the host. */
export async function publishHtml(config: PublishConfig, artifact: Artifact, data: Buffer): Promise<string> {
  if (artifact.mime !== 'text/html' && !/\.html?$/i.test(artifact.name)) throw new Error('目前只允许把 HTML 产物发布到公网')
  return uploadPublicHtml(config, {
    name: artifact.name,
    data,
    path: `dsh-task-console/${safePart(artifact.taskId)}/${safePart(artifact.batchId)}`,
  })
}
