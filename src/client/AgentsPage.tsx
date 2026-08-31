/**
 * Agent: a master-detail page. Left, the roster; right, one agent — its
 * persona, the tools it may see (the fence), its MCP servers and skills,
 * what it has been doing, and the preset file the editor writes.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentRow, AgentSpec, Catalog, Preview, TryRunResult } from '../wire.ts'
import { closeConsole, go, type Api } from './Console.tsx'

const EMPTY: AgentSpec = { id: '', name: '', description: '', persona: '', model: '', effort: 'medium', tools: ['ask-user'], mcp: [], skills: [] }
const PERM: Record<Preview['permission'], { label: string; cls: string; dot: string }> = {
  'read-only': { label: '只读', cls: 'dtc-p-ok', dot: 'ro' },
  'limited-write': { label: '受限可写', cls: 'dtc-p-warn', dot: 'lw' },
  'write': { label: '可写', cls: 'dtc-p-bad', dot: 'w' },
}
const COLORS = ['#1f6f78', '#1f7a4d', '#6b4fbb', '#2563a8', '#b26a00', '#8e5a8a', '#3b6e5a']
export const colorOf = (id: string) => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length] }
export function derivePerm(spec: AgentSpec): Preview['permission'] {
  if (spec.tools.some(t => t === 'bash' || t === 'fs' || t === 'str-replace-editor')) return 'write'
  if (spec.tools.some(t => t === 'fs' || t === 'bash') || spec.mcp.length) return 'limited-write'
  return 'read-only'
}

/** Prefill stash for "复制" — survives one navigation. */
let stash: AgentSpec | null = null

export function AgentsPage({ api, catalog, agents, id, onSaved, toast }: { api: Api; catalog: Catalog; agents: AgentRow[]; id: string | null | 'new'; onSaved: () => Promise<void>; toast: (m: string) => void }) {
  const [q, setQ] = useState('')
  const list = agents.filter(a => !q || a.name.includes(q) || a.id.includes(q))
  const cur = id === 'new' ? null : (id ?? agents[0]?.id ?? null)
  return (
    <div className="dtc-agents">
      <div className="dtc-alist">
        <div className="search"><input placeholder="搜 Agent" value={q} onChange={e => setQ(e.target.value)} /></div>
        <div className="items">
          {list.map(a => { const perm = a.spec ? derivePerm(a.spec) : null; return (
            <div key={a.id} className={`dtc-aitem ${a.id === cur ? 'on' : ''}`} onClick={() => go(`agents/${a.id}`)}>
              <div className="av" style={{ background: a.trust === 'system' ? 'var(--dtc-faint)' : colorOf(a.id) }}>{a.name[0]}</div>
              <div><div className="nm">{a.name} <span className="dtc-mono dtc-faint" style={{ fontWeight: 400, fontSize: 11 }}>{a.id}</span></div><div className="d">{a.broken ?? a.description}</div></div>
              <span className={`perm ${a.broken ? 'bad' : perm ? PERM[perm].dot : 'sys'}`} title={a.broken ? '坏了' : perm ? PERM[perm].label : '出厂'} />
            </div>) })}
        </div>
        <button className="dtc-btn newbtn" onClick={() => go('agents/new')}>＋ 新建 Agent</button>
      </div>
      <div className="dtc-adetail">
        <AgentEditor key={id === 'new' ? 'new' : cur ?? 'none'} api={api} catalog={catalog} agents={agents} id={id === 'new' ? null : cur} onSaved={onSaved} toast={toast} />
      </div>
    </div>
  )
}

