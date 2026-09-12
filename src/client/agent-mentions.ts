import type { AgentRow } from '../wire.ts'
import type { ActionCatalog, AgentAction } from '../agent-actions.ts'
import { actionCandidates } from '../agent-actions.ts'
import { confirmedActionRole, makeActionSnippet, resolveSnippetDefaults } from '../action-snippet.ts'
import { agentCandidates, AGENT_EXPAND, AGENT_COLLAPSE } from '../agent-order.ts'
import { ACTION_CHANGED, sendCurrentAction } from './action-dispatch.ts'
import { installActionSnippet } from './action-snippet.ts'
import { readActionDraft, writeActionDraft } from './action-draft.ts'
import type { Api } from './Console.tsx'

export function agentMentionSource(ctx: any, api: () => Promise<Api>, go: (path: string) => void) {
  const expanded = new Set<string>(), snippets = new Map<string, ReturnType<typeof installActionSnippet>>()
  let roster: AgentRow[] = [], workflows: any[] = [], refreshedAt = 0
  const catalogs = new Map<string, ActionCatalog>()
  const watches = new Map<string, () => void>(), restoring = new Map<string, Promise<void>>()
  let live = true
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
      if (id) queueMicrotask(() => watchDraft(id))
    })
    const clear = () => { refreshedAt = 0; catalogs.clear(); dismiss(snapshot().current) }
    window.addEventListener(ACTION_CHANGED, clear)
    return () => { live = false; stop(); window.removeEventListener(ACTION_CHANGED, clear); for (const off of watches.values()) off(); for (const s of snippets.values()) s.dispose(); snippets.clear() }
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
          text = resolveSnippetDefaults(action, text)
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
  const attachSnippet = (id: string, catalog: ActionCatalog, action: AgentAction, newSession: boolean, input: any, restored = false) => {
    const prefix = newSession ? `@${catalog.name}/${action.name} ` : `@${action.name} `
    const saved = readActionDraft(id)
    snippets.get(id)?.dispose()
    snippets.set(id, installActionSnippet(ctx, id, action, prefix, input, {
      restored, saved: restored ? saved?.progress : undefined,
      save: progress => writeActionDraft(id, progress ? { agentId: catalog.agentId!, actionId: action.id, revision: catalog.revision, prefix, newSession, progress } : undefined),
    }))
  }
  const resolveDraft = async (id: string, text: string) => {
    const saved = readActionDraft(id)
    if (saved && text.startsWith(saved.prefix)) {
      if (saved.newSession ? !canChooseAgent(id) : role(id) !== saved.agentId) throw Error('草稿所属角色尚未确认或已变化，请重新选择 Agent / Action；原文保留')
      const catalog = await catalogFor(saved.agentId, saved.newSession ? undefined : id)
      const action = catalog.actions.find(a => a.id === saved.actionId)
      if (!action || catalog.revision !== saved.revision) throw Error('Action 已更改或删除，请重新选择；原文保留')
      return { catalog, action, newSession: saved.newSession, prefix: saved.prefix }
    }
    const currentRole = role(id)
    if (currentRole) {
      const catalog = await catalogFor(currentRole, id)
      const action = catalog.actions.find(a => text.startsWith(`@${a.name} `))
      if (action) return { catalog, action, newSession: false, prefix: `@${action.name} ` }
    }
    if (canChooseAgent(id)) {
      await refresh()
      const agent = roster.find(a => text.startsWith(`@${a.name}/`))
      if (agent) {
        const catalog = await catalogFor(agent.id)
        const action = catalog.actions.find(a => text.startsWith(`@${catalog.name}/${a.name} `))
        if (action) return { catalog, action, newSession: true, prefix: `@${catalog.name}/${action.name} ` }
      }
    }
    if (/^@\S+\s[\s\S]*【[^】]+】/.test(text)) throw Error('请先明确选择 Agent 和 Action；未填写的草稿不会作为普通消息发送')
    return null
  }
  const restoreDraft = (id: string, forced = false) => {
    if (restoring.has(id)) return restoring.get(id)!
    const input = inputFor(id), before = input?.state.getSnapshot()
    if (!live || !selected(id) || !before || before.phase !== 'plain' || !before.draft.startsWith('@')) return Promise.resolve()
    const saved = readActionDraft(id)
    if (!forced && !saved && !/^@\S+\s[\s\S]*【[^】]+】/.test(before.draft)) return Promise.resolve()
    const job = (async () => {
      const expected = snapshot().byId?.[id]?.agentPreset
      try {
        const found = await resolveDraft(id, before.draft)
        if (!found || !live || !selected(id) || snapshot().byId?.[id]?.agentPreset !== expected || input.state.getSnapshot().draftRev !== before.draftRev) return
        const scope = ctx.sessions.scope(id)
        const applied = scope.bail(scope, 'slash/input-begin-command', { claim: actionClaim(id, found.catalog, found.action, found.newSession), span: { start: 0, end: found.prefix.length, draftRev: before.draftRev } })
        if (applied) attachSnippet(id, found.catalog, found.action, found.newSession, input, true)
      } catch (e: any) { if (live && selected(id) && input.state.getSnapshot().draftRev === before.draftRev) input.notify('error', e.message) }
    })().finally(() => {
      restoring.delete(id)
      // Native draft hydration/typing may supersede an in-flight lookup. Its
      // stale result must be discarded AND the newest revision reconsidered.
      if (live && selected(id) && input.state.getSnapshot().draftRev !== before.draftRev) queueMicrotask(() => { void restoreDraft(id, forced) })
    })
    restoring.set(id, job); return job
  }
  const watchDraft = (id: string) => {
    if (!live || !selected(id)) return
    const input = inputFor(id)
    if (!input) return
    if (!watches.has(id)) {
      let revision = -1
      const check = () => {
        const state = input.state.getSnapshot()
        if (!selected(id) || state.draftRev === revision) return
        revision = state.draftRev
        const saved = readActionDraft(id)
        if (saved && state.draftRev > 0 && !state.draft.startsWith(saved.prefix)) writeActionDraft(id)
        if (state.phase === 'plain') queueMicrotask(() => { void restoreDraft(id) })
      }
      watches.set(id, input.state.subscribe(check)); check()
    }
    void restoreDraft(id)
  }
  return {
    trigger: '@' as const, name: 'Agent', order: -10, warm: (session: { sessionId: string }) => { queueMicrotask(() => watchDraft(session.sessionId)) },
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
        attachSnippet(id, catalog, action, isNew, input)
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
      const found = await resolveDraft(id, input)
      if (!selected(id) || role(id) !== currentRole) throw Error('会话或角色已变化；草稿保留')
      if (found) {
        // A restored @ draft is plain until re-claimed. This first Enter/Send
        // restores editing, never falls through to the ordinary prompt sink.
        requestAnimationFrame(() => { void restoreDraft(id, true) })
        return 'handled' as const
      }
      const task = workflows.find(t => input === `@${t.title}` || input.startsWith(`@${t.title} `) || input.startsWith(`@${t.id} `))
      if (task) return claimTask(task)
      const agent = roster.find(a => input === `@${a.name}` || input.startsWith(`@${a.name} `) || input.startsWith(`@${a.id} `))
      return agent ? claimAgent(agent) : undefined
    },
  }
}
