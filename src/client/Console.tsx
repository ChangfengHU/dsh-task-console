/**
 * The console page: Agent roster + editor (this release), Tasks placeholder.
 *
 * Routing lives in the URL hash (`#/tc/agents`, `#/tc/agents/<id>`,
 * `#/tc/agents/new`, `#/tc/tasks`) so any screen can be copied and reopened.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentRow, AgentSpec, Catalog, Preview, TryRunResult } from '../wire.ts'
import { NewTask, TaskBoard, TaskDetail, type TasksApi } from './TasksView.tsx'

export interface Api extends TasksApi {
  catalog: () => Promise<Catalog>
  agents: () => Promise<AgentRow[]>
  previewAgent: (spec: AgentSpec) => Promise<Preview>
  saveAgent: (spec: AgentSpec) => Promise<{ path: string; preview: Preview }>
  deleteAgent: (id: string) => Promise<void>
  tryRun: (id: string) => Promise<TryRunResult>
  startAgentSession: (agentId: string, text?: string, cwd?: string) => Promise<{ sessionId: string; name: string }>
  openSession: (sessionId: string) => Promise<void>
}

export const HASH_PREFIX = '#/tc'

export function readRoute(): string[] {
  const h = window.location.hash
  if (!h.startsWith(HASH_PREFIX)) return []
  return h.slice(HASH_PREFIX.length).split('/').filter(Boolean)
}

export function go(path: string): void {
  window.location.hash = `${HASH_PREFIX}/${path}`.replace(/\/+$/, '')
}

export function closeConsole(): void {
  history.pushState('', document.title, window.location.pathname + window.location.search)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

const EMPTY: AgentSpec = { id: '', name: '', description: '', persona: '', model: '', effort: 'medium', tools: ['ask-user'], mcp: [], skills: [] }

const PERM: Record<Preview['permission'], { label: string; cls: string }> = {
  'read-only': { label: '只读', cls: 'dtc-p-ok' },
  'limited-write': { label: '受限可写', cls: 'dtc-p-warn' },
  'write': { label: '可写', cls: 'dtc-p-bad' },
}

function useToast(): [string, (m: string) => void] {
  const [msg, setMsg] = useState('')
  const timer = useRef<number | undefined>(undefined)
  const show = useCallback((m: string) => {
    setMsg(m); window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setMsg(''), 2800)
  }, [])
  return [msg, show]
}

export function Console({ api }: { api: Api }) {
  const [route, setRoute] = useState<string[]>(readRoute())
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [agents, setAgents] = useState<AgentRow[] | null>(null)
  const [error, setError] = useState('')
  const [toast, showToast] = useToast()

  useEffect(() => {
    const on = () => setRoute(readRoute())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  const reload = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([api.catalog(), api.agents()])
      setCatalog(c); setAgents(a); setError('')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [api])
  useEffect(() => { void reload() }, [reload])

  const tab = route[0] === 'tasks' ? 'tasks' : 'agents'
  const url = `${HASH_PREFIX}/${route.join('/')}`

  let page: JSX.Element
  if (tab === 'tasks') {
    if (!agents || !catalog) page = <div className="dtc-empty"><span className="dtc-spin" /> 读取…</div>
    else if (route[1] === 'new') page = <NewTask api={api} agents={agents} toast={showToast} workspaces={catalog.workspaces} />
    else if (route[1]) page = <TaskDetail api={api} agents={agents} id={route[1]} runId={route[2] === 'runs' ? route[3] : undefined} toast={showToast} />
    else page = <TaskBoard api={api} agents={agents} toast={showToast} />
  } else if (route[1]) {
    const id = route[1] === 'new' ? null : route[1]
    // The editor seeds its form from the roster row; mounting it before the
    // roster arrives would let a fast typist start on an empty id.
    page = agents && catalog
      ? <AgentEditor key={id ?? 'new'} api={api} catalog={catalog} agents={agents} id={id} onSaved={reload} toast={showToast} />
      : <div className="dtc-empty"><span className="dtc-spin" /> 读取 preset 名册…</div>
  } else page = <AgentList agents={agents} catalog={catalog} api={api} toast={showToast} />

  return (
    <div className="dtc-root dtc-overlay">
      <div className="dtc-head">
        <div className="dtc-ttl"><i />任务台</div>
        <div className="dtc-tabs">
          <button className={`dtc-tab ${tab === 'agents' ? 'on' : ''}`} onClick={() => go('agents')}>Agent<span className="n">{agents?.length ?? ''}</span></button>
          <button className={`dtc-tab ${tab === 'tasks' ? 'on' : ''}`} onClick={() => go('tasks')}>任务</button>
        </div>
        <span className="dtc-url dtc-mono">{url}</span>
        <button className="dtc-close" title="关闭" onClick={closeConsole}>×</button>
      </div>
      <div className="dtc-body">
        {error ? <div className="dtc-err">{error}</div> : null}
        {page}
      </div>
      {toast ? <div className="dtc-toast">{toast}</div> : null}
    </div>
  )
}

function AgentList({ agents, catalog, api, toast }: { agents: AgentRow[] | null; catalog: Catalog | null; api: Api; toast: (m: string) => void }) {
  const chat = async (e: React.MouseEvent, a: AgentRow) => { e.stopPropagation(); try { const { sessionId } = await api.startAgentSession(a.id); toast(`已开 ${a.name} 的会话`); closeConsole(); await api.openSession(sessionId) } catch (err) { toast(String((err as Error).message ?? err)) } }
  if (!agents) return <div className="dtc-empty"><span className="dtc-spin" /> 读取 preset 名册…</div>
  return (
    <>
      <div className="dtc-bar">
        <span><b style={{ color: 'var(--dtc-ink)' }}>{agents.length}</b> 个 Agent · 每个是一个 preset 目录 <span className="dtc-mono dtc-faint">{catalog?.userRoot ?? ''}/&lt;id&gt;/</span></span>
        <span className="sp" />
        <button className="dtc-btn pri" onClick={() => go('agents/new')}>＋ 新建 Agent</button>
      </div>
      <div className="dtc-grid">
        {agents.map(a => {
          const perm = a.spec ? derivePerm(a.spec) : null
          return (
            <button key={a.id} className={`dtc-card ${a.broken ? 'broken' : ''}`} onClick={() => go(`agents/${a.id}`)}>
              <div className="n">{a.name}<span className="id dtc-mono">{a.id}</span>
                {a.trust === 'system' ? <span className="dtc-pill dtc-p-grey">出厂</span> : null}
                {a.broken ? <span className="dtc-pill dtc-p-bad">坏了</span> : perm ? <span className={`dtc-pill ${PERM[perm].cls}`}>{PERM[perm].label}</span> : <span className="dtc-pill dtc-p-grey">只读查看</span>}
              </div>
              <div className="d">{a.broken ?? a.description}</div>
              {a.spec ? <div className="m"><span>{a.spec.tools.length} 工具</span><span>{a.spec.mcp.length} MCP</span><span>{a.spec.skills.length} skill</span><span className="dtc-mono">{a.spec.model.split('/')[1] ?? ''}</span></div> : <div className="m"><span className="dtc-faint">不是任务台写的,看得到选不了字段</span></div>}
              {!a.broken ? <div className="m" style={{ marginTop: 4 }}><span className="dtc-btn sm" role="button" onClick={e => chat(e, a)}>💬 开新会话</span><span className="dtc-faint">或在输入框打 @{a.name}</span></div> : null}
            </button>
          )
        })}
        <button className="dtc-card new" onClick={() => go('agents/new')}>＋ 新建空白 Agent<br /><span className="dtc-faint" style={{ fontSize: 12 }}>或进任一 Agent 点「复制」</span></button>
      </div>
    </>
  )
}

function derivePerm(spec: AgentSpec): Preview['permission'] {
  if (spec.tools.some(t => t === 'bash' || t === 'fs' || t === 'str-replace-editor')) return 'write'
  if (spec.tools.some(t => t === 'fs' || t === 'bash') || spec.mcp.length) return 'limited-write'
  return 'read-only'
}

/** Prefill stash for "复制" — survives one navigation. */
let stash: AgentSpec | null = null