function ActivityCard({ api, id }: { api: Api; id: string }) {
  const [a, setA] = useState<{ cards: number; done: number; failed: number; runs: number; lastRunAt: string | null; lastOutcome: string | null; tasks: { id: string; title: string }[] } | null>(null)
  useEffect(() => { let stop = false; api.agentActivity(id).then(x => { if (!stop) setA(x) }).catch(() => undefined); return () => { stop = true } }, [api, id])
  if (!a) return <div className="dtc-panel"><h3>近况</h3><div className="dtc-faint">读取…</div></div>
  const when = a.lastRunAt ? new Date(a.lastRunAt).toLocaleString('zh-CN', { hour12: false }) : '—'
  return (
    <div className="dtc-panel"><h3>近况</h3>
      <div className="dtc-kv">
        <span className="k">接过的卡</span><span>{a.cards} 张 · 完成 {a.done}{a.failed ? ` · 失败 ${a.failed}` : ''}</span>
        <span className="k">运行</span><span>{a.runs} 次{a.lastOutcome ? ` · 最近 ${when} · ${a.lastOutcome}` : ''}</span>
        <span className="k">参与任务</span><span>{a.tasks.length ? a.tasks.map(t => <a key={t.id} style={{ color: 'var(--dtc-accent)', cursor: 'pointer', display: 'block' }} onClick={() => go(`tasks/${t.id}`)}>{t.title}</a>) : '—'}</span>
      </div>
    </div>
  )
}

