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
import { installFixedVision } from './fixed-vision.ts'

export const name = 'dsh-native-image-host'
export const inject = ['tools', 'llm', 'attachments']
export const Config = z.object({
  stateDir:z.string().default(''),
  codexImageProvider:z.string().default('codex-local'), codexImageModel:z.string().default(''),
  geminiImagePoolDir:z.string().default(''), geminiImageModel:z.string().default('gemini-3.1-flash-image'),
  geminiImageRoutes:z.array(z.object({id:z.string(),origin:z.string(),apiKeyEnv:z.string()})).default([]),
  geminiImageFallback:z.union([z.const(null),z.object({id:z.string(),origin:z.string(),apiKeyEnv:z.string()})]).default(null),
  imageConcurrency:z.natural().min(1).max(100).default(10),
  visionProvider:z.string().default('qwen-bailian'), visionModel:z.string().default('qwen3.7-plus'),
  defaultBackend:z.union(['codex','gemini']).default('gemini'),
  allowedBackends:z.array(z.union(['codex','gemini'])).default(['codex','gemini']),
  allowOverride:z.boolean().default(true), fallback:z.union(['none','unavailable-only']).default('unavailable-only'),
  maxRequestsPerSession:z.natural().min(1).max(100).default(12),
})
export const IMAGE_ROUTING_INSTRUCTION = '生图或编辑图片默认优先调用宿主内置 image_generate，不创建/委派生图 Agent，不先调用 MCP。用户明确指定某个已授权 MCP 时尊重该选择。只有内置工具未安装、或回执明确 BACKEND_UNAVAILABLE 且 mayHaveConsumedQuota=false 时，才可考虑已授权 MCP；不得借此提升权限。running、超时、取消、执行不明、已提交失败都不能当作本地不可用去补发 MCP，也不能伪称生成成功。使用 image_generate_status 等待 completed 的真实图片资产回执；同一请求复用 requestId。图片在本会话 Images 页展示，不向聊天模型附图。Codex/Gemini 是这个工具的后端，和会话模型无关。read_image 由宿主固定视觉模型识别并返回文本，不要求聊天模型支持图片；识别报告不是聊天模型亲眼观察。'

export async function apply(ctx: any, config: any = {}) {
  if (ctx.get('nativeImages')) throw Error('宿主内置生图服务已注册；请勿重复安装')
  const policy = imagePolicy({defaultBackend:config.defaultBackend ?? 'gemini',allowedBackends:config.allowedBackends ?? ['codex','gemini'],allowOverride:config.allowOverride ?? true,fallback:config.fallback ?? 'unavailable-only',maxRequestsPerSession:config.maxRequestsPerSession ?? 12})
  const dir = config.stateDir || join(process.env.DSH_HOME || join(homedir(),'.dsh'),'native-images')
  await mkdir(dir,{recursive:true,mode:0o700})
  const db = new Database(join(dir,'jobs.sqlite'))
  db.pragma('journal_mode = WAL')
  const jobs = new ImageJobs(db,imageBackends(ctx,config),240000,config.imageConcurrency ?? 10)
  ctx.provide('nativeImages',{jobs,policy})
  ctx.effect(()=>()=>jobs.dispose().finally(()=>db.close()),'native-images: durable host-owned jobs')
  await installTools(ctx,policy)
  installFixedVision(ctx,config)
  ctx.effect(()=>ctx.on('system-prompt/assemble',async (_: any,context: any,next: any)=>{
    const assembly = await next()
    if (!assembly.tools?.some((s: any)=>s.name === 'image_generate')) return assembly
    return {...assembly,contexts:[...(assembly.contexts || []),{name:'dsh:native-image-routing',text:IMAGE_ROUTING_INSTRUCTION}]}
  }),'native-images: prefer built-in tools without bypassing scoped permissions')
}
