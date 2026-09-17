import { useState } from 'react'
import type { TasksApi, ConfigExportResult, ConfigImportPreview, ConfigImportResult } from './TasksView.tsx'
import { go } from './Console.tsx'

export function ConfigMigration({ api, toast }: { api: TasksApi; toast: (text: string) => void }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'export' | 'preview' | 'apply' | ''>('')
  const [error, setError] = useState('')
  const [exported, setExported] = useState<ConfigExportResult | null>(null)
  const [preview, setPreview] = useState<ConfigImportPreview | null>(null)
  const [result, setResult] = useState<ConfigImportResult | null>(null)

  const run = async <T,>(kind: typeof busy, work: () => Promise<T>, done: (value: T) => void) => {
    setBusy(kind); setError('')
    try { done(await work()) } catch (cause) { setError(String((cause as Error).message ?? cause)) }
    finally { setBusy('') }
  }
  const exportNow = () => void run('export', api.exportConfig, value => { setExported(value); toast('配置包已上传到 R2') })
  const check = () => void run('preview', () => api.previewConfigImport(url.trim()), value => { setPreview(value); setResult(null) })
  const apply = () => preview && void run('apply', () => api.applyConfigImport(preview.importId), value => { setResult(value); setPreview(null); toast('配置导入完成；时间表保持停用') })
  const copy = async () => { if (!exported) return; await navigator.clipboard.writeText(exported.publicUrl); toast('已复制 R2 地址') }

  return <main className="dtc-migration">
    <header className="dtc-executions-heading"><div><button className="dtc-btn sm" onClick={() => go('tasks')}>← 任务列表</button><h1>配置迁移</h1><p>只迁移 Agent 与 Task 定义；不包含会话、执行记录、产物、日志或凭据。</p></div></header>
    {error ? <div className="dtc-err">{error}</div> : null}
    <div className="dtc-migration-grid">
      <section className="dtc-migration-card">
        <span className="dtc-kicker">EXPORT TO R2</span><h2>导出当前配置</h2>
        <p>包含 Agent、Task、依赖、Action、Schedule 和 Skill/MCP 引用。Vault 仅保留 key 名称。</p>
        <ul><li>不读取会话和执行记录</li><li>不导出附件与密钥值</li><li>上传后只返回 R2 地址与校验值</li></ul>
        <button className="dtc-btn pri" disabled={!!busy} onClick={exportNow}>{busy === 'export' ? '生成并上传中…' : '生成并上传到 R2'}</button>
        {exported ? <div className="dtc-migration-result"><b>导出完成</b><a href={exported.publicUrl} target="_blank" rel="noreferrer">{exported.publicUrl}</a><small>{exported.counts.agents} Agents · {exported.counts.tasks} Tasks · {exported.bytes.toLocaleString()} bytes</small><code>SHA256 {exported.sha256}</code><button className="dtc-btn sm" onClick={copy}>复制地址</button></div> : null}
      </section>
      <section className="dtc-migration-card">
        <span className="dtc-kicker">IMPORT FROM R2</span><h2>从地址导入配置</h2>
        <p>校验包内 Task 与 Agent 引用后直接导入配置。MCP/Skill 只做运行能力提示，不阻止导入；Task 不会自动执行。</p>
        <label>R2 配置地址<input value={url} onChange={event => { setUrl(event.target.value); setPreview(null); setResult(null) }} placeholder="https://resource.vyibc.com/...json" /></label>
        <button className="dtc-btn" disabled={!!busy || !url.trim()} onClick={check}>{busy === 'preview' ? '校验中…' : '校验并预览'}</button>
        {preview ? <div className="dtc-migration-preview"><b>导入预览</b><p>{preview.counts.agents} Agents · {preview.counts.tasks} Tasks · 来源版本 {preview.sourceVersion}</p>
          {preview.runtime && (preview.runtime.missingMcp.length || preview.runtime.missingSkills.length) ? <div className="dtc-migration-runtime"><b>运行能力提示（不影响导入）</b><p>{preview.runtime.missingMcp.length} MCP · {preview.runtime.missingSkills.length} Skills 尚未安装，相关 Agent 配置仍会导入。</p></div> : null}
          <h3>Agents</h3>{preview.agents.map(row => <div key={row.id} className="dtc-migration-row"><span>{row.name}<small>{row.id}</small></span><em>{row.conflict ? '将更新同 ID 配置' : !row.ready ? `可导入 · 运行前需补 ${[...row.missingSkills, ...row.missingMcp].join('、')}` : '可导入'}</em></div>)}
          <h3>Tasks</h3>{preview.tasks.map(row => <div key={row.id} className="dtc-migration-row"><span>{row.title}<small>{row.id}</small></span><em>{row.conflict ? '跳过：同 ID 已存在' : row.missingAgents.length ? `缺少 Agent:${row.missingAgents.join('、')}` : row.scheduleDisabled ? '可导入 · 时间表停用' : '可导入'}</em></div>)}
          <button className="dtc-btn pri" disabled={!!busy} onClick={apply}>{busy === 'apply' ? '导入中…' : '导入全部 Agent 与 Task 配置'}</button></div> : null}
        {result ? <div className="dtc-migration-result"><b>导入完成</b><p>{result.importedAgents.length} Agents、{result.importedTasks.length} Tasks 已导入；{result.skippedAgents.length + result.skippedTasks.length} 项跳过。</p><small>所有定时 Task 均保持停用。</small></div> : null}
      </section>
    </div>
  </main>
}
