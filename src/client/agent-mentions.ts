import type { AgentRow } from '../wire.ts'
import type { ActionCatalog, AgentAction } from '../agent-actions.ts'
import { actionCandidates } from '../agent-actions.ts'
import { confirmedActionRole, makeActionSnippet } from '../action-snippet.ts'
import { agentCandidates, AGENT_EXPAND, AGENT_COLLAPSE } from '../agent-order.ts'
import { ACTION_CHANGED, sendCurrentAction } from './action-dispatch.ts'
import { installActionSnippet } from './action-snippet.ts'
import type { Api } from './Console.tsx'

export function agentMentionSource(ctx: any, api: () => Promise<Api>, go: (path: string) => void) {
  const expanded = new Set<string>(), snippets = new Map<string, ReturnType<typeof installActionSnippet>>()
  let roster: AgentRow[] = [], workflows: any[] = [], refreshedAt = 0
  const catalogs = new Map<string, ActionCatalog>()
  const snapshot = () => ctx.sessions.list.getSnapshot()
  const role = (id: string) => confirmedActionRole(snapshot(), id)
  const selected = (id: string) => snapshot().current === id
  const canChooseAgent = (id: string) => !role(id) || snapshot().byId?.[id]?.blank === true
  const inputFor = (id: string) => ctx.get('conversation')?.input.for(ctx.sessions.scope(id))
  const cwd = (id: string) => snapshot().byId?.[id]?.cwd
  ctx.effect(() => {
    const dismiss = (id?: string) => { if (id) { try { ctx.inputTriggers.sessionOf(ctx.sessions.scope(id)).dismiss() } catch { /* input not mounted */ } } }
    let previous = snapshot().current, previousRole = previous ? role(previous) : null
    const stop = ctx.sessions.list.subscribe(() => {
      const id = snapshot().current, nextRole = id ? role(id) : null
      if (id === previous && nextRole === previousRole) return
      dismiss(previous); if (id !== previous) dismiss(id)
      previous = id; previousRole = nextRole
    })
    const clear = () => { refreshedAt = 0; catalogs.clear(); dismiss(snapshot().current) }
    window.addEventListener(ACTION_CHANGED, clear)
    return () => { stop(); window.removeEventListener(ACTION_CHANGED, clear); for (const s of snippets.values()) s.dispose(); snippets.clear() }
  }, 'task-console: action input lifecycle')
  const refresh = async () => {
    if (Date.now() - refreshedAt < 1500) return
    const service = await api(), [agents, tasks] = await Promise.all([service.agents(), service.workflowCatalog()])
    roster = agents.filter(a => !a.broken); workflows = tasks; refreshedAt = Date.now()
  }
  const catalogFor = async (agentId: string, sessionId?: string) => {
    const c = await (await api()).agentActions({ agentId, ...(sessionId ? { sessionId } : {}) })
    catalogs.set(agentId, c); return c
  }
  const claimAgent = (agent: AgentRow) => ({ claim: { token: `@${agent.name} `, hint: `要 ${agent.name} 做什么 · 新会话`, images: false,
    submit: async (text: string, actx: any) => { try { const service = await api(), out = await service.startAgentSession(agent.id, text, cwd(actx.session?.id ?? actx.sessionId)); await service.openSession(out.sessionId); return { kind: 'success' as const } } catch (e: any) { return { kind: 'error' as const, text: e.message } } },
  } })
  const claimTask = (task: any) => {
    const requestId = crypto.randomUUID()
    return { claim: { token: `@${task.title} `, hint: `提交 ${task.title} 的本次参数 · 新执行记录`, images: false,
      submit: async (text: string, actx: any) => { try { const out = await (await api()).launchWorkflow(task.id, text, requestId, cwd(actx.session?.id ?? actx.sessionId)); go(`tasks/${out.taskId}/runs/${out.batchId}`); return { kind: 'success' as const } } catch (e: any) { return { kind: 'error' as const, text: e.message } } },
    } }
  }
  const actionClaim = (sessionId: string, catalog: ActionCatalog, action: AgentAction, newSession: boolean) => {
    const prefix = newSession ? `@${catalog.name}/${action.name} ` : `@${action.name} `
    let uncertain = false
    return { token: prefix, hint: `${catalog.name} · ${action.name} · 填写占位符后发送`, images: false,
      submit: async (text: string) => {
        let dispatched = false
        try {
          if (uncertain) throw Error('上次发送结果未确认，请先检查会话记录，勿重复发送')
          if (!selected(sessionId)) throw Error('已切换会话，请回到原会话再发送')
          if (!newSession && role(sessionId) !== catalog.agentId) throw Error('当前角色已变化，请重新选择 Action')
          if (newSession && !canChooseAgent(sessionId)) throw Error('当前会话已有角色，请重新选择该角色的 Action')
          const message = snippets.get(sessionId)?.error()
          if (message) throw Error(message)
          const placeholders = makeActionSnippet(action).slots
          if (!text.trim() || placeholders.some(s => text.includes(s.marker)) || /\{\{[^{}]+\}\}/.test(text)) throw Error('请填写剩余占位符后再发送')
          const latest = await catalogFor(catalog.agentId!, newSession ? undefined : sessionId)
          if (latest.revision !== catalog.revision) throw Error('Action 已更新，请重新选择；当前草稿保留')
          const service = await api(), prompt = `[Action: ${action.name} · ${action.id}]\n${text.trim()}`
          if (!selected(sessionId) || (newSession ? !canChooseAgent(sessionId) : role(sessionId) !== catalog.agentId)) throw Error('会话或角色已变化；草稿保留，请重新确认')
          dispatched = true
          if (newSession) {
            const out = await service.startAgentSession(catalog.agentId!, prompt, cwd(sessionId))
            await service.openSession(out.sessionId).catch(() => { window.location.assign(`/?session=${encodeURIComponent(out.sessionId)}`) })
          } else await sendCurrentAction(ctx, sessionId, prompt)
          return { kind: 'success' as const }
        } catch (e: any) { uncertain ||= dispatched; return { kind: 'error' as const, text: e.message + (dispatched ? '。请检查会话记录，本次不会自动重发。' : '') } }
      },
    }
  }
  return {
    trigger: '@' as const, name: 'Agent', order: -10, warm: () => undefined,
    candidates: async (session: { sessionId: string }, request: { query: string; signal?: AbortSignal; position?: string }) => {
      const id = session.sessionId, expectedRole = role(id)
      if (!selected(id)) return []
      await refresh()
      const query = request.query ?? '', q = query.toLowerCase()
      // Explicit Agent selection before a conversation starts, represented in the draft.
      const choosing = canChooseAgent(id) ? roster.find(a => q.startsWith(`${a.id}/`)) : undefined
      let c: ActionCatalog | null = null
      try { if (choosing || expectedRole) c = await catalogFor(choosing?.id ?? expectedRole!, choosing ? undefined : id) } catch { /* preserve unrelated Agent/Task choices */ }
      // Discard out-of-order responses after New Session, role change, or cancelled search.
      if (request.signal?.aborted || !selected(id) || role(id) !== expectedRole) return []
      const actions = request.position === 'inline' ? [] : actionCandidates(c, choosing ? query.slice(choosing.id.length + 1) : query).map(a => ({ ...a, hint: '填入输入框 · 占位符', value: `action:${c!.agentId}:${a.value.slice(7)}:${choosing ? 'new' : 'current'}` }))
      if (choosing) return [...actions, { name: '普通会话', description: `与 ${choosing.name} 对话，不使用 Action`, value: `ordinary:${choosing.id}`, section: `Agent · ${choosing.name}` }, { name: '返回 Agent 列表', value: 'action:back', section: 'Agent' }]
      return [...actions, ...agentCandidates(roster, q, expanded.has(id)), ...workflows.filter(t => !q || `${t.title} ${t.id}`.toLowerCase().includes(q)).map(t => ({ name: t.title, description: `${t.scheduleEnabled === false ? '定时已暂停 · 可手动执行。' : ''}${t.brief}`, hint: '复用工作流 · 新执行', value: `task:${t.id}`, section: 'Task / Workflow' }))]
    },
    onPick: (pick: any) => {
      const id = pick.session.sessionId, value = pick.candidate.value ?? ''
      if (!selected(id)) return 'handled' as const
      if (value === AGENT_EXPAND || value === AGENT_COLLAPSE) { value === AGENT_EXPAND ? expanded.add(id) : expanded.delete(id); return { text: '@', continue: true } }
      if (value === 'action:back') return { text: '@', continue: true }
      if (value.startsWith('action:')) {
        const [, agentId, actionId, mode] = value.split(':'), catalog = catalogs.get(agentId), action = catalog?.actions.find(a => a.id === actionId), isNew = mode === 'new'
        const input = inputFor(id)
        if (!catalog || !action || !input || (isNew ? !canChooseAgent(id) : role(id) !== agentId)) { input?.notify('error', '当前角色已变化，请重新选择 Action'); return 'handled' as const }
        const before = input.state.getSnapshot()
        if (before.draft.slice(0, pick.span.start).trim()) { input.notify('info', '请在输入框开头选择 Action；现有草稿未改动'); return 'handled' as const }
        const claim = actionClaim(id, catalog, action, isNew), scope = ctx.sessions.scope(id)
        const applied = scope.bail(scope, 'slash/input-begin-command', { claim, span: pick.span })
        if (applied !== true) { input.notify('error', '草稿已改变，请重新选择 Action'); return 'handled' as const }
        const tail = before.draft.slice(pick.span.end)
        input.setDraft(makeActionSnippet(action, claim.token).text + (tail.trim() ? `\n${tail}` : ''))
        snippets.get(id)?.dispose()
        snippets.set(id, installActionSnippet(ctx, id, action, claim.token, input))
        return 'handled' as const
      }
      const task = workflows.find(t => `task:${t.id}` === value)
      if (task) return claimTask(task)
      const agent = roster.find(a => a.id === value || `ordinary:${a.id}` === value)
      if (!agent) return undefined
      return !value.startsWith('ordinary:') && agent.actionCount && canChooseAgent(id) ? { text: `@${agent.id}/`, continue: true } : claimAgent(agent)
    },
    matchEnter: async (session: { sessionId: string }, line: string) => {
      if (!selected(session.sessionId)) return undefined
      await refresh()
      const id = session.sessionId, currentRole = role(id), input = line.trimStart()
      if (currentRole) {
        const catalog = await catalogFor(currentRole, id).catch(() => null)
        const action = catalog?.actions.find(a => input.startsWith(`@${a.name} `))
        if (catalog && action) return { claim: actionClaim(id, catalog, action, false) }
      }
      if (canChooseAgent(id)) {
        const agent = roster.find(a => input.startsWith(`@${a.name}/`))
        if (agent) {
          const c = await catalogFor(agent.id), a = c.actions.find(a => input.startsWith(`@${c.name}/${a.name} `))
          if (a) return { claim: actionClaim(id, c, a, true) }
        }
      }
      const task = workflows.find(t => input === `@${t.title}` || input.startsWith(`@${t.title} `) || input.startsWith(`@${t.id} `))
      if (task) return claimTask(task)
      const agent = roster.find(a => input === `@${a.name}` || input.startsWith(`@${a.name} `) || input.startsWith(`@${a.id} `))
      return agent ? claimAgent(agent) : undefined
    },
  }
}
