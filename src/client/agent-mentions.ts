import type { AgentRow } from '../wire.ts'
import type { ActionCatalog, AgentAction } from '../agent-actions.ts'
import { actionCandidates, renderAction } from '../agent-actions.ts'
import { confirmedActionRole, makeActionSnippet, resolveSnippetDefaults, trackPendingSnippet } from '../action-snippet.ts'
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
  // UI intent only; the current native header and backend still enforce ownership.
  const explicitRole = (id: string) => { try { return sessionStorage.getItem(`dtc:action-role:${id}`) } catch { return null } }
  const rememberRole = (id: string, agentId?: string) => { try { agentId ? sessionStorage.setItem(`dtc:action-role:${id}`, agentId) : sessionStorage.removeItem(`dtc:action-role:${id}`) } catch { /* storage unavailable */ } }
  const role = (id: string) => confirmedActionRole(snapshot(), id, explicitRole(id))
  const selected = (id: string) => snapshot().current === id
  const canChooseAgent = (id: string) => !role(id) || snapshot().byId?.[id]?.blank === true
  const inputFor = (id: string) => ctx.get('conversation')?.input.for(ctx.sessions.scope(id))
  const cwd = (id: string) => snapshot().byId?.[id]?.cwd
  ctx.effect(() => {
    const dismiss = (id?: string) => { if (id) { try { ctx.inputTriggers.sessionOf(ctx.sessions.scope(id)).dismiss() } catch { /* input not mounted */ } } }
    let previous = snapshot().current, previousRole = previous ? role(previous) : null
    const stop = ctx.sessions.list.subscribe(() => {
      const id = snapshot().current
      // New Session may reuse the same blank record; it is a new choice context.
      if (!id && previous) rememberRole(previous)
      if (id && explicitRole(id) && explicitRole(id) !== snapshot().byId?.[id]?.agentPreset) rememberRole(id)
      const nextRole = id ? role(id) : null
      if (id === previous && nextRole === previousRole) return
      dismiss(previous); if (id !== previous) dismiss(id)
      previous = id; previousRole = nextRole
      if (id) queueMicrotask(() => watchDraft(id))
    })
    const clear = () => { refreshedAt = 0; catalogs.clear(); dismiss(snapshot().current) }
    const confirm = (event: Event) => {
      const { sessionId, agentPreset } = (event as CustomEvent).detail ?? {}
      if (typeof sessionId !== 'string' || typeof agentPreset !== 'string' || !selected(sessionId) || snapshot().byId?.[sessionId]?.agentPreset !== agentPreset) return
      rememberRole(sessionId, agentPreset); previousRole = role(sessionId)
      dismiss(sessionId); queueMicrotask(() => watchDraft(sessionId))
    }
    window.addEventListener(ACTION_CHANGED, clear)
    window.addEventListener('dsh:agent-preset-confirmed', confirm)
    const composeTask = (event: Event) => {
      const taskId = (event as CustomEvent).detail?.taskId, id = snapshot().current, input = id && inputFor(id)
      if (!input || typeof taskId !== 'string') { go(`tasks/${taskId}/actions`); return }
      if (input.state.getSnapshot().draft.trim()) { input.notify('info', '当前草稿保留；请先处理草稿，再在开头 @ 选择任务'); return }
      input.setDraft(`@${taskId}/`)
      requestAnimationFrame(() => (document.querySelector('textarea[data-phase]') as HTMLTextAreaElement | null)?.focus())
    }
    window.addEventListener('dtc:compose-task', composeTask)
    return () => { live = false; stop(); window.removeEventListener(ACTION_CHANGED, clear); window.removeEventListener('dsh:agent-preset-confirmed', confirm); window.removeEventListener('dtc:compose-task', composeTask); for (const off of watches.values()) off(); for (const s of snippets.values()) s.dispose(); snippets.clear() }
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
  const taskCatalogFor = async (taskId: string) => { const c = await (await api()).taskActions(taskId); catalogs.set(`task:${taskId}`, c); return c }
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
    const prefix = catalog.taskId || newSession ? `@${catalog.name}/${action.name} ` : `@${action.name} `
    const previous = readActionDraft(sessionId)
    const requestId = previous?.taskId === catalog.taskId && previous?.actionId === action.id && previous?.revision === catalog.revision && previous.requestId ? previous.requestId : crypto.randomUUID()
    if (catalog.taskId) writeActionDraft(sessionId, { agentId: '', taskId: catalog.taskId, actionId: action.id, revision: catalog.revision, prefix, newSession: false, requestId, ...(previous?.requestId === requestId ? { progress: previous.progress } : {}) })
    let uncertain = false
    return { token: prefix, hint: `${catalog.name} · ${action.name} · 填写占位符后发送`, images: false,
      submit: async (text: string) => {
        let dispatched = false
        try {
          if (uncertain) throw Error('上次发送结果未确认，请先检查会话记录，勿重复发送')
          if (!selected(sessionId)) throw Error('已切换会话，请回到原会话再发送')
          if (catalog.taskId) {
            const snippet = snippets.get(sessionId)
            if (!snippet || snippet.error()) throw Error(snippet?.error() ?? '请重新选择 Task Action，恢复参数位置')
            await snippet.validate()
            const raw = snippet.values(), values = Object.fromEntries(Object.entries(raw).map(([k,v]) => {
              const p = action.parameters.find(p => p.key === k)!
              return [k, p.type === 'number' && v !== '' ? Number(v) : p.type === 'boolean' ? v === 'true' : v]
            }))
            const expected = renderAction(action, values).split('\n').slice(1).join('\n').trim()
            if (resolveSnippetDefaults(action, text).trim() !== expected) throw Error('Task Action 请只填写参数；修改模板请到任务的 Actions 页，当前草稿保留')
            const out = await (await api()).launchTaskAction({ taskId: catalog.taskId, actionId: action.id, revision: catalog.revision, values, requestId, cwd: cwd(sessionId) })
            writeActionDraft(sessionId)
            go(`tasks/${out.taskId}/runs/${out.batchId}`)
            return { kind: 'success' as const }
          }
          if (!newSession && role(sessionId) !== catalog.agentId) throw Error('当前角色已变化，请重新选择 Action')
          if (newSession && !canChooseAgent(sessionId)) throw Error('当前会话已有角色，请重新选择该角色的 Action')
          const message = snippets.get(sessionId)?.error()
          if (message) throw Error(message)
          await snippets.get(sessionId)?.validate()
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
    const prefix = catalog.taskId || newSession ? `@${catalog.name}/${action.name} ` : `@${action.name} `
    const saved = readActionDraft(id)
    snippets.get(id)?.dispose()
    snippets.set(id, installActionSnippet(ctx, id, action, prefix, input, {
      restored, saved: restored ? saved?.progress : undefined,
      isCurrentRole: () => catalog.taskId ? selected(id) : newSession ? canChooseAgent(id) : role(id) === catalog.agentId,
      candidates: async (parameter, values, search, page) => (await api()).agentActionOptions({ ...(catalog.taskId ? { taskId: catalog.taskId } : { agentId: catalog.agentId!, ...(newSession ? {} : { sessionId: id }) }), actionId: action.id, revision: catalog.revision, parameter, values, search, page }),
      save: progress => writeActionDraft(id, progress ? { agentId: catalog.agentId ?? '', ...(catalog.taskId ? { taskId: catalog.taskId, requestId: saved?.requestId } : {}), actionId: action.id, revision: catalog.revision, prefix, newSession, progress } : undefined),
    }))
  }
  const resolveDraft = async (id: string, text: string) => {
    const saved = readActionDraft(id)
    if (saved && text.startsWith(saved.prefix)) {
      if (!saved.taskId && (saved.newSession ? !canChooseAgent(id) : role(id) !== saved.agentId)) throw Error('草稿所属角色尚未确认或已变化，请重新选择 Agent / Action；原文保留')
      const catalog = saved.taskId ? await taskCatalogFor(saved.taskId) : await catalogFor(saved.agentId, saved.newSession ? undefined : id)
      const action = catalog.actions.find(a => a.id === saved.actionId && a.enabled !== false)
      if (!action || catalog.revision !== saved.revision) throw Error('Action 已更改或删除，请重新选择；原文保留')
      return { catalog, action, newSession: saved.newSession, prefix: saved.prefix }
    }
    await refresh()
    const task = workflows.find(t => text.startsWith(`@${t.title}/`))
    if (task) {
      const catalog = await taskCatalogFor(task.id), action = catalog.actions.find(a => a.enabled !== false && text.startsWith(`@${catalog.name}/${a.name} `))
      if (!action) throw Error('Task Action 已修改或删除，请重新选择；草稿保留')
      return { catalog, action, newSession: false, prefix: `@${catalog.name}/${action.name} ` }
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
      let revision = -1, previousDraft: string | undefined
      const check = () => {
        const state = input.state.getSnapshot()
        if (!selected(id) || state.draftRev === revision) return
        revision = state.draftRev
        const saved = readActionDraft(id)
        if (saved && state.draftRev > 0 && !state.draft.startsWith(saved.prefix)) writeActionDraft(id)
        else if (saved && state.phase === 'plain' && !snippets.get(id)?.active() && previousDraft !== undefined && previousDraft !== state.draft) {
          const progress = trackPendingSnippet(previousDraft, state.draft, saved.progress)
          if (progress) writeActionDraft(id, { ...saved, progress })
        }
        previousDraft = state.draft
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
      const choosingTask = workflows.find(t => q.startsWith(`${t.id.toLowerCase()}/`))
      if (choosingTask && request.position !== 'inline') {
        const c = await taskCatalogFor(choosingTask.id)
        if (request.signal?.aborted || !selected(id)) return []
        return [...actionCandidates(c, query.slice(choosingTask.id.length + 1)).map(a => ({ ...a, hint: '填写本次参数 · 新执行记录', value: `task-action:${c.taskId}:${a.value.slice(7)}` })), { name: '配置 Actions', value: `task-config:${c.taskId}`, section: 'Task' }, { name: '返回', value: 'action:back', section: 'Task' }]
      }
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
      if (value.startsWith('task-config:')) { go(`tasks/${value.slice(12)}/actions`); return 'handled' as const }
      if (value.startsWith('task-action:')) {
        const [,taskId,actionId] = value.split(':'), catalog = catalogs.get(`task:${taskId}`), action = catalog?.actions.find(a => a.id === actionId && a.enabled !== false), input = inputFor(id)
        if (!catalog || !action || !input) return 'handled' as const
        const before = input.state.getSnapshot()
        if (before.draft.slice(0, pick.span.start).trim()) { input.notify('error', '请在输入框开头选择 Task Action'); return 'handled' as const }
        writeActionDraft(id) // Explicit new selection is a new invocation, not a retry.
        const claim = actionClaim(id, catalog, action, false), scope = ctx.sessions.scope(id)
        if (scope.bail(scope, 'slash/input-begin-command', { claim, span: pick.span }) !== true) return 'handled' as const
        input.setDraft(makeActionSnippet(action, claim.token).text)
        attachSnippet(id, catalog, action, false, input)
        return 'handled' as const
      }
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
      if (task) return task.actionCount ? { text: `@${task.id}/`, continue: true } : claimTask(task)
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
      if (task) {
        if (task.actionCount && (input === `@${task.title}` || input === `@${task.id}`)) { inputFor(id)?.setDraft(`@${task.id}/`); return 'handled' as const }
        return claimTask(task)
      }
      const agent = roster.find(a => input === `@${a.name}` || input.startsWith(`@${a.name} `) || input.startsWith(`@${a.id} `))
      return agent ? claimAgent(agent) : undefined
    },
  }
}
