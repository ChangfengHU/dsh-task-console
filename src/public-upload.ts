/** Host-side public HTML upload. The bearer token never crosses the tool boundary. */

import { homedir } from 'node:os'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_HTML_BYTES = 20 * 1024 * 1024

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export function safeUploadPart(value: string): string {
  return value.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 120) || 'page.html'
}

function safeUploadPath(value: string): string {
  return value.split('/').map(safeUploadPart).filter(Boolean).join('/').slice(0, 300)
}

export interface PublicUploadConfig { endpoint: string; domain: string; token: string }
export interface PublicHtmlInput { name: string; data: Buffer; path?: string }

export function publicUploadConfig(): PublicUploadConfig {
  const token = process.env.DSH_TASK_CONSOLE_UPLOAD_TOKEN ?? process.env.UPLOAD_R2_TOKEN ?? ''
  if (!token) throw new Error('宿主未配置 DSH_TASK_CONSOLE_UPLOAD_TOKEN,不能发布公网链接')
  return {
    endpoint: process.env.DSH_TASK_CONSOLE_UPLOAD_URL ?? process.env.UPLOAD_R2_URL ?? 'https://upload-r2.vyibc.com',
    domain: process.env.DSH_TASK_CONSOLE_PUBLIC_DOMAIN ?? process.env.UPLOAD_R2_DOMAIN ?? 'https://resource.vyibc.com',
    token,
  }
}

/** Upload already-validated HTML bytes and normalize the service response into one HTTPS URL. */
export async function uploadPublicHtml(config: PublicUploadConfig, input: PublicHtmlInput): Promise<string> {
  if (!/\.html?$/i.test(input.name)) throw new Error('目前只允许发布 .html 文件')
  if (input.data.byteLength > MAX_HTML_BYTES) throw new Error('HTML 超过 20 MiB')
  const name = safeUploadPart(input.name)
  const path = input.path ? safeUploadPath(input.path) : ''
  const form = new FormData()
  form.append('file', new Blob([input.data], { type: 'text/html; charset=utf-8' }), name)
  form.append('domain', config.domain)
  form.append('name', name)
  if (path) form.append('path', path)
  const response = await fetch(config.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${config.token}` }, body: form })
  const body = await response.text()
  if (!response.ok) throw new Error(`发布服务返回 ${response.status}`)
  let url = ''
  try {
    const parsed = JSON.parse(body)
    url = String(parsed.url ?? parsed.data?.url ?? parsed.result?.url ?? '')
  } catch { url = body.trim() }
  if (!/^https:\/\//.test(url)) {
    const base = config.domain.replace(/\/$/, '')
    url = `${base}/${path ? `${path}/` : ''}${encodeURIComponent(name)}`
  }
  return url
}

/** Resolve one session-supplied path without permitting files outside configured workspace roots. */
export async function readPublishableHtml(filePath: string): Promise<{ path: string; name: string; data: Buffer }> {
  const raw = String(filePath ?? '').trim()
  if (!raw) throw new Error('path 不能为空')
  const file = await realpath(resolve(raw))
  const configured = (process.env.DSH_TASK_CONSOLE_PUBLISH_ROOTS ?? homedir()).split(':').map(value => value.trim()).filter(Boolean)
  const roots = await Promise.all(configured.map(root => realpath(resolve(root))))
  if (!roots.some(root => inside(file, root))) throw new Error('HTML 必须位于允许的工作区内')
  if (!/\.html?$/i.test(file)) throw new Error('目前只允许发布 .html 文件')
  const info = await stat(file)
  if (!info.isFile()) throw new Error('path 不是普通文件')
  if (info.size > MAX_HTML_BYTES) throw new Error('HTML 超过 20 MiB')
  return { path: file, name: basename(file), data: await readFile(file) }
}

/** Register a real DSH tool usable from normal agent sessions. */
export async function registerPublicHtmlTool(ctx: any): Promise<() => void> {
  const defineTool: (spec: any) => any = process.env.NODE_ENV === 'test' ? (spec => spec) : (await import('@deepseek-ai/dsh-tools')).defineTool
  return ctx.tools.register(defineTool({
    name: 'publish_public_html',
    description: '把工作区里的一个 HTML 文件发布为公网 HTTPS 页面。发布凭据保留在宿主端；只返回公开 URL。适合交付原型、报告和可交互演示。',
    parameters: {
      path: { type: 'string', required: true, description: '本机 HTML 文件绝对路径，必须位于允许的工作区。' },
      name: { type: 'string', description: '可选的公网文件名，必须以 .html 或 .htm 结尾。' },
      publicPath: { type: 'string', description: '可选的公网目录，例如 dsh-task-console/prototypes。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          publicUrl: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args: any) {
      const file = await readPublishableHtml(String(args.path ?? ''))
      const requestedName = String(args.name ?? file.name).trim() || file.name
      const publicUrl = await uploadPublicHtml(publicUploadConfig(), {
        name: requestedName,
        data: file.data,
        path: String(args.publicPath ?? '').trim() || 'dsh-task-console/exports',
      })
      return { ok: true, publicUrl, bytes: file.data.byteLength }
    },
  }))
}
