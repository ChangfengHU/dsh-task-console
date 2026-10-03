import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ImageUnavailable, type ImageProvider } from './image-jobs.ts'

export interface ImageHostConfig { codexImageProvider?: string; codexImageModel?: string; geminiImagePoolDir?: string; geminiImageModel?: string }
export function imageBackends(ctx: any, config: ImageHostConfig): Record<'codex'|'gemini',ImageProvider> {
  return {
    codex: { async prepare(signal) {
      const llm = ctx.get('llm'), store = ctx.get('attachments')
      const provider = config.codexImageProvider || 'codex-local'
      if (!llm || !store || !llm.listProviders().some((p: any)=>p.id === provider)) throw new ImageUnavailable('Codex 宿主或图片存储未配置')
      const models = await llm.listModels(provider)
      const model = config.codexImageModel || models.find((m: any)=>m.id === 'gpt-6.1-sol')?.id || models[0]?.id
      if (!model) throw new ImageUnavailable('Codex 未提供模型')
      // One-shot: no main session, no dynamic tools, no inherited Agent history.
      const prepared = await llm.prepareCall({provider,model},signal)
      return { async generate(request,signal) {
        const { BlockAssembler, createUserMessage } = await import('@deepseek-ai/dsh-llm')
        const assembler = new BlockAssembler(); let terminal = false
        const content: any[] = [{type:'text',text:request.prompt}, ...request.references.map(attachment=>({type:'image',attachment}))]
        for await (const chunk of prepared.stream({ ...prepared.config, messages:[createUserMessage({content,source:{kind:'user'}})], tools:[], system:'You are an image generation backend. Use native image_generation to generate or edit exactly ONE image from this prompt and any supplied reference images. Do not use shell, web search, filesystem or other tools. Do not return a text-only answer. Preserve requested visual details. Never perform unrelated work.',signal })) {
          assembler.push(chunk); if (chunk.type === 'finish') terminal = true
        }
        if (!terminal || assembler.finish.kind !== 'stop') throw Error('Codex 生图未成功终结')
        const images = assembler.blocks().filter((b: any)=>b.type === 'image').map((b: any)=>b.attachment)
        if (!images.length) throw Error('Codex 没有调用原生生图或未返回图片')
        for (const ref of images) await store.readImage(ref,signal)
        return {images,model:`${provider}/${model}`}
      } }
    } },
    gemini: { async prepare(signal) {
      const store = ctx.get('attachments')
      if (!store) throw new ImageUnavailable('图片存储未配置')
      const dir = config.geminiImagePoolDir || join(homedir(),process.platform === 'darwin'?'Library/Application Support/AG Account Pool':'.local/share/ag-account-pool')
      let runtime: any, key: string
      try { runtime = JSON.parse(await readFile(join(dir,'runtime.json'),'utf8')); key = (await readFile(join(dir,'proxy-key'),'utf8')).trim() } catch { throw new ImageUnavailable('本机 Gemini 账号池未就绪') }
      if (!Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535 || !key) throw new ImageUnavailable('账号池配置无效')
      const origin = `http://127.0.0.1:${runtime.port}`, model = config.geminiImageModel || 'gemini-3.1-flash-image'
      if (!/^gemini-[a-zA-Z0-9._-]*image[a-zA-Z0-9._-]*$/.test(model)) throw new ImageUnavailable('必须使用 Gemini 图片模型')
      // Never publish this local relay credential or accept URLs/paths from Agent arguments.
      const catalog = await fetch(origin+'/gemini/v1beta/models',{headers:{'x-goog-api-key':key},signal,redirect:'error'}).catch(()=>null)
      if (!catalog?.ok || !(await catalog.json()).models?.some((m: any)=>m.name === 'models/'+model)) throw new ImageUnavailable('账号池未提供图片模型')
      return { async generate(request,signal) {
        const parts: any[] = [{text:request.prompt}]
        for (const ref of request.references) { const image = await store.readImage(ref,signal); parts.push({inlineData:{mimeType:ref.mediaType,data:Buffer.from(image.data).toString('base64')}}) }
        const res = await fetch(`${origin}/gemini/v1beta/models/${model}:generateContent`,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':key,'x-ag-pool-session':'dsh-native-'+request.requestId,'x-ag-pool-turn':request.requestId},body:JSON.stringify({contents:[{role:'user',parts}],generationConfig:{responseModalities:['TEXT','IMAGE']}}),signal,redirect:'error'})
        if (!res.ok) { await res.body?.cancel(); throw Error(`Gemini rejected ${res.status}`) }
        const reader = res.body!.getReader(); const chunks: Uint8Array[] = []; let bytes = 0
        try { for (;;) { const {done,value} = await reader.read(); if (done) break; bytes+=value.length; if(bytes>32*1024*1024) throw Error('Gemini 图片响应过大'); chunks.push(value) } } finally { await reader.cancel().catch(()=>{}) }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const encoded = (body.candidates || []).flatMap((c: any)=>(c.content?.parts || []).flatMap((p: any)=>p.inlineData?[p.inlineData]:[]))
        if (!encoded.length || encoded.length>4) throw Error('Gemini 没有返回图片')
        const inputs = encoded.map((p: any)=>{ if (!['image/png','image/jpeg','image/webp'].includes(p.mimeType) || typeof p.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.data) || p.data.length%4) throw Error('Gemini 图片格式无效'); const data = Buffer.from(p.data,'base64'); if(data.toString('base64')!==p.data)throw Error('Gemini base64 无效');return {data,mediaType:p.mimeType} })
        const images = await store.saveImages(inputs)
        return {images:[...images],model:res.headers.get('x-ag-pool-model') || model}
      } }
    } },
  }
}
