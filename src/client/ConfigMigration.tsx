import { useState } from 'react'
import type { TasksApi, ConfigExportResult, ConfigImportPreview, ConfigImportResult, ConfigImportOptions } from './TasksView.tsx'
import { go } from './Console.tsx'

export function ConfigMigration({ api, toast }: { api: TasksApi; toast: (text: string) => void }) {
  const [url, setUrl] = useState(''), [fileJson, setFileJson] = useState(''), [filename, setFilename] = useState('')
  const [mapping, setMapping] = useState('{}'), [overwrite, setOverwrite] = useState(false), [installAssets, setInstallAssets] = useState(true)
  const [busy, setBusy] = useState<'export' | 'preview' | 'apply' | ''>(''), [error, setError] = useState('')
  const [exported, setExported] = useState<ConfigExportResult | null>(null)
  const [downloaded, setDownloaded] = useState<{ bytes: number; sha256: string } | null>(null)
  const [preview, setPreview] = useState<ConfigImportPreview | null>(null)
  const [result, setResult] = useState<ConfigImportResult | null>(null)
  const reset = () => { setPreview(null); setResult(null) }
  const run = async <T,>(kind: typeof busy, work: () => Promise<T>, done: (value: T) => void) => {
    setBusy(kind); setError('')
    try { done(await work()) } catch (cause) { setError(String((cause as Error).message ?? cause)) }
    finally { setBusy('') }
  }
  const exportNow = () => void run('export', api.exportConfig, value => { setExported(value); toast('配置包已上传到 R2') })
  const download = () => void run('export', api.exportLocalConfig, value => {
    const objectUrl = URL.createObjectURL(new Blob([value.json], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = objectUrl; a.download = value.filename; a.click()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    setDownloaded({ bytes: value.bytes, sha256: value.sha256 }); toast('资产包已生成，下载由浏览器处理')
  })
  const check = () => void run('preview', async () => {
    const options: ConfigImportOptions = { pathMappings: JSON.parse(mapping), overwriteAgents: overwrite, installAssets }
    return fileJson ? api.previewLocalConfigImport(fileJson, options) : api.previewConfigImport(url.trim(), options)
  }, value => { setPreview(value); setResult(null) })
  const apply = () => preview && void run('apply', () => api.applyConfigImport(preview.importId), value => { setResult(value); setPreview(null); toast('配置已导入；任务停用，新宿主配置待激活') })

  return <main className="dtc-migration">
    <header className="dtc-executions-heading"><div><button className="dtc-btn sm" onClick={() => go('tasks')}>← 任务列表</button><h1>配置资产迁移</h1><p>Task、Agent、Actions、完整 Skill 文件及 MCP/模型配置；不搬会话、执行记录、产物、日志、登录态或密钥值。</p></div></header>
    {error ? <div className="dtc-err" role="alert">{error}</div> : null}
    <div className="dtc-migration-grid">
      <section className="dtc-migration-card">
        <span className="dtc-kicker">CONFIGURATION ASSETS</span><h2>导出当前资产</h2>
        <p>支持的内置及用户 Agent、任务定义、定时规则、两类 Actions、Skill 正文/脚本/资源、MCP 策略和运行配置、模型选择与依赖版本。</p>
        <ul><li>密钥仅保留宿主引用，新机器单独绑定</li><li>保留各 Agent 的 Skill 副本，避免同名版本混淆</li><li>发现缺失或不支持的用户配置时拒绝导出，不静默丢失</li></ul>
        <button className="dtc-btn pri" disabled={!!busy} onClick={download}>{busy === 'export' ? '生成中…' : '下载本地资产包'}</button>
        {downloaded ? <div className="dtc-migration-result"><b>本地资产包已生成</b><small>{downloaded.bytes.toLocaleString()} bytes</small><code>SHA256 {downloaded.sha256}</code></div> : null}
        <details><summary>可选：发布到 R2</summary><p>上传后可通过链接读取。配置/Skill 可能含业务信息，请先检查本地包；需要宿主 R2 授权。</p><button className="dtc-btn" disabled={!!busy} onClick={exportNow}>生成并上传到 R2</button></details>
        {exported ? <div className="dtc-migration-result"><a href={exported.publicUrl} target="_blank" rel="noreferrer">查看 R2 配置包</a><code>SHA256 {exported.sha256}</code><button className="dtc-btn sm" onClick={() => void navigator.clipboard.writeText(exported.publicUrl)}>复制地址</button></div> : null}
      </section>
      <section className="dtc-migration-card">
        <span className="dtc-kicker">PREVIEW BEFORE IMPORT</span><h2>导入配置资产</h2>
        <p>兼容旧定义包。默认保留已有资产；新增 MCP/模型条目停用，补齐凭据、依赖并检查路径后再启用。</p>
        <label>本地 JSON 文件<input type="file" accept=".json,application/json" disabled={!!busy} onChange={async event => {
          reset(); setFileJson(''); setFilename(''); setError('')
          const file = event.target.files?.[0]; if (!file) return
          if (file.size > 40 * 1024 * 1024) { setError('配置包超过 40 MiB'); return }
          try { setFileJson(await file.text()); setFilename(file.name) } catch { setError('本地文件读取失败') }
        }} /></label>
        {filename ? <small>已选择 {filename}，优先使用本地文件。</small> : null}
        <label>或者 R2 地址<input value={url} disabled={!!busy} onChange={event => { setUrl(event.target.value); reset() }} placeholder="https://resource.vyibc.com/...json" /></label>
        <label>工作目录映射（JSON）<textarea aria-label="工作目录映射" value={mapping} disabled={!!busy} onChange={event => { setMapping(event.target.value); reset() }} placeholder={'{"/home/claude/work":"/Users/name/work"}'} /></label>
        <label className="dtc-action-check"><input type="checkbox" checked={installAssets} disabled={!!busy} onChange={event => { setInstallAssets(event.target.checked); reset() }} />恢复 Skill 文件及停用的宿主配置</label>
        <label className="dtc-action-check"><input type="checkbox" checked={overwrite} disabled={!!busy} onChange={event => { setOverwrite(event.target.checked); reset() }} />覆盖同 ID Agent（先备份；不覆盖 Task/Skill/宿主配置）</label>
        <button className="dtc-btn" disabled={!!busy || !fileJson && !url.trim()} onClick={check}>{busy === 'preview' ? '校验中…' : '校验并预览'}</button>
        {preview ? <div className="dtc-migration-preview"><b>导入预览</b><p>{preview.counts.agents} Agents · {preview.counts.tasks} Tasks · 来源版本 {preview.sourceVersion}</p>
          {preview.assets ? <><h3>运行资产</h3><p>{preview.assets.skills.length} Skill 副本 · {preview.assets.hostConfigs.length} MCP/模型配置</p>
            {preview.assets.skills.map(s => <div className="dtc-migration-row" key={(s.agentId ?? 'library') + '/' + s.name}><span>{s.agentId ?? 'Skill 库'} / {s.name}<small>{s.files} 文件</small></span><em>{s.conflict ? '保留同名库；Agent 用独立副本' : installAssets ? '恢复文件' : '仅导入引用'}</em></div>)}
            {preview.assets.hostConfigs.map(h => <div className="dtc-migration-row" key={h.id}><span>{h.id}<small>{h.module}</small></span><em>新增项停用 · {h.secretRefs.length} 项需重绑</em></div>)}
            {preview.assets.defaultSelection ? <p>源默认模型：{preview.assets.defaultSelection.provider}/{preview.assets.defaultSelection.model}；保留目标机器当前默认模型。</p> : null}
            {preview.assets.missingModules.length ? <div className="dtc-err">需核对/安装插件：{preview.assets.missingModules.map(r => r.module + '@' + r.version).join('、')}。不会执行安装脚本。</div> : null}
            {preview.assets.missingProviders.length ? <p>缺少模型提供方：{preview.assets.missingProviders.join('、')}</p> : null}
          </> : <p>旧版定义包没有 Skill 本体和宿主配置，需另行补齐。</p>}
          <h3>Agents</h3>{preview.agents.map(row => <div key={row.id} className="dtc-migration-row"><span>{row.name}<small>{row.id}</small></span><em>{row.conflict ? overwrite ? '备份后覆盖' : '已有，保留' : !row.ready ? '需补运行能力：' + [...row.missingSkills, ...row.missingMcp].join('、') : '可导入'}</em></div>)}
          <h3>Tasks</h3>{preview.tasks.map(row => <div key={row.id} className="dtc-migration-row"><span>{row.title}<small>{row.cwd} · {row.actionCount ?? 0} Actions</small></span><em>{row.conflict ? '已有，跳过' : '导入后停用'}</em></div>)}
          <button className="dtc-btn pri" disabled={!!busy} onClick={apply}>{busy === 'apply' ? '导入中…' : '确认导入预览中的资产'}</button></div> : null}
        {result ? <div className="dtc-migration-result"><b>配置导入完成，不等于运行验收通过</b><p>{result.importedAgents.length} Agents、{result.importedTasks.length} Tasks、{result.importedSkills?.length ?? 0} Skill 副本；{result.stagedHostConfigs?.length ?? 0} 项宿主配置待激活。</p><small>所有 Task 停用；没有迁移执行授权和登录态。</small><small>备份/恢复资料：{result.backupRoot}</small>{result.runtimeActivationRequired ? <p>在 MCP/模型设置补齐凭据和依赖、检查路径并启用服务；验证后再运行任务。</p> : null}{[...result.skippedAgents, ...result.skippedTasks].map(r => <small key={r.id}>{r.id}：{r.reason}</small>)}</div> : null}
      </section>
    </div>
  </main>
}
