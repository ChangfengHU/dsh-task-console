/** Host-level native tools. No Agent preset, Task runner, or MCP is required. */
import z from '@deepseek-ai/schemastery'
import Database from 'better-sqlite3'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { ImageJobs } from './image-jobs.ts'
import { imageBackends } from './image-backends.ts'
import { imagePolicy } from './image-policy.ts'
import { apply as installTools } from './image-generation-tools.ts'

export const name = 'dsh-native-image-host'
export const inject = ['tools', 'llm', 'attachments']
export const Config = z.object({
  stateDir:z.string().default(''),
  codexImageProvider:z.string().default('codex-local'), codexImageModel:z.string().default(''),
  geminiImagePoolDir:z.string().default(''), geminiImageModel:z.string().default('gemini-3.1-flash-image'),
  defaultBackend:z.union(['codex','gemini']).default('codex'),
  allowedBackends:z.array(z.union(['codex','gemini'])).default(['codex','gemini']),
  allowOverride:z.boolean().default(true), fallback:z.union(['none','unavailable-only']).default('none'),
  maxRequestsPerSession:z.natural().min(1).max(100).default(12),
})
export const IMAGE_ROUTING_INSTRUCTION = '生图或编辑图片默认优先调用宿主内置 image_generate，不创建/委派生图 Agent，不先调用 MCP。用户明确指定某个已授权 MCP 时尊重该选择。只有内置工具未安装、或回执明确 BACKEND_UNAVAILABLE 且 mayHaveConsumedQuota=false 时，才可考虑已授权 MCP；不得借此提升权限。running、超时、取消、执行不明、已提交失败都不能当作本地不可用去补发 MCP，也不能伪称生成成功。使用 image_generate_status 等待 completed 的真实图片附件；同一请求复用 requestId。Codex/Gemini 是这个工具的后端，和会话模型无关。'

export async function apply(ctx: any, config: any = {}) {
  if (ctx.get('nativeImages')) throw Error('宿主内置生图服务已注册；请勿重复安装')
  const policy = imagePolicy({defaultBackend:config.defaultBackend ?? 'codex',allowedBackends:config.allowedBackends ?? ['codex','gemini'],allowOverride:config.allowOverride ?? true,fallback:config.fallback ?? 'none',maxRequestsPerSession:config.maxRequestsPerSession ?? 12})
  const dir = config.stateDir || join(process.env.DSH_HOME || join(homedir(),'.dsh'),'native-images')
  await mkdir(dir,{recursive:true,mode:0o700})
  const db = new Database(join(dir,'jobs.sqlite'))
  db.pragma('journal_mode = WAL')
  const jobs = new ImageJobs(db,imageBackends(ctx,config))
  ctx.provide('nativeImages',{jobs,policy})
  ctx.effect(()=>()=>jobs.dispose().finally(()=>db.close()),'native-images: durable host-owned jobs')
  await installTools(ctx,policy)
  ctx.effect(()=>ctx.on('system-prompt/assemble',async (_: any,context: any,next: any)=>{
    const assembly = await next()
    if (!assembly.tools?.some((s: any)=>s.name === 'image_generate')) return assembly
    return {...assembly,contexts:[...(assembly.contexts || []),{name:'dsh:native-image-routing',text:IMAGE_ROUTING_INSTRUCTION}]}
  }),'native-images: prefer built-in tools without bypassing scoped permissions')
}