function AgentEditor({ api, catalog, agents, id, onSaved, toast }: { api: Api; catalog: Catalog; agents: AgentRow[]; id: string | null; onSaved: () => Promise<void>; toast: (m: string) => void }) {
  const row = id ? agents.find(a => a.id === id) : undefined
  const readOnly = !!row && row.trust === 'system'
  const initial = useMemo<AgentSpec>(() => {
    if (!id && stash) { const s = stash; stash = null; return s }
    if (row?.spec) return row.spec
    if (row) return { ...EMPTY, id: row.id, name: row.name, description: row.description }
    return { ...EMPTY, model: catalog.defaultModel }
  }, [id, row, catalog.defaultModel])
  const [spec, setSpec] = useState<AgentSpec>(initial)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [run, setRun] = useState<TryRunResult | 'running' | null>(null)
  const [showYml, setShowYml] = useState(false)
  const dirty = useRef(false)

  useEffect(() => { if (row && !dirty.current) setSpec(initial) }, [row, initial])
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
    try { const out = await api.saveAgent(spec); setPreview(out.preview); dirty.current = false; toast(`已写 ${out.path}/agent.cordis.yml`); await onSaved(); if (!id) go(`agents/${spec.id}`) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy('') }
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
  const chat = async () => {
    if (!row) return
    try { const { sessionId } = await api.startAgentSession(row.id); toast(`已开 ${row.name} 的会话`); closeConsole(); await api.openSession(sessionId) } catch (e) { setErr(String((e as Error).message ?? e)) }
  }

  const perm = preview?.permission ?? derivePerm(spec)
  const groups = [...new Set(catalog.tools.map(t => t.group))]
  const writes = spec.tools.filter(t => catalog.tools.find(x => x.id === t)?.writes)
  const missingMcp = spec.mcp.filter(m => !catalog.mcp.some(x => x.serverName === m))
  const cli = /^(claude|codex)-local/.test(spec.model)
  const claude = /^claude-local/.test(spec.model)

  return (
    <>
      <div className="dtc-ahead">
        <div className="av" style={{ background: readOnly ? 'var(--dtc-faint)' : colorOf(spec.id || 'new') }}>{(spec.name || '新')[0]}</div>
        <div style={{ minWidth: 0 }}>
          <div className="name">{row ? row.name : '新建 Agent'}<span className={`dtc-pill ${PERM[perm].cls}`}>{PERM[perm].label}</span>{readOnly ? <span className="dtc-pill dtc-p-grey">出厂 · 只能复制</span> : null}{row?.broken ? <span className="dtc-pill dtc-p-bad">坏了</span> : null}</div>
          <div className="desc">{spec.description || (row ? '' : '给建任务的人看的一句话')}</div>
          <div className="dtc-faint" style={{ fontSize: 12, marginTop: 4 }}>preset · <span className="dtc-mono">{row?.path ?? `${catalog.userRoot ?? '~/.dsh/.agent-presets'}/${spec.id || '<id>'}`}</span>{spec.model ? <> · 模型 <span className="dtc-mono">{spec.model}{spec.effort ? ` · ${spec.effort}` : ''}</span></> : null}</div>
        </div>
        <div className="acts">
          {row && !row.broken ? <button className="dtc-btn pri" onClick={chat}>💬 开新会话</button> : null}
          {row ? <button className="dtc-btn" onClick={tryRun} disabled={run === 'running'}>{run === 'running' ? <><span className="dtc-spin" /> 试跑中</> : '试跑'}</button> : null}
          <button className="dtc-btn" onClick={copy}>复制</button>
          {row && !readOnly ? <button className="dtc-btn danger" onClick={del} disabled={busy === 'del'}>删除</button> : null}
          {!readOnly ? <button className={`dtc-btn ${row ? '' : 'pri'}`} onClick={save} disabled={busy === 'save'}>{busy === 'save' ? '写入中…' : '保存 → 写 preset'}</button> : null}
        </div>
      </div>
      {err ? <div className="dtc-err">{err}</div> : null}
      {readOnly ? <div className="dtc-warn">出厂 preset 由部署提供,任务台不改它。点「复制」得到一份可编辑的副本。</div> : null}
      {claude ? <div className="dtc-warn">claude-local 上 dsh 的工具都是延迟工具:这个 agent 用不了 MCP、问不了人、也交不了卷,<b>不能参与任务</b>。要参与任务请选 codex-local 或 API 型模型。</div> : cli ? <div className="dtc-note">codex-local 自带 shell:dsh 的工具围栏管不到它自己的 bash,只管 MCP / skill / 交卷。</div> : null}

      <div className="dtc-agrid">
        <div>
          <div className="dtc-panel"><h3>身份</h3>
            <div className="dtc-fields">
              <label>名字<input value={spec.name} disabled={readOnly} onChange={e => set('name', e.target.value)} placeholder="巡检员" /></label>
              <label>id(目录名)<input className="dtc-mono" value={spec.id} disabled={readOnly || !!row} onChange={e => set('id', e.target.value.toLowerCase())} placeholder="inspector" /></label>
              <label className="wide">一句话说明<input value={spec.description} disabled={readOnly} onChange={e => set('description', e.target.value)} placeholder="给建任务的人看的" /></label>
              <label>模型(provider/model)<input list="dtc-models" className="dtc-mono" value={spec.model} disabled={readOnly} onChange={e => set('model', e.target.value)} />
                <datalist id="dtc-models">{catalog.models.map(m => <option key={m} value={m} />)}</datalist></label>
              <label>推理强度<select value={spec.effort} disabled={readOnly} onChange={e => set('effort', e.target.value as AgentSpec['effort'])}>
                <option value="">默认</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label>
            </div>
          </div>
          <div className="dtc-panel"><h3>人设 <span className="dtc-faint" style={{ fontWeight: 400 }}>→ dsh-persona 行</span></h3>
            <textarea value={spec.persona} disabled={readOnly} onChange={e => set('persona', e.target.value)} placeholder="职责、边界、交卷格式" style={{ minHeight: 140 }} />
          </div>
          <div className="dtc-panel"><h3>工具 <span className="dtc-faint" style={{ fontWeight: 400 }}>没勾的,模型连 schema 都看不到 —— 这就是权限</span></h3>
            {groups.map(g => (
              <div key={g}>
                <div className="dtc-tgroup">{g}</div>
                <div className="dtc-matrix">
                  {catalog.tools.filter(t => t.group === g).map(t => (
                    <label key={t.id} className={`dtc-cap ${spec.tools.includes(t.id) ? 'on' : ''}`}>
                      <input type="checkbox" checked={spec.tools.includes(t.id)} disabled={readOnly} onChange={() => toggle('tools', t.id)} />
                      <span><span className="nm dtc-mono">{t.label}</span>{t.writes ? <span className="w">可写</span> : null}<span className="d">{t.description}</span></span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <div className="dtc-note">{writes.length || spec.mcp.length
              ? <>推出来的权限:<b>{PERM[perm].label}</b>{writes.length ? <> —— 勾了可写工具 {writes.map(w => <span key={w} className="dtc-mono">{w} </span>)}</> : null}{spec.mcp.length ? <>;MCP 服务按整台算受限可写</> : null}</>
              : <>推出来的权限:<b>只读</b> —— 没有任何可写工具,它不可能改任何东西。</>}</div>
          </div>
          <div className="dtc-panel"><h3>MCP <span className="dtc-faint" style={{ fontWeight: 400 }}>宿主正在跑的服务,整台勾选</span></h3>
            {catalog.mcp.map(m => (
              <label key={m.serverName} className={`dtc-mcprow ${spec.mcp.includes(m.serverName) ? 'on' : ''}`}>
                <input type="checkbox" checked={spec.mcp.includes(m.serverName)} disabled={readOnly} onChange={() => toggle('mcp', m.serverName)} />
                <div style={{ minWidth: 0 }}><div className="nm dtc-mono">{m.serverName}{m.disabled ? <span className="dtc-pill dtc-p-grey" style={{ marginLeft: 6 }}>已停</span> : null}</div><div className="url">{m.target}</div><div className="url">{m.tools.length ? m.tools.join(' · ') : '(还没注册工具)'}</div></div>
                <span className="cnt">{m.tools.length} 个工具</span>
              </label>
            ))}
            {!catalog.mcp.length ? <div className="dtc-faint" style={{ fontSize: 12.5 }}>宿主没有 MCP 服务。</div> : null}
            {missingMcp.length ? <div className="dtc-warn">选了宿主里没有的 MCP:{missingMcp.join(', ')},生成时会跳过。</div> : null}
            {preview?.renamed.length ? <div className="dtc-warn">宿主层仍在跑 {preview.renamed.map(r => r.from).join('、')},preset 里改名为 {preview.renamed.map(r => r.to).join('、')} 挂载。<b>所有 agent 现在都看得到宿主那份</b>;要真正围栏,得把宿主那行摘掉。</div> : null}
          </div>
          <div className="dtc-panel"><h3>Skill <span className="dtc-faint" style={{ fontWeight: 400 }}>拷进 preset 的 skills/,随它走</span></h3>
            <div className="dtc-chips">
              {spec.skills.map(s => <button key={s} className="dtc-chip on" disabled={readOnly} onClick={() => toggle('skills', s)}>{s}</button>)}
              {!readOnly ? <select value="" onChange={e => { if (e.target.value) toggle('skills', e.target.value) }}>
                <option value="">＋ 从技能库添加</option>
                {catalog.skills.filter(s => !spec.skills.includes(s.name)).map(s => <option key={s.dir} value={s.name}>{s.name} · {s.root}</option>)}
              </select> : null}
            </div>
          </div>
        </div>
        <div className="dtc-rail">
          {row ? <ActivityCard api={api} id={row.id} /> : null}
          <div className="dtc-disc">
            <button className="sum" onClick={() => setShowYml(v => !v)}>{showYml ? '▾' : '▸'} 生成的 preset 文件 <span className="dtc-mono dtc-faint" style={{ fontWeight: 400, fontSize: 11 }}>agent.cordis.yml</span></button>
            {showYml ? (readOnly ? <div className="dtc-note" style={{ padding: '0 14px 12px' }}>出厂 preset 的组合文件在 dsh 安装目录里,任务台不展示、不改。</div> : <div className="dtc-yml">{preview?.yml ?? (spec.id && spec.name ? '生成中…' : '填好 id 和名字后生成')}</div>) : null}
          </div>
          <p className="dtc-note">保存即写目录;dsh 热读取 preset 根,新会话立刻能选到,不重启。令牌在预览里打码,文件里是原样。</p>
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
          {cli ? <div className="dtc-warn">{result.provider} 是 CLI 型 provider,自带 Bash / Edit 等原生工具,dsh 的围栏管不到它们。</div> : null}
          <p className="dtc-note">模型的回答:</p>
          <div className="dtc-answer">{result.answer || '(没有文本回复)'}</div>
        </div>
      </div>
    </div>
  )
}