function AgentEditor({ api, catalog, agents, id, onSaved, toast }: {
  api: Api; catalog: Catalog | null; agents: AgentRow[]; id: string | null; onSaved: () => Promise<void>; toast: (m: string) => void
}) {
  const row = id ? agents.find(a => a.id === id) : undefined
  const readOnly = !!row && row.trust === 'system'
  const initial = useMemo<AgentSpec>(() => {
    if (!id && stash) { const s = stash; stash = null; return s }
    if (row?.spec) return row.spec
    if (row) return { ...EMPTY, id: row.id, name: row.name, description: row.description }
    return { ...EMPTY, model: catalog?.defaultModel ?? '' }
  }, [id, row, catalog?.defaultModel])
  const [spec, setSpec] = useState<AgentSpec>(initial)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [run, setRun] = useState<TryRunResult | 'running' | null>(null)
  const dirty = useRef(false)

  // A deep link mounts the editor before the roster arrives; adopt the row
  // once it does, unless the person already started typing.
  useEffect(() => { if (row && !dirty.current) setSpec(initial) }, [row, initial])

  useEffect(() => { if (!spec.model && catalog?.defaultModel) setSpec(s => ({ ...s, model: catalog.defaultModel })) }, [catalog?.defaultModel, spec.model])

  // live yml preview, debounced
  useEffect(() => {
    if (readOnly) return
    if (!/^[a-z0-9][a-z0-9-]*$/.test(spec.id) || !spec.name.trim()) { setPreview(null); return }
    const t = window.setTimeout(() => { api.previewAgent(spec).then(setPreview).catch(e => setErr(String(e.message ?? e))) }, 350)
    return () => window.clearTimeout(t)
  }, [spec, api, readOnly])

  const set = <K extends keyof AgentSpec>(k: K, v: AgentSpec[K]) => { dirty.current = true; setSpec(s => ({ ...s, [k]: v })) }
  const toggle = (k: 'tools' | 'mcp' | 'skills', v: string) => set(k, spec[k].includes(v) ? spec[k].filter(x => x !== v) : [...spec[k], v])

  const save = async () => {
    setBusy('save'); setErr('')
    try {
      const out = await api.saveAgent(spec)
      setPreview(out.preview); dirty.current = false
      toast(`已写 ${out.path}/agent.cordis.yml`)
      await onSaved()
      if (!id) go(`agents/${spec.id}`)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy('') }
  }
  const del = async () => {
    if (!row || !window.confirm(`删除 preset 目录 ${row.path}?已跑过的会话不受影响。`)) return
    setBusy('del')
    try { await api.deleteAgent(row.id); toast('已删除'); await onSaved(); go('agents') } catch (e) { setErr(String((e as Error).message ?? e)) } finally { setBusy('') }
  }
  const copy = () => { stash = { ...spec, id: `${spec.id}-copy`, name: `${spec.name}(副本)` }; go('agents/new') }
  const tryRun = async () => {
    if (!row || dirty.current) { setErr('先保存,再试跑 —— 试跑挂的是磁盘上的 preset'); return }
    setRun('running'); setErr('')
    try { setRun(await api.tryRun(row.id)) } catch (e) { setRun(null); setErr(String((e as Error).message ?? e)) }
  }

  const perm = preview?.permission ?? derivePerm(spec)
  const groups = [...new Set((catalog?.tools ?? []).map(t => t.group))]
  const writes = spec.tools.filter(t => catalog?.tools.find(x => x.id === t)?.writes)
  const missingMcp = spec.mcp.filter(m => !catalog?.mcp.some(x => x.serverName === m))

  return (
    <>
      <div className="dtc-crumb"><a onClick={() => go('agents')}>Agent</a><span>/</span><span>{row ? row.name : '新建'}</span></div>
      <div className="dtc-h1">{row ? row.name : '新建 Agent'} <span className={`dtc-pill ${PERM[perm].cls}`}>{PERM[perm].label}</span>
        {readOnly ? <span className="dtc-pill dtc-p-grey">出厂,只能复制</span> : null}
        <span className="dtc-acts">
          {row ? <button className="dtc-btn" onClick={tryRun} disabled={run === 'running'}>{run === 'running' ? <><span className="dtc-spin" /> 试跑中</> : '试跑'}</button> : null}
          <button className="dtc-btn" onClick={copy}>复制</button>
          {row && !readOnly ? <button className="dtc-btn danger" onClick={del} disabled={busy === 'del'}>删除</button> : null}
          {!readOnly ? <button className="dtc-btn pri" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? '写入中…' : '保存 → 写 preset'}</button> : null}
        </span>
      </div>
      {err ? <div className="dtc-err">{err}</div> : null}
      {readOnly ? <div className="dtc-warn">出厂 preset 由部署提供,任务台不改它。点「复制」得到一份可编辑的副本。</div> : null}

      <div className="dtc-two">
        <div>
          <div className="dtc-panel"><h3>身份</h3>
            <div className="dtc-fields">
              <label>名字<input value={spec.name} disabled={readOnly} onChange={e => set('name', e.target.value)} placeholder="巡检员" /></label>
              <label>id(目录名)<input className="dtc-mono" value={spec.id} disabled={readOnly || !!row} onChange={e => set('id', e.target.value.toLowerCase())} placeholder="inspector" /></label>
              <label className="wide">一句话说明<input value={spec.description} disabled={readOnly} onChange={e => set('description', e.target.value)} placeholder="给建任务的人看的" /></label>
              <label>模型(provider/model)<input list="dtc-models" className="dtc-mono" value={spec.model} disabled={readOnly} onChange={e => set('model', e.target.value)} />
                <datalist id="dtc-models">{(catalog?.models ?? []).map(m => <option key={m} value={m} />)}</datalist></label>
              <label>推理强度<select value={spec.effort} disabled={readOnly} onChange={e => set('effort', e.target.value as AgentSpec['effort'])}>
                <option value="">默认</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label>
            </div>
          </div>
          <div className="dtc-panel"><h3>人设 <span className="dtc-faint" style={{ fontWeight: 400 }}>→ dsh-persona 行</span></h3>
            <textarea value={spec.persona} disabled={readOnly} onChange={e => set('persona', e.target.value)} placeholder="职责、边界、交卷格式" />
          </div>
          <div className="dtc-panel"><h3>工具 <span className="dtc-faint" style={{ fontWeight: 400 }}>没勾的,模型连 schema 都看不到 —— 这就是权限</span></h3>
            {groups.map(g => (
              <div key={g}>
                <div className="dtc-tgroup">{g}</div>
                <div className="dtc-tools">
                  {(catalog?.tools ?? []).filter(t => t.group === g).map(t => (
                    <label key={t.id} className={`dtc-tl ${spec.tools.includes(t.id) ? 'on' : ''}`}>
                      <input type="checkbox" checked={spec.tools.includes(t.id)} disabled={readOnly} onChange={() => toggle('tools', t.id)} />
                      <span><span className="tn dtc-mono">{t.label}</span>{t.writes ? <span className="w">可写</span> : null}<div className="td">{t.description}</div></span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <div className="dtc-tgroup">MCP(宿主正在跑的服务,整台勾选)</div>
            <div className="dtc-tools">
              {(catalog?.mcp ?? []).map(m => (
                <label key={m.serverName} className={`dtc-tl ${spec.mcp.includes(m.serverName) ? 'on' : ''}`}>
                  <input type="checkbox" checked={spec.mcp.includes(m.serverName)} disabled={readOnly} onChange={() => toggle('mcp', m.serverName)} />
                  <span><span className="tn dtc-mono">{m.serverName}</span>{m.disabled ? <span className="w">已停</span> : null}
                    <div className="td">{m.target}</div>
                    <div className="td">{m.tools.length ? m.tools.join(' · ') : '(还没注册工具)'}</div></span>
                </label>
              ))}
              {!catalog?.mcp.length ? <div className="dtc-faint" style={{ fontSize: 12.5 }}>宿主没有 MCP 服务。</div> : null}
            </div>
            <div className="dtc-note">{writes.length || spec.mcp.length
              ? <>推出来的权限:<b>{PERM[perm].label}</b>{writes.length ? <> —— 勾了可写工具 {writes.map(w => <span key={w} className="dtc-mono">{w} </span>)}</> : null}{spec.mcp.length ? <>;MCP 服务按整台算受限可写</> : null}</>
              : <>推出来的权限:<b>只读</b> —— 没有任何可写工具,它不可能改任何东西。</>}</div>
            {missingMcp.length ? <div className="dtc-warn">选了宿主里没有的 MCP:{missingMcp.join(', ')},生成时会跳过。</div> : null}
            {preview?.renamed.length ? <div className="dtc-warn">宿主层仍在跑 {preview.renamed.map(r => r.from).join('、')},preset 里改名为 {preview.renamed.map(r => r.to).join('、')} 挂载。这意味着<b>所有 agent 现在都看得到宿主那份</b>;要真正围栏,得把宿主那行摘掉。</div> : null}
          </div>
          <div className="dtc-panel"><h3>Skill <span className="dtc-faint" style={{ fontWeight: 400 }}>拷进 preset 的 skills/,随它走</span></h3>
            <div className="dtc-chips">
              {spec.skills.map(s => <button key={s} className="dtc-chip on" disabled={readOnly} onClick={() => toggle('skills', s)}>{s}</button>)}
              {!readOnly ? <select value="" onChange={e => { if (e.target.value) toggle('skills', e.target.value) }}>
                <option value="">＋ 从技能库添加</option>
                {(catalog?.skills ?? []).filter(s => !spec.skills.includes(s.name)).map(s => <option key={s.dir} value={s.name}>{s.name} · {s.root}</option>)}
              </select> : null}
            </div>
          </div>
        </div>
        <div>
          <div className="dtc-panel dtc-sticky"><h3>生成的 preset <span className="sp" /><span className="dtc-mono dtc-faint" style={{ fontWeight: 400, fontSize: 11.5 }}>{row?.path ?? `${catalog?.userRoot ?? '~/.dsh/.agent-presets'}/${spec.id || '<id>'}`}/agent.cordis.yml</span></h3>
            {readOnly
              ? <div className="dtc-note">出厂 preset 的组合文件在 dsh 安装目录里,任务台不展示、不改。</div>
              : <div className="dtc-yml">{preview?.yml ?? (spec.id && spec.name ? '生成中…' : '填好 id 和名字后生成')}</div>}
            <p className="dtc-note">保存即写目录;dsh 热读取 preset 根,新会话立刻能选到,不重启。令牌在这里打码,文件里是原样。</p>
          </div>
        </div>
      </div>

      {run && run !== 'running' ? <TryRunModal result={run} onClose={() => setRun(null)} /> : null}
    </>
  )
}

function TryRunModal({ result, onClose }: { result: TryRunResult; onClose: () => void }) {
  const dshTools = result.tools
  const hasBash = dshTools.includes('bash')
  const cli = /^(claude|codex)-local$/.test(result.provider)
  return (
    <div className="dtc-modal" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dtc-mbox dtc-root">
        <div className="mh">试跑 · 真实会话 <span className="dtc-mono dtc-faint" style={{ fontWeight: 400, fontSize: 12 }}>{result.sessionId}</span><button className="dtc-close" onClick={onClose}>×</button></div>
        <div className="mb">
          {result.error ? <div className="dtc-err">{result.error}</div> : null}
          <div className="dtc-kv">
            <span className="k">模型</span><span className="dtc-mono">{result.provider}/{result.model}</span>
            <span className="k">耗时</span><span>{(result.elapsedMs / 1000).toFixed(1)}s</span>
            <span className="k">dsh 交出的工具</span><span><b>{dshTools.length}</b> 个 · {hasBash ? <span className="dtc-pill dtc-p-bad">含 bash</span> : <span className="dtc-pill dtc-p-ok">不含 bash</span>}</span>
          </div>
          <p className="dtc-note">下面这份来自 session 日志的 <span className="dtc-mono">request/header</span>,是 dsh 真正交给模型的 schema 清单——不是模型自述。</p>
          <div className="dtc-list">{dshTools.map(t => <div key={t} className="dtc-mono">{t}</div>)}</div>
          {cli ? <div className="dtc-warn">{result.provider} 是 CLI 型 provider,自带 Bash / Edit 等原生工具,dsh 的围栏管不到它们。要限制它的 shell,得在 provider 侧配 sandbox / permissionMode(下一步)。</div> : null}
          <p className="dtc-note">模型的回答:</p>
          <div className="dtc-answer">{result.answer || '(没有文本回复)'}</div>
        </div>
      </div>
    </div>
  )
}
