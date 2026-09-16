import { useEffect, useMemo, useState } from 'react'

const labels: Record<string, string> = {
  'agent-definition': '角色配置', 'environment-inherited': '环境继承', platform: '平台内置',
  registered: '已注册 · 执行仍受权限检查', restricted: '受限 · 不可调用',
  'authentication-failed': '最近调用认证失败', 'permission-or-identity-denied': '最近调用权限/身份被拒绝',
  'last-call-failed': '最近调用失败', 'available-on-demand': '可按需加载',
  'loaded-in-session-history': '会话历史已加载', 'not-callable': '当前不可调用',
}

function label(value: unknown) { return labels[String(value)] ?? String(value ?? '未知') }
function checkedAt(value: unknown) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) ? new Date(time).toLocaleString() : '尚无快照'
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

  const current = value?.current
  const tools = current?.tools ?? [], skills = current?.skills ?? []
  const states = useMemo(() => ({
    callable: tools.filter((item: any) => item.state !== 'not-callable' && item.state !== 'restricted').length,
    restricted: tools.filter((item: any) => item.state === 'not-callable' || item.state === 'restricted').length,
  }), [tools])

  return <section className="dtc-capabilities" aria-label="Session capabilities">
    <header className="dtc-cap-head">
      <div><span className="dtc-kicker">LIVE CAPABILITY SNAPSHOT</span><h2>当前会话能力</h2><p>来自宿主真实注册与本会话观察；登记在册不等于已获鉴权或允许执行。</p></div>
      <div className="dtc-cap-actions"><span className={'dtc-cap-live ' + (value?.live ? 'on' : '')}>{value?.live ? '当前运行时' : '历史 / 尚未观测'}</span><button className="dtc-btn sm" onClick={() => setRevision(x => x + 1)}>刷新</button></div>
    </header>
    {error ? <div className="dtc-err" role="alert">{error} · 当前内容可能已过期</div> : null}
    {!value ? <div className="dtc-cap-loading"><i>◌</i><b>正在读取能力事实…</b><span>不会执行业务探测</span></div> : <>
      <div className="dtc-cap-overview">
        <div><span>当前角色</span><b>{value.definition?.role ?? '未知'}</b></div>
        <div><span>最后核对</span><b>{checkedAt(value.checkedAt)}</b></div>
        <div><span>可用工具</span><b>{states.callable}<small> / {tools.length}</small></b></div>
        <div><span>可按需 Skill</span><b>{skills.length}</b></div>
      </div>
      <p className="dtc-cap-notice">{value.notice ?? '已注册不代表凭据有效或所有目标操作获授权。此页面不执行任何业务探测。'}</p>
      <div className="dtc-cap-grid">
        <section className="dtc-cap-card"><header><div><span className="dtc-kicker">TOOLS</span><h3>实际工具与环境继承</h3></div><small>{tools.length} 项 · {states.restricted ? `${states.restricted} 受限` : '无受限项'}</small></header>
          <div className="dtc-cap-list">{tools.length ? tools.map((tool: any) => <div className="dtc-cap-row" key={tool.name}><div><b>{tool.name}</b><span>{label(tool.source)} · {label(tool.state)}</span></div>{tool.lastFailure ? <em>{label(tool.lastFailure)}</em> : <i>可见</i>}</div>) : <p className="dtc-cap-empty">本会话尚无可观察的工具。</p>}</div>
          {current?.configuredButNotRegistered?.length ? <p className="dtc-cap-warning">配置但未注册：{current.configuredButNotRegistered.join('、')}</p> : null}
        </section>
        <section className="dtc-cap-card"><header><div><span className="dtc-kicker">SKILLS</span><h3>Skill 与加载边界</h3></div><small>{skills.length} 项</small></header>
          <div className="dtc-cap-list">{skills.length ? skills.map((skill: any) => <div className="dtc-cap-row" key={skill.name}><div><b>{skill.name}</b><span>{label(skill.source)} · {label(skill.state)}</span></div><i>{skill.state === 'not-callable' ? '受限' : '按需'}</i></div>) : <p className="dtc-cap-empty">当前没有可观察的 Skill。</p>}</div>
          <p className="dtc-cap-foot">底层 CLI：{value.cliInheritance === 'not-observed' ? '尚无运行时证据，不宣称已加载' : '本页只反映 DSH 工具运行时'}</p>
        </section>
      </div>
      <section className="dtc-cap-diagnostics"><header><span className="dtc-kicker">DIAGNOSTICS</span><h3>策略与原始事实</h3><p>需要核对继承、模型请求或角色声明时再展开；不会遮住日常能力清单。</p></header>
        {value.inheritancePolicy ? <details><summary>通用 Agent 默认继承与显式排除</summary><div><p>Skill：{value.inheritancePolicy.skills} · MCP：{value.inheritancePolicy.mcp}</p><p>排除 Skill：{value.inheritancePolicy.excludedSkills?.join('、') || '无'}</p><p>排除 MCP：{value.inheritancePolicy.excludedMcpServers?.join('、') || '无'}</p><p>排除工具：{value.inheritancePolicy.excludedTools?.join('、') || '无'}</p></div></details> : null}
        <details><summary>角色定义（不是实际加载结果）</summary><pre>{JSON.stringify(value.definition ?? {}, null, 2)}</pre></details>
        {value.lastModelRequest ? <details><summary>最近实际发送给模型的工具 · {value.lastModelRequest.tools.length} 项</summary><div><p>{value.lastModelRequest.provider} / {value.lastModelRequest.model} · {checkedAt(value.lastModelRequest.checkedAt)}</p><pre>{value.lastModelRequest.tools.join('\n')}</pre></div></details> : null}
      </section>
    </>}
  </section>
}
