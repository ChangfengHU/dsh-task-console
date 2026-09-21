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
  return Number.isFinite(time) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(time)).replaceAll('/', '-') : '尚无快照'
}

function missingByServer(names: string[]) {
  const groups = new Map<string, string[]>()
  for (const name of names) {
    const match = /^mcp__(.+?)__(.+)$/.exec(name), server = match?.[1] ?? '其他能力'
    groups.set(server, [...(groups.get(server) ?? []), match?.[2] ?? name])
  }
  return [...groups.entries()]
}

/** Same host snapshot as session_capabilities; mounted only when this tab is opened. */
export function SessionCapabilitiesView({ sessionId }: { sessionId: string }) {
  const [value, setValue] = useState<any>(), [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [query, setQuery] = useState(''), [issuesOnly, setIssuesOnly] = useState(false)
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
  const mcp = tools.filter((tool: any) => tool.kind === 'mcp')
  const native = tools.filter((tool: any) => tool.kind !== 'mcp' && tool.name !== 'skill')
  const mcpGroups = [...mcp.reduce((groups: Map<string, any[]>, tool: any) => {
    const key = tool.server ?? '未识别服务'
    groups.set(key, [...(groups.get(key) ?? []), tool]); return groups
  }, new Map<string, any[]>()).entries()]
  const normalizedQuery = query.trim().toLowerCase()
  const visibleMcpGroups = mcpGroups.map(([server, rows]) => [server, rows.filter((tool: any) => (!issuesOnly || tool.state === 'restricted' || tool.lastFailure) && (!normalizedQuery || `${server} ${tool.name}`.toLowerCase().includes(normalizedQuery)))] as [string, any[]]).filter(([, rows]) => rows.length)
  const explicitMcp = mcp.filter((tool: any) => tool.source === 'agent-definition')
  const explicitSkills = skills.filter((skill: any) => skill.source === 'agent-definition')
  const generic = value?.definition?.role === 'standard' && !value?.definition?.authored
  const missing = current?.configuredButNotRegistered ?? []
  const failures = tools.filter((tool: any) => tool.lastFailure)
  const restricted = tools.filter((tool: any) => tool.state === 'restricted')
  const issueCount = new Set([...missing, ...failures.map((tool: any) => tool.name), ...restricted.map((tool: any) => tool.name)]).size
  const role = generic ? '通用 Agent' : value?.definition?.name ?? value?.definition?.role ?? '未识别 Agent'
  const conclusion = issueCount ? `${role}：发现 ${issueCount} 项能力异常，需要检查` : `${role}：${mcp.length} 项 MCP 工具已注册，未发现加载异常`

  return <section className="dtc-capabilities" aria-label="Session capabilities">
    <header className="dtc-cap-head">
      <div><span className="dtc-kicker">CAPABILITIES</span><h2>当前会话能力</h2><p>展示当前会话真实加载结果；已注册不代表凭据有效，也不代表所有操作均获授权。</p></div>
      <div className="dtc-cap-actions"><span className={'dtc-cap-live ' + (value?.live ? 'on' : '')}>{value?.live ? '当前运行时' : '历史 / 尚未观测'}</span><button className="dtc-btn sm" onClick={() => setRevision(x => x + 1)}>刷新</button></div>
    </header>
    {error ? <div className="dtc-err" role="alert">{error} · 当前内容可能已过期</div> : null}
    {!value ? <div className="dtc-cap-loading"><i>◌</i><b>正在读取能力事实…</b><span>不会执行业务探测</span></div> : <>
      <section className={'dtc-cap-summary ' + (issueCount ? 'warn' : 'ok')}>
        <div><span className="dtc-cap-summary-icon">{issueCount ? '!' : '✓'}</span><div><h3>{conclusion}</h3><p>{issueCount ? '展开异常分组可查看具体缺项；页面不会自动执行修复。' : '这是注册与加载结论，业务连通性仍以实际调用结果为准。'}</p></div></div>
        <dl><div><dt>Agent</dt><dd>{role}</dd></div><div><dt>MCP</dt><dd>{mcpGroups.length} 服务 · {mcp.length} 工具</dd></div><div><dt>Skill / Tool</dt><dd>{skills.length} / {native.length}</dd></div><div><dt>权限预设</dt><dd>{current?.permissionPreset ?? '尚未观测'}</dd></div><div><dt>核对时间（北京时间）</dt><dd>{checkedAt(value.checkedAt)}</dd></div></dl>
      </section>
      <section className="dtc-cap-scope"><header><div><span className="dtc-kicker">{generic ? 'ENVIRONMENT' : 'THIS AGENT'}</span><h3>{generic ? '环境继承能力' : 'Agent 专属能力'}</h3></div><small>{generic ? '默认继承当前环境目录' : `${explicitMcp.length} MCP 工具 · ${explicitSkills.length} Skill`}</small></header>
        <div className="dtc-cap-scope-grid"><div><b>MCP 服务</b><span>{generic ? `${mcpGroups.length} 个当前已注册服务` : [...new Set(explicitMcp.map((tool: any) => tool.server))].filter(Boolean).join('、') || '未配置'}</span></div><div><b>Skill</b><span>{generic ? `${skills.length} 项可按需加载` : explicitSkills.map((skill: any) => skill.name).join('、') || '未配置'}</span></div><div><b>原生 Tool</b><span>{native.filter((tool: any) => generic || tool.source === 'agent-definition' || tool.source === 'platform').length} 项当前可见</span></div></div>
      </section>
      <div className="dtc-cap-grid">
        <section className="dtc-cap-card dtc-cap-mcp"><header><div><span className="dtc-kicker">MCP</span><h3>服务与工具</h3></div><small>{mcpGroups.length} 服务 · {mcp.length} 工具</small></header><div className="dtc-cap-filters"><input aria-label="搜索 MCP 服务或工具" placeholder="搜索服务或工具" value={query} onChange={event => setQuery(event.target.value)} /><button className={issuesOnly ? 'active' : ''} onClick={() => setIssuesOnly(value => !value)}>{issuesOnly ? '显示全部' : `仅看异常${issueCount ? ` · ${issueCount}` : ''}`}</button></div><div className="dtc-cap-list">{visibleMcpGroups.length ? visibleMcpGroups.map(([server, rows]) => { const unhealthy = rows.filter((row: any) => row.state === 'restricted' || row.lastFailure).length; return <details className="dtc-cap-service" key={server}><summary><b>{server}</b><span className={unhealthy ? 'bad' : 'good'}>{rows.length} 工具 · {unhealthy ? `${unhealthy} 项异常` : '已注册'}</span></summary>{rows.map((tool: any) => <div className="dtc-cap-row" key={tool.name}><div><b>{tool.name.replace(/^mcp__.+?__/, '')}</b><span>{label(tool.source)}</span></div>{tool.lastFailure ? <em>{label(tool.lastFailure)}</em> : <i className={tool.state === 'restricted' ? 'bad' : 'good'}>{tool.state === 'restricted' ? '受限' : '已注册'}</i>}</div>)}</details> }) : <p className="dtc-cap-empty">没有符合当前筛选条件的 MCP 工具。</p>}</div></section>
        <section className="dtc-cap-card"><header><div><span className="dtc-kicker">SKILL & TOOL</span><h3>按需 Skill 与工具</h3></div><small>{skills.length + native.length} 项</small></header><div className="dtc-cap-list"><details className="dtc-cap-service"><summary><b>Skill</b><span>{skills.length} 项 · 按需加载</span></summary>{skills.map((skill: any) => <div className="dtc-cap-row" key={skill.name}><div><b>{skill.name}</b><span>{label(skill.source)} · {label(skill.state)}</span></div><i>{skill.state === 'not-callable' ? '受限' : '查看'}</i></div>)}</details><details className="dtc-cap-service"><summary><b>Tool</b><span>{native.length} 项当前可见</span></summary>{native.map((tool: any) => <div className="dtc-cap-row" key={tool.name}><div><b>{tool.name}</b><span>{label(tool.source)} · {label(tool.state)}</span></div><i>查看</i></div>)}</details></div></section>
      </div>
      {missing.length ? <section className="dtc-cap-warning"><b>已配置但未注册 · {missing.length} 项</b>{missingByServer(missing).map(([server, names]) => <details key={server}><summary>{server}<span>{names.length} 项</span></summary><p>{names.join('、')}</p></details>)}</section> : null}
      <section className="dtc-cap-diagnostics"><header><span className="dtc-kicker">DIAGNOSTICS</span><h3>策略与原始事实</h3><p>需要核对继承、模型请求或角色声明时再展开；不会遮住日常能力清单。</p></header>
        {value.inheritancePolicy ? <details><summary>通用 Agent 默认继承与显式排除</summary><div><p>Skill：{value.inheritancePolicy.skills} · MCP：{value.inheritancePolicy.mcp}</p><p>排除 Skill：{value.inheritancePolicy.excludedSkills?.join('、') || '无'}</p><p>排除 MCP：{value.inheritancePolicy.excludedMcpServers?.join('、') || '无'}</p><p>排除工具：{value.inheritancePolicy.excludedTools?.join('、') || '无'}</p></div></details> : null}
        <details><summary>角色定义（不是实际加载结果）</summary><pre>{JSON.stringify(value.definition ?? {}, null, 2)}</pre></details>
        {value.lastModelRequest ? <details><summary>最近实际发送给模型的工具 · {value.lastModelRequest.tools.length} 项</summary><div><p>{value.lastModelRequest.provider} / {value.lastModelRequest.model} · {checkedAt(value.lastModelRequest.checkedAt)}</p><pre>{value.lastModelRequest.tools.join('\n')}</pre></div></details> : null}
      </section>
    </>}
  </section>
}
