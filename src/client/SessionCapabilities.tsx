import { useEffect, useState } from 'react'

const labels: Record<string, string> = {
  'agent-definition': '角色配置', 'environment-inherited': '环境继承', platform: '平台内置',
  registered: '已注册 · 执行仍受权限检查', restricted: '受限 · 不可调用',
  'authentication-failed': '最近调用认证失败', 'permission-or-identity-denied': '最近调用权限/身份被拒绝',
  'last-call-failed': '最近调用失败', 'available-on-demand': '可按需加载',
  'loaded-in-session-history': '会话历史已加载', 'not-callable': '当前不可调用',
}

/** Same host snapshot as session_capabilities; mounted only when this tab is opened. */
export function SessionCapabilitiesView({ sessionId }: { sessionId: string }) {
  const [value, setValue] = useState<any>(), [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let live = true
    setValue(undefined); setError('')
    const load = async () => {
      try {
        const method = 'taskConsole/sessionCapabilities'
        const response = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: { payload: JSON.stringify({ sessionId }) } } }) })
        if (!response.ok) throw Error(`读取失败（HTTP ${response.status}）`)
        const result = (await response.json()).result
        if (!result?.ok) throw Error('读取当前能力失败')
        if (live) { setValue(typeof result.value === 'string' ? JSON.parse(result.value) : result.value); setError('') }
      } catch (e) { if (live) setError(String((e as Error).message)) }
    }
    void load()
    const timer = window.setInterval(() => { if (!document.hidden) void load() }, 15000)
    return () => { live = false; clearInterval(timer) }
  }, [sessionId, revision])
  return <section style={{ padding: 16, color: 'var(--dsw-alias-label-primary)', overflow: 'auto', height: '100%', boxSizing: 'border-box' }} aria-label="Session capabilities">
    <h3>当前会话能力 <button style={{ color: 'inherit', background: 'transparent', border: '1px solid var(--dsw-alias-border-primary, #80808040)', borderRadius: 6, padding: '3px 10px', cursor: 'pointer' }} onClick={() => setRevision(x => x + 1)}>刷新</button></h3>
    {error ? <p role="alert">{error} · 当前内容可能已过期</p> : null}
    {!value ? <p>正在读取能力事实…</p> : <>
      <p>角色：{value.definition?.role ?? '未知'} · {value.live ? '当前运行时' : '历史 / 尚未观测'} · {value.checkedAt ? new Date(value.checkedAt).toLocaleString() : '无快照'}</p>
      <p>{value.notice ?? '已注册不代表凭据有效或所有目标操作获授权。此页面不执行任何业务探测。'}</p>
      {value.inheritancePolicy ? <details><summary>通用 Agent：默认继承 · 显式排除</summary>
        <p>Skill：{value.inheritancePolicy.skills} · MCP：{value.inheritancePolicy.mcp}</p>
        <p>排除 Skill：{value.inheritancePolicy.excludedSkills?.join('、') || '无'}</p>
        <p>排除 MCP：{value.inheritancePolicy.excludedMcpServers?.join('、') || '无'}</p>
        <p style={{ overflowWrap: 'anywhere' }}>排除工具：{value.inheritancePolicy.excludedTools?.join('、') || '无'}</p>
        <p>仅适用于通用 Agent；专用角色、原生审批及服务端鉴权保持不变。历史已加载内容不会被抹除。</p>
      </details> : null}
      <details><summary>角色定义（不是实际加载结果）</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(value.definition ?? {}, null, 2)}</pre></details>
      {value.lastModelRequest ? <details><summary>最近实际发送给模型的工具 · {value.lastModelRequest.tools.length} 项</summary><p>{value.lastModelRequest.provider} / {value.lastModelRequest.model} · {new Date(value.lastModelRequest.checkedAt).toLocaleString()}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value.lastModelRequest.tools.join('\n')}</pre></details> : null}
      <h4>实际工具与环境继承</h4>
      {(value.current?.tools ?? []).map((t: any) => <div key={t.name} style={{ padding: '8px 0', borderBottom: '1px solid var(--border-color, #80808040)', overflowWrap: 'anywhere' }}>
        <div>{t.name}</div><small>{labels[t.source] ?? t.source} · {labels[t.state] ?? t.state}{t.lastFailure ? ` · ${labels[t.lastFailure] ?? t.lastFailure}` : ''}</small>
      </div>)}
      <h4>Skill</h4>
      {(value.current?.skills ?? []).map((s: any) => <p key={s.name}>{s.name} · {labels[s.source] ?? s.source} · {labels[s.state] ?? s.state}</p>)}
      {value.current?.configuredButNotRegistered?.length ? <p>配置但未注册：{value.current.configuredButNotRegistered.join('、')}</p> : null}
      <p>底层 CLI 额外继承：{value.cliInheritance === 'not-observed' ? '尚无运行时证据，不宣称已加载' : '本页只反映 DSH 工具运行时'}</p>
    </>}
  </section>
}
