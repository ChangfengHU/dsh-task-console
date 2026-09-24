import { studioRenderJob } from './studio-render-host.js'
import { inspectCapabilityContract } from './capability-contract.ts'
import { taskAgentIds } from './task-design.ts'
import {registerStageFiles,requireStudioStages,verifyStageReceipt} from './studio-stage-files.js'
import {studioStageFor} from './studio-stages.js'
import { registerStudioSpeechTools } from './studio-speech-tools.js'
import { registerStudioBoardTools } from './studio-board-tools.js'
import { StudioOperations } from './studio-operations.js'
import { assertStudioImageRequest } from './studio-image-request.js'
import { reconcileStudioImageOperation } from './studio-image-reconciliation.js'
import { requireSettledStudioOperations } from './studio-stage-operations.js'
import { assertFrozenVoiceSynthesis } from './studio-voice-script.js'
import { refreshStudioCapabilities, observeStudioAudio, observeStudioVision, checkStudioSpeech, compileStudioStoryboard, downloadStudioAsset } from './studio-host.js'
import { registerStudioTools } from './studio-tools.js'
import { StudioWorkflow } from './studio-workflow.js'
import { registerStudioSkillGate } from './studio-skill-gate.js'
/**
 * The `taskConsole` Remote service.
 *
 * Reads the live composition (which MCP servers the host runs, which tools
 * they registered), the skill library, and the preset roster; writes preset
 * directories; and runs the one experiment that proves a preset does what
 * the editor says — a real session on it, reporting the exact tool list dsh
 * handed the model (`request/header`), not what the model claims.
 *
 * @module dsh-task-console/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { readActions, saveActions } from './agent-action-store.ts'
import { renderAction, parameterVisible, type ActionCatalog } from './agent-actions.ts'
import { optionPage, sourceTool, type ActionOptionQuery } from './action-options.ts'
import { fleetActionOptions } from './fleet-action-options.ts'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SessionCapabilities } from './session-capabilities.ts'
import { applyAgentPermission } from './agent-session.ts'
import { agentHistory, firstAgentUse, historyQuery, type AgentSessionHeader } from './agent-history.ts'
import { sortAgents } from './agent-order.ts'
import { discoverLegacyArtifacts, publishHtml, readArtifact } from './artifacts.ts'
import { withFinalArtifact } from './artifact-delivery.ts'
import { taskListIndex } from './task-list.ts'
import {
  NATIVE_TOOLS, mask, readAgentCreatedAt, readSpec, removePreset, renderComposition, scanSkills, userPresetRoot, validateSpec, writePreset,
  type HostMcp,
} from './presets.ts'
import { TaskRunner } from './runner.ts'
import { EventStore, batchStatus, cardRun, foldTurns, nextFire, parseCron, validateTask, taskForBatch } from './tasks.ts'
import { TaskIntakeCoordinator, type IntakeAgent } from './task-intake.ts'
import { decideTaskSignalWithAgent } from './task-intake-agent.ts'
import { TaskCreator } from './task-create.ts'
import { assertTaskActionLogin } from './task-actions.ts'
import { readBrowserAcceptance } from './workflow-acceptance.ts'
import { executionHistory } from './execution-history.ts'
import { ledgerPage } from './ledger-page.ts'
import { browserPatrolEvidence } from './browser-patrol-evidence.ts'
import { BrowserPatrolWorkflow } from './browser-patrol-workflow.ts'
import { ProxyWorkflow, proxyRequestId } from './proxy-workflow.ts'
import { TaskNotifications, type NotificationStage } from './task-notifications.ts'
import { patrolFollowup } from './patrol-followup.ts'
import { validateWorkflowCompletion, validateWorkflowBlock, pendingBrowserOperation, browserOperationOutcome } from './workflow-acceptance.ts'
import { validateFleetWorkflowEvidence, fullFleetRecipe } from './fleet-workflow-evidence.ts'
import type { Artifact, Card } from './tasks.ts'
import type { ArtifactView, BoardView } from './wire.ts'
import { NAMESPACE } from './wire.ts'
import { SessionShortcuts, shortcutChange } from './session-shortcuts.ts'
import type { AgentRow, AgentSpec, Catalog, McpServer, Preview, TryRunResult } from './wire.ts'
import { createBootstrapCommand, createEnvelope, downloadConfig, taskConfig, uploadConfig, type ConfigEnvelope } from './config-migration.ts'
import { runtimeBootstrapStatus, startRuntimeBootstrap } from './config-runtime-bootstrap.ts'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const TOOL_PREFIX = /^mcp__(.+?)__(.+)$/

/** Models the picker offers besides the deployment default. */
const KNOWN_MODELS = [
  'codex-local/gpt-5.6-terra', 'codex-local/gpt-5.6-mini',
  'claude-local/haiku', 'claude-local/sonnet',
  'deepseek-official/qwen-flash',
  'llm-deepseek/qwen-plus-latest', 'llm-deepseek/deepseek-v3',
]

export class TaskConsoleService extends TypertRemoteService {
  static inject = ['loader', 'tools', 'agents', 'workspaceRegistry', 'permissionPresets']

  readonly runner: TaskRunner
  readonly intake: TaskIntakeCoordinator
  readonly creator: TaskCreator
  capabilities!: SessionCapabilities
  private readonly ready: Promise<void>
  private headerCache?: { at: number; value: AgentSessionHeader[] }
  private headerRead?: Promise<AgentSessionHeader[]>
  private readonly pendingConfigImports = new Map<string, { envelope: ConfigEnvelope; expiresAt: number }>()

  private shortcutHidden(): Set<string> {
    const registry = (this.ctx as any).get('workspaceRegistry')
    if (!registry) throw Error('会话可见性服务尚未就绪')
    return new Set([...(registry.archivedSessionIds ?? []), ...(registry.internalSessionIds ?? [])])
  }

  async sessionShortcuts(): Promise<string> {
    await this.ready
    return JSON.stringify(new SessionShortcuts(this.runner.store.kernel.db).list(this.shortcutHidden()))
  }

  async setSessionShortcut(payload: string): Promise<string> {
    const change = shortcutChange(JSON.parse(payload))
    await this.ready
    const headers = await this.sessionHeaders(), hidden = this.shortcutHidden()
    const eligible = new Set(headers.filter(h => !hidden.has(h.id)).map(h => h.id))
    new SessionShortcuts(this.runner.store.kernel.db).set(change, eligible)
    return this.sessionShortcuts()
  }

  async patrolFollowup(): Promise<ReturnType<typeof patrolFollowup>> {
    await this.ready
    return patrolFollowup(this.runner.store.kernel.db)
  }

  constructor(ctx: Context) {
    super(ctx, NAMESPACE)
    this.runner = new TaskRunner(ctx, new EventStore(), {
      onSessionCreated: sessionId => this.markTaskSessionInternal(sessionId),
      registerStudioTools: async (agentCtx,input,isActive,submitReview) => {
        const workflow=new StudioWorkflow(this.runner.store),locks=await refreshStudioCapabilities(workflow,input.task)
        const media=await registerStudioTools(agentCtx,{input,workflow,isActive,renderJob:(action,args)=>studioRenderJob(input.task,action,args),downloadAsset:args=>downloadStudioAsset(input.task,args),registerStage:path=>registerStageFiles(input,path,workflow,this.runner.store.kernel.db),...locks,submitReview,refreshPreflight:()=>refreshStudioCapabilities(workflow,input.task),audioObserve:args=>observeStudioAudio(input.task,args),visionObserve:args=>observeStudioVision(input.task,args),referenceReceipt:r=>workflow.recordReferenceReceipt(input,r)})
        let skillGate:()=>void=()=>{},speech:()=>void=()=>{},board:()=>void=()=>{}
        try { skillGate=registerStudioSkillGate(agentCtx,{input,isActive,record:r=>workflow.recordSkillLoad(input,r)});speech=await registerStudioSpeechTools(agentCtx,{input,workflow,isActive,speechCheck:args=>checkStudioSpeech(input.task,args)});board=await registerStudioBoardTools(agentCtx,{input,workflow,isActive,compile:args=>compileStudioStoryboard(input.task,args)});return ()=>{board();speech();skillGate();media()} } catch(e){board();speech();skillGate();media();throw e}
      },
      beforeStart: async input => {
        const ids=input.card.role==='planner' ? taskAgentIds(input.task) : [input.profileId]
        for(const id of ids){
          const audit=JSON.parse(await this.agentCapabilityStatus(JSON.stringify({id})))
          // Legacy authored presets remain usable only when their actual fence matches;
          // they are never labelled live-verified or certified by this compatibility path.
          if(['composition-missing','tool-drift','dependency-missing','contract-drift','local-edit'].includes(audit.status))return {
            kind:'capability' as const,
            reason:JSON.stringify({error_code:'agent-capability-drift',agentId:id,status:audit.status,missingTools:audit.missingTools,unexpectedTools:audit.unexpectedTools,missingDependencies:audit.missingDependencies,retryable:false,nextAction:'Review the capability diff and regenerate the authored preset without losing local edits. Resume in a new run after verification.'})
          }
        }
        if (input.task.design?.evidenceContract !== 'studio-video-v1') return
        const workflow = new StudioWorkflow(this.runner.store)
        await requireStudioStages(input,workflow,this.runner.store.kernel.db)
        workflow.enforceRuntime(input)
        const operations=new StudioOperations(this.runner.store)
        operations.configure(input,input.task.design.studio.generationLimits??{imageCalls:6,voiceSegments:80})
        const budget=operations.snapshot(input)
        workflow.recordBudget(input,{repairRounds:Math.max(0,(workflow.status(input).candidate?.revision??1)-1),used:budget.used,limits:budget.limits,maxRepairRounds:input.task.design.studio.maxRepairRounds??3,exceeded:false})
        await refreshStudioCapabilities(workflow,input.task)
        const result = workflow.preflight(input.task)
        if (!result.ok) return { kind: 'capability', reason: result.reason ?? 'blocked_quality_capability' }
      },
      beforeComplete: async input => {
        if (input.task.design?.evidenceContract === 'studio-video-v1') {
          const workflow=new StudioWorkflow(this.runner.store),operations=new StudioOperations(this.runner.store).snapshot(input)
          if(!workflow.hasRejection(input))await refreshStudioCapabilities(workflow,input.task)
          requireSettledStudioOperations(input,operations)
          const candidate=workflow.status(input).candidate
          workflow.recordBudget(input,{repairRounds:Math.max(0,(candidate?.revision??1)-1),used:operations.used,limits:operations.limits,maxRepairRounds:input.task.design.studio.maxRepairRounds??3,exceeded:false})
          if(input.card.role==='studio-stage'){
            const stage=studioStageFor(input)!,receipt=workflow.stageReceipt(input,stage.id)
            await requireStudioStages(input,workflow,this.runner.store.kernel.db)
            await verifyStageReceipt(input,receipt,workflow)
            if(receipt.sessionId!==input.sessionId)throw Error('studio-stage-session-mismatch')
            return {summary:receipt.summary,metadata:{workflowOutcome:'stage_handoff',stage:stage.id,manifest:receipt.manifest,outputs:receipt.outputs,qualityApproved:false}}
          }
          await requireStudioStages(input,workflow,this.runner.store.kernel.db)
          return workflow.complete(input)
        }
        if (input.card.role === 'notifier' || input.profileId === input.task.design?.notifications?.agentId) return new TaskNotifications(this.runner.store).complete(input)
        const proxy = new ProxyWorkflow(this.runner.store)
        if (proxy.pending(input)) throw new Error('代理后台操作仍在运行，继续查询原操作回执')
        const proxyReport = proxy.complete(input)
        if (input.card.role === 'proxy') return proxyReport
        if (await pendingBrowserOperation(input)) throw new Error('浏览器后台操作仍在运行；继续 browser_status，不能提前 task_complete。')
        if (input.task.design?.evidenceContract === 'browser-patrol-v2') {
          const patrol = await this.patrolWorkflow(input)
          const report = patrol.complete(input)
          if (input.card.role === 'planner') {
            const notifications = new TaskNotifications(this.runner.store).requireStage(input,input.metadata?.patrolDisposition === 'unresolved' ? 'unresolved' : 'restored')
            return { ...report, summary: `${report.summary}\n企微：${notifications.length ? notifications.map(n=>n.state).join('、') : '本任务未配置通知'}`, metadata: { ...report.metadata, notifications } }
          }
          return report
        }
        await validateWorkflowCompletion(input)
        if (input.task.workflowRecipe?.id === fullFleetRecipe) {
          const proof = await validateFleetWorkflowEvidence(input, {
            evidence: async role => {
              const run = [...this.runner.store.s.runs.values()].filter(r => r.batchId === input.batch.id && r.profileId === role)
                .sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt))[0]
              if (!run || (role === input.profileId ? run.sessionId !== input.sessionId || run.status !== 'running' : run.status !== 'done')) return
              const ctx = this.ctx as any, live = ctx.get('sessions')?.get(run.sessionId)
              const events = live?.events ?? (await ctx.get('sessionPersistence')?.inspect(run.sessionId))?.events ?? []
              return {role,sessionId:run.sessionId,events}
            },
            read: async kind => {
              const response = await fetch('https://fleet.vyibc.com/api/fleet' + (kind === 'fleet' ? '' : '/' + kind), {signal:AbortSignal.timeout(30000)})
              if (!response.ok) throw Error(`Fleet ${kind} 验收读取失败`)
              return response.json()
            },
          })
          // Replace untrusted model claims with the host's evidence projection.
          return {summary:`${proof!.scope === 'role-handoff' ? '本角色验收交接通过；完整装机尚未结束' : '完整 Fleet 接入验收通过'}。\n${JSON.stringify(proof)}`,
            metadata:{...input.metadata,fleetAcceptance:proof}}
        }
        const report = await this.patrolEvidence(input)
        if (report?.failure) throw new Error(report.failure)
        if (report?.summary && report.metadata) return { summary: report.summary, metadata: report.metadata }
      },
      beforeBlock: async input => {
        if(new ProxyWorkflow(this.runner.store).pending(input))throw new Error('代理操作仍运行，请查询原回执；不能提前阻塞并遗弃操作')
        const operation = await validateWorkflowBlock(input)
        if (operation) return operation
        const report = await this.patrolEvidence(input)
        if (report?.failure) return { reason: report.failure, kind: 'capability' }
      },
      pendingOperation: async input => new ProxyWorkflow(this.runner.store).pending(input) ?? await pendingBrowserOperation(input),
      afterBlock: async input => {
        if (input.task.design?.evidenceContract !== 'browser-patrol-v2' || !input.task.design.notifications?.agentId || input.card.role === 'notifier') return
        const report=(await this.patrolWorkflow(input)).snapshot(input)
        await this.runner.store.createNotification(input.task,input.batch,input.card,'blocked',report)
      },
      operationOutcome: async input => new ProxyWorkflow(this.runner.store).pending(input) ?? (input.card.role === 'proxy' ? '代理后台运行阶段已结束；调用原操作的 proxy_status 获取终态。全部计划节点明确终态后 task_complete 如实交接通过/未通过清单；宿主禁止未通过节点登录写入。不确定结果不能冒充明确失败或成功，应继续核对原回执或 task_block。' : await browserOperationOutcome(input)),
      scheduledTurn: (task, occurrenceId) => this.creator.scheduledTurn(task, occurrenceId),
      beforePlanRound: async (input, items, proxyItems) => {
        if (input.task.design?.evidenceContract === 'studio-video-v1') { const w=new StudioWorkflow(this.runner.store);await refreshStudioCapabilities(w,input.task);w.preflight(input.task);w.plan(input);return }
        if (input.task.design?.evidenceContract !== 'browser-patrol-v2') return
        const patrol = await this.patrolWorkflow(input); patrol.snapshot(input)
        new TaskNotifications(this.runner.store).requireStage(input,input.card.round === 1 ? 'started' : 'rework')
        const browserPlan = patrol.plan(input, items)!
        const proxyPlan = new ProxyWorkflow(this.runner.store).plan(input,browserPlan.items,proxyItems)
        return {items:proxyPlan ? {browserItems:browserPlan.items,proxyItems:proxyPlan.items} : browserPlan.items,commit:()=>{browserPlan.commit();proxyPlan?.commit()}}
      },
      patrolStatus: async input => {
        const outbox = new TaskNotifications(this.runner.store)
        return { ...(input.card.role === 'notifier' || input.profileId === input.task.design?.notifications?.agentId ? outbox.job(input) : (await this.patrolWorkflow(input)).snapshot(input)), notifications:outbox.rows(input.batch.id), proxy:new ProxyWorkflow(this.runner.store).status(input) }
      },
      notify: async (input, stage, deliver) => {
        const outbox = new TaskNotifications(this.runner.store)
        if (input.card.role === 'notifier' || input.profileId === input.task.design?.notifications?.agentId) return outbox.send(input,stage as NotificationStage,undefined,deliver)
        const report = (await this.patrolWorkflow(input)).snapshot(input)
        return input.task.design?.notifications?.agentId ? outbox.request(input,stage as NotificationStage,report) : outbox.send(input,stage as NotificationStage,report,deliver)
      },
    })
    this.intake = new TaskIntakeCoordinator(this.runner, {
      agents: () => this.intakeAgents(),
      decide: (signal, context, delivery) => decideTaskSignalWithAgent(this.ctx as any, signal, context, { ...delivery, markInternal: sessionId => this.markTaskSessionInternal(sessionId) }),
    })
    this.creator = new TaskCreator(this.runner, () => this.intakeAgents())
    this.ready = this.runner.start()
      .then(() => { this.capabilities = new SessionCapabilities(ctx, async () => ({
      checkedAt: new Date().toISOString(), scope: 'environment-directory-not-execution-grant',
      mcp: this.hostMcp().map(m => ({ server: m.serverName, disabled: m.disabled, registeredTools: m.tools, connection: 'not-probed' })),
      skills: (await scanSkills()).map(s => ({ name: s.name, source: s.root, state: 'installed-not-necessarily-loaded' })),
      agents: (await this.intakeAgents()).map(a => ({ id: a.id, name: a.name, mcpTools: a.mcpTools, skills: a.skills, delegation: 'not-started' })),
    }), this.runner.store.kernel.db, () => this.hostMcp()) })
      .then(() => this.markExistingTaskSessionsInternal())
      .then(() => this.intake.start())
    void this.ready.catch(err => console.error('[task-console] runner failed to start:', err))
  }

  /** Called by the filtered MCP wrapper, not a model-facing Console mutation API. */
  async scopedMcp(raw:string,args:any,exec:any,invoke:(args:any)=>Promise<any>) {
    const sessionId=exec?.agent?.session?.id
    if(!sessionId)throw Error('live-agent-session-required')
    const run=[...this.runner.store.s.runs.values()].find(r=>r.sessionId===sessionId&&r.status==='running')
    if(!run){
      if(sessionId.startsWith('task-'))throw Error('active-task-session-required')
      return invoke(['proxy_verify','proxy_repair'].includes(raw)?{...args,requestId:proxyRequestId(sessionId,args.requestId)}:args)
    }
    const card=this.runner.store.s.cards.get(run.cardId)!,batch=this.runner.store.s.batches.get(run.batchId)!,base=this.runner.store.tasks.get(run.taskId)!
    const task=taskForBatch(base,batch),input={task,batch,card,sessionId,profileId:run.profileId??card.agentId}
    if(task.design?.evidenceContract==='studio-video-v1') {
      const operations=new StudioOperations(this.runner.store),workflow=new StudioWorkflow(this.runner.store)
      try { return await operations.invoke(input,raw,args,invoke,()=>{assertFrozenVoiceSynthesis(raw,args,workflow.script(input));assertStudioImageRequest(raw,args)}) }
      finally {
        // Include retained unknown reservations, not only successful job receipts.
        const budget=operations.snapshot(input),candidate=workflow.status(input).candidate
        workflow.recordBudget(input,{repairRounds:Math.max(0,(candidate?.revision??1)-1),used:budget.used,limits:budget.limits,maxRepairRounds:task.design.studio.maxRepairRounds??3,exceeded:false})
      }
    }
    if (/^browser_login_(copy|provision|resume)$/.test(raw) && batch.turn?.action) {
      const resumed = raw === 'browser_login_resume' ? await readBrowserAcceptance(args.operationId) : undefined
      assertTaskActionLogin(batch.turn.action, raw, args, resumed)
    }
    if(!task.design?.proxy){
      if(raw.startsWith('proxy_'))throw Error('proxy-task-contract-not-reviewed')
      return invoke(args)
    }
    const proxy=new ProxyWorkflow(this.runner.store)
    await this.patrolWorkflow(input)
    if(raw.startsWith('proxy_'))return proxy.invoke(input,raw,args,invoke)
    proxy.assertBrowser(input,args)
    return invoke(args)
  }

  private async patrolEvidence(input: import('./runner.ts').CompletionCheck) {
    if (input.task.design?.evidenceContract !== 'browser-patrol-v1' || input.profileId !== 'browser-manager') return
    const ctx = this.ctx as any, live = ctx.get('sessions')?.get(input.sessionId)
    const events = live?.events ?? (await ctx.get('sessionPersistence')?.inspect(input.sessionId))?.events ?? []
    return browserPatrolEvidence(input, events)
  }

  private async patrolWorkflow(input: import('./runner.ts').CompletionCheck) {
    const ctx = this.ctx as any, live = ctx.get('sessions')?.get(input.sessionId)
    const events = live?.events ?? (await ctx.get('sessionPersistence')?.inspect(input.sessionId))?.events ?? []
    const patrol = new BrowserPatrolWorkflow(this.runner.store)
    patrol.capture(input, events)
    return patrol
  }

  /** Hide task-owned sessions from ordinary DSH discovery while retaining direct access. */
  private async markTaskSessionInternal(sessionId: string): Promise<void> {
    const registry = (this.ctx as any).get('workspaceRegistry')
    if (!registry?.markSessionInternal) return
    try { await registry.markSessionInternal(sessionId) }
    catch (error) { console.warn(`[task-console] could not mark task session ${sessionId} internal:`, error) }
  }

  /** Migrate every historical task-session relation into the internal set. */
  private async markExistingTaskSessionsInternal(): Promise<void> {
    const projected = [...this.runner.store.s.runs.values()]
      .map(run => run.sessionId).filter((id): id is string => Boolean(id))
    const historical = this.runner.store.all()
      .flatMap(event => event.t === 'run/claimed' || event.t === 'run/session_created' ? [event.sessionId] : [])
    const sessionIds = [...new Set([...projected, ...historical])]
    for (const sessionId of sessionIds) await this.markTaskSessionInternal(sessionId)
  }

  // ── facts ──────────────────────────────────────────────────────────────

  /** MCP servers the HOST composition runs, with the tools they registered. */
  private hostMcp(): (McpServer & HostMcp)[] {
    const registered = new Map<string, string[]>()
    for (const schema of (this.ctx as any).tools.schemas() as { name: string }[]) {
      const m = TOOL_PREFIX.exec(schema.name)
      if (!m) continue
      const list = registered.get(m[1]) ?? []
      list.push(m[2]); registered.set(m[1], list)
    }
    const rows: (McpServer & HostMcp)[] = []
    for (const entry of (this.ctx as any).loader.entries() as any[]) {
      if (entry?.options?.name !== MCP_CLIENT) continue
      const config = (entry.options.config ?? {}) as Record<string, unknown>
      const serverName = String(config.serverName ?? entry.options.id)
      const target = typeof config.url === 'string'
        ? config.url.replace(/\/\/[^@/]+@/, '//••••@')
        : [config.command, ...(Array.isArray(config.args) ? config.args : [])].filter(Boolean).join(' ')
      const disabled = entry.disabled === true || entry.options.disabled === true
      rows.push({ entryId: String(entry.options.id), sourceEntryId: String(entry.options.id), serverName, target, tools: registered.get(serverName) ?? [], disabled, config, live: !disabled })
    }
    return rows
  }

  /** Resolve one host-owned MCP transport for a child Agent preset. */
  sourceMcpConfig(sourceEntryId: string): Record<string, unknown> | undefined {
    const row = this.hostMcp().find(candidate => candidate.sourceEntryId === sourceEntryId && candidate.live)
    return row ? { ...row.config } : undefined
  }

  private hostToolNames(): string[] {
    return ((this.ctx as any).tools.schemas() as { name: string }[]).map(schema => schema.name)
  }

  /** Registered workspaces in sidebar order; empty when the registry is not composed. */
  private workspaces(): { id: string; path: string; title: string }[] {
    try {
      const reg = (this.ctx as any).get('workspaceRegistry')
      return (reg?.list?.() ?? []).map((w: any) => ({ id: String(w.id), path: String(w.path), title: String(w.title ?? w.path.split('/').pop() ?? w.path) }))
    } catch { return [] }
  }

  private defaultModel(): { provider: string; model: string; reasoningEffort?: string } | undefined {
    const defaults = (this.ctx as any).get('agentDefaultModel')
    try {
      const sel = defaults?.currentSelection?.()
      if (sel?.provider && sel?.model) return sel
    } catch { /* no default composed */ }
    return undefined
  }

  /** Only authored, tool-compatible presets enter the Task Agent's trusted roster. */
  private async intakeAgents(): Promise<IntakeAgent[]> {
    const presets = (this.ctx as any).get('agentPresets')
    if (!presets) return []
    const rows: IntakeAgent[] = []
    for (const preset of await presets.list() as any[]) {
      if (preset.broken || preset.trust !== 'user') continue
      const spec = await readSpec(dirname(String(preset.path)))
      if (!spec || spec.model.startsWith('claude-local')) continue
      rows.push({
        id: spec.id, name: spec.name, description: spec.description, model: spec.model,
        permission: spec.permissionPreset, tools: spec.tools, mcpTools: spec.mcpTools, skills: spec.skills,
        taskExpertise: spec.taskExpertise ?? [],
        profileHash: createHash('sha256').update(JSON.stringify(spec)).digest('hex'),
        toolSchemas: spec.tools.flatMap(id => NATIVE_TOOLS.find(t => t.id === id)?.schemaNames ?? []).concat(Object.entries(spec.mcpTools).flatMap(([server, tools]) => tools.filter(t => t !== '*').map(t => `mcp__${server}__${t}`))),
        toolDescriptions: Object.fromEntries(spec.tools.flatMap(id => { const tool = NATIVE_TOOLS.find(t => t.id === id); return tool ? tool.schemaNames.map(name => [name, tool.description]) : [] })),
      })
      this.runner.rememberName(spec.id, spec.name)
    }
    return rows
  }

  async catalog(): Promise<string> {
    const presets = (this.ctx as any).get('agentPresets')
    const def = this.defaultModel()
    const defaultModel = def ? `${def.provider}/${def.model}` : ''
    const models = [...new Set([defaultModel, ...KNOWN_MODELS].filter(Boolean))]
    const out: Catalog = {
      tools: NATIVE_TOOLS.map(({ rows: _rows, schemaNames: _schemaNames, ...t }) => t),
      mcp: this.hostMcp().map(({ config: _c, live: _l, ...m }) => m),
      skills: await scanSkills(),
      models,
      defaultModel,
      userRoot: presets?.authorable === false ? null : userPresetRoot(),
      workspaces: this.workspaces(),
    }
    return JSON.stringify(out)
  }

  async agentPage(payload: string): Promise<string> {
    const q=JSON.parse(payload)
    if (!q || typeof q!=='object' || Array.isArray(q) || q.query!==undefined&&typeof q.query!=='string' || q.page!==undefined&&(!Number.isSafeInteger(q.page)||q.page<1)) throw Error('无效 Agent 分页')
    const presets=(this.ctx as any).get('agentPresets'), all:any[]=presets?await presets.list():[]
    const created=new Map(await Promise.all(all.map(async p=>[p.id,await readAgentCreatedAt(dirname(String(p.path)))] as const)))
    const rows=all.filter(p=>!q.query||`${p.name??''} ${p.id}`.toLowerCase().includes(q.query.toLowerCase())).sort((a,b)=>String(created.get(b.id)??'').localeCompare(String(created.get(a.id)??''))||a.id.localeCompare(b.id))
    const total=rows.length,pages=Math.max(1,Math.ceil(total/10)),page=Math.min(q.page??1,pages),selected=rows.slice((page-1)*10,page*10)
    const load=async(p:any,detail=false)=>{const dir=dirname(String(p.path)),spec=p.trust==='user'?await readSpec(dir):null;return {id:p.id,name:spec?.name??p.name??p.id,description:spec?.description??p.description??'',trust:p.trust,broken:p.broken,path:dir,createdAt:created.get(p.id),firstUsedAt:null,
      permission:spec?(spec.tools.some(t=>['bash','fs','fs-text','str-replace-editor'].includes(t))?'write':Object.values(spec.mcpTools).some(t=>t.length)?'limited-write':'read-only'):null,spec:detail?spec:null}}
    const detailId=q.id==='new'?undefined:q.id??selected[0]?.id, detailPreset=detailId?all.find(p=>p.id===detailId):undefined
    if(q.id&&q.id!=='new'&&!detailPreset)throw Error('没有这个 Agent')
    const detail=detailPreset?{...await load(detailPreset,true),firstUsedAt:firstAgentUse(await this.sessionHeaders()).get(detailPreset.id)??null}:null
    return JSON.stringify({page,pages,total,pageSize:10,rows:await Promise.all(selected.map(p=>load(p))),detail})
  }

  async agents(): Promise<string> {
    const presets = (this.ctx as any).get('agentPresets')
    if (!presets) return JSON.stringify([])
    const rows: AgentRow[] = []
    const firstUsed = firstAgentUse(await this.sessionHeaders())
    for (const p of await presets.list() as any[]) {
      const dir = dirname(String(p.path))
      const spec = p.trust === 'user' ? await readSpec(dir) : null
      let name = p.name ?? p.id, description = p.description ?? ''
      if (!p.name || !p.description) {
        try {
          const text = await (await import('node:fs/promises')).readFile(`${dir}/preset.yml`, 'utf8')
          const n = /^name:\s*(.*)$/m.exec(text)?.[1]; const d = /^description:\s*(.*)$/m.exec(text)?.[1]
          const unq = (s?: string) => s ? s.trim().replace(/^"(.*)"$/, (_, x) => JSON.parse(`"${x}"`)) : undefined
          name = unq(n) ?? name; description = unq(d) ?? description
        } catch { /* no metadata */ }
      }
      const actionCount = await readActions(dir).then(c => c.actions.length).catch(() => 0)
      rows.push({ id: p.id, name, description, trust: p.trust, broken: p.broken, path: dir, spec, actionCount, createdAt: await readAgentCreatedAt(dir), firstUsedAt: firstUsed.get(p.id) ?? null })
    }
    return JSON.stringify(sortAgents(rows))
  }

  private configR2() {
    return {
      endpoint: process.env.DSH_TASK_CONSOLE_UPLOAD_URL ?? process.env.UPLOAD_R2_URL ?? 'https://upload-r2.vyibc.com',
      domain: process.env.DSH_TASK_CONSOLE_PUBLIC_DOMAIN ?? process.env.UPLOAD_R2_DOMAIN ?? 'https://resource.vyibc.com',
      token: process.env.DSH_TASK_CONSOLE_UPLOAD_TOKEN ?? process.env.UPLOAD_R2_TOKEN ?? '',
    }
  }

  private configBootstrap() {
    return {
      endpoint: process.env.FLEET_DSH_BOOTSTRAP_URL ?? 'https://fleet.vyibc.com/api/hub/dsh-config-bootstrap/service',
      token: process.env.FLEET_DSH_BOOTSTRAP_TOKEN ?? '',
    }
  }

  private taskActionsForExport(taskId: string) {
    return this.creator.actions.read(taskId).actions
  }

  /** Export definitions only. Sessions, runs, events, artifacts and secret values never enter the envelope. */
  async exportConfig(): Promise<string> {
    await this.ready
    const presets = (this.ctx as any).get('agentPresets')
    const agents = [] as { spec: AgentSpec; actions: import('./agent-actions.ts').AgentAction[] }[]
    for (const preset of (presets ? await presets.list() : []) as any[]) {
      if (preset.trust !== 'user') continue
      const dir = dirname(String(preset.path)), spec = await readSpec(dir)
      if (!spec) continue
      agents.push({ spec, actions: (await readActions(dir)).actions })
    }
    const tasks = [...this.runner.store.tasks.values()].filter(task => !task.archivedAt).map(task => taskConfig(task, this.taskActionsForExport(task.id)))
    let version = 'unknown'
    try { version = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8')).version ?? version } catch { /* package metadata is optional */ }
    const envelope = createEnvelope({ agents, tasks }, version)
    const result = await uploadConfig(envelope, this.configR2())
    return JSON.stringify({ ...result, exportedAt: envelope.exportedAt, digest: envelope.digest.value, counts: { agents: agents.length, tasks: tasks.length }, omitted: ['sessions', 'runs', 'events', 'artifacts', 'attachments', 'logs', 'credentials'] })
  }

  /** Available only to the server process; the browser receives a scoped command. */
  async createConfigBootstrap(payload: string): Promise<string> {
    await this.ready
    const { url } = JSON.parse(payload) as { url?: string }
    if (!url) throw Error('请先导出配置包')
    const { command, expiresInSeconds } = await createBootstrapCommand(url, { domain: this.configR2().domain, ...this.configBootstrap() })
    return JSON.stringify({ command, expiresInSeconds })
  }

  private configImportView(envelope: ConfigEnvelope) {
    const existingAgents = new Set<string>(), existingTasks = new Set(this.runner.store.tasks.keys())
    const presets = (this.ctx as any).get('agentPresets')
    const skills = new Set<string>(), mcp = new Set(this.hostMcp().map(row => row.serverName))
    return Promise.all([(presets ? presets.list() : []) as Promise<any[]> | any[], scanSkills()]).then(([rows, skillRows]) => {
      for (const row of rows as any[]) existingAgents.add(String(row.id))
      for (const row of skillRows) skills.add(row.name)
      const agents = envelope.payload.agents.map(row => {
        const missingSkills = row.spec.skills.filter(name => !skills.has(name))
        const manifest=renderComposition(row.spec,this.hostMcp(),this.hostToolNames()).capabilities!
        const missingMcp = Object.keys(row.spec.mcpTools).filter(name => !mcp.has(name))
        return { id: row.spec.id, name: row.spec.name, conflict: existingAgents.has(row.spec.id), missingSkills, missingMcp, missingCapabilities:manifest.missing, readinessScope:'definition-only', liveVerified:false, ready: !missingSkills.length && !manifest.missing.length }
      })
      const available = new Set(envelope.payload.agents.map(row => row.spec.id))
      const tasks = envelope.payload.tasks.map(row => ({ id: row.id, title: row.title, conflict: existingTasks.has(row.id), missingAgents: taskAgentIds(row).filter(id => !available.has(id) && !existingAgents.has(id)), scheduleDisabled: row.trigger.kind === 'cron' }))
      const runtime = envelope.runtime ? {
        missingMcp: envelope.runtime.mcps.map(row => row.serverName).filter(name => !mcp.has(name)),
        missingSkills: envelope.runtime.skills.map(row => row.id).filter(name => !skills.has(name)),
        bootstrapAvailable: Boolean(envelope.runtime.bootstrap && Date.parse(envelope.runtime.bootstrap.expiresAt) > Date.now()),
      } : undefined
      return { agents, tasks, runtime, counts: { agents: agents.length, tasks: tasks.length }, exportedAt: envelope.exportedAt, sourceVersion: envelope.source.version, digest: envelope.digest.value }
    })
  }

  async previewConfigImport(payload: string): Promise<string> {
    await this.ready
    const { url } = JSON.parse(payload) as { url?: string }
    if (!url) throw Error('请输入 R2 配置地址')
    const downloaded = await downloadConfig(url, this.configR2().domain)
    const importId = randomUUID()
    const now = Date.now()
    for (const [id, row] of this.pendingConfigImports) if (row.expiresAt <= now) this.pendingConfigImports.delete(id)
    this.pendingConfigImports.set(importId, { envelope: downloaded.envelope, expiresAt: now + 10 * 60_000 })
    return JSON.stringify({ importId, expiresAt: new Date(now + 10 * 60_000).toISOString(), bytes: downloaded.bytes, fileSha256: downloaded.fileSha256, ...(await this.configImportView(downloaded.envelope)) })
  }

  async applyConfigImport(payload: string): Promise<string> {
    await this.ready
    const { importId } = JSON.parse(payload) as { importId?: string }
    const pending = importId ? this.pendingConfigImports.get(importId) : undefined
    if (!pending || pending.expiresAt <= Date.now()) throw Error('导入预览已过期，请重新校验 R2 地址')
    this.pendingConfigImports.delete(importId!)
    const view = await this.configImportView(pending.envelope)
    const importedAgents: string[] = [], skippedAgents: { id: string; reason: string }[] = []
    const importedTasks: string[] = [], skippedTasks: { id: string; reason: string }[] = []
    const library = await scanSkills(), hostMcp = this.hostMcp(), hostTools = this.hostToolNames()
    for (const row of pending.envelope.payload.agents) {
      const saved = await writePreset(row.spec, hostMcp, library, userPresetRoot(), hostTools, { allowMissingSkills: true })
      const current = await readActions(saved.path)
      await saveActions(saved.path, row.actions, current.revision)
      importedAgents.push(row.spec.id)
    }
    const availableAgents = new Set<string>(importedAgents)
    for (const row of pending.envelope.payload.tasks) {
      if (this.runner.store.tasks.has(row.id)) { skippedTasks.push({ id: row.id, reason: '同 ID Task 已存在' }); continue }
      const missing = row.participants.map(p => p.agentId).filter(id => !availableAgents.has(id))
      if (missing.length) { skippedTasks.push({ id: row.id, reason: `缺少 Agent:${missing.join('、')}` }); continue }
      const task = { ...row, actions: undefined, enabled: false, createdAt: new Date().toISOString() } as any
      delete task.actions
      await this.runner.store.append({ t: 'task/created', at: task.createdAt, taskId: task.id, task })
      // Task Actions are intentionally restricted to task-chat origins. A
      // definition export has no authenticated chat-origin receipt, so never
      // fabricate one just to restore a shortcut on another machine.
      importedTasks.push(row.id)
    }
    return JSON.stringify({ importedAgents, skippedAgents, importedTasks, skippedTasks, schedulesEnabled: false })
  }

  async installConfigRuntime(payload: string): Promise<string> {
    await this.ready
    const { url } = JSON.parse(payload) as { url?: string }
    if (!url) throw Error('请输入 R2 配置地址')
    const { envelope } = await downloadConfig(url, this.configR2().domain)
    const bootstrap = envelope.runtime?.bootstrap
    if (!bootstrap || Date.parse(bootstrap.expiresAt) <= Date.now()) throw Error('配置包没有可用的运行时引导授权，请在源机器重新导出')
    return JSON.stringify(await startRuntimeBootstrap(url, bootstrap.token))
  }

  async configRuntimeStatus(payload: string): Promise<string> {
    const { jobId } = JSON.parse(payload) as { jobId?: string }
    if (!jobId) throw Error('缺少运行时安装任务编号')
    return JSON.stringify(await runtimeBootstrapStatus(jobId))
  }

  /** Header-only persistence index, coalesced briefly; live headers always win. */
  private async sessionHeaders(): Promise<AgentSessionHeader[]> {
    const ctx = this.ctx as any
    if (!this.headerCache || Date.now() - this.headerCache.at > 3000) {
      this.headerRead ??= Promise.resolve(ctx.get('sessionPersistence')?.list() ?? []).then((value: AgentSessionHeader[]) => {
        this.headerCache = { at: Date.now(), value }; return value
      }).finally(() => { this.headerRead = undefined })
      await this.headerRead
    }
    const headers = new Map((this.headerCache?.value ?? []).map(h => [h.id, h]))
    for (const session of ctx.get('sessions')?.list() ?? []) headers.set(session.id, session.header)
    return [...headers.values()]
  }

  async agentHistory(payload: string): Promise<string> {
    const query = historyQuery(JSON.parse(payload))
    await this.ready
    const headers = await this.sessionHeaders()
    const result = agentHistory(this.runner.store.s, headers, query)
    const byId = new Map(headers.map(h => [h.id, h]))
    const ctx = this.ctx as any
    // Enrich only the requested page, exclusively from live/cached projections.
    for (const row of result.sessions) {
      const live = ctx.get('sessions')?.get(row.id), meta = byId.get(row.id)
      let values: any
      try { values = (live ? ctx.get('sessionProjections')?.snapshot(live) : meta ? ctx.get('sessionProjectionCache')?.cachedSnapshot(meta) : undefined)?.values } catch { /* optional cache; no transcript fallback */ }
      row.title = typeof values?.title === 'string' ? mask(values.title) : row.kind === 'task' ? `${row.tasks[0]?.title ?? '任务执行'} · ${query.agentId}` : `${query.agentId} · 会话`
      if (ctx.agents?.get(row.id)?.status === 'running') row.status = 'running'
    }
    return JSON.stringify(result)
  }

  // ── authoring ──────────────────────────────────────────────────────────

  async agentActions(payload: string): Promise<string> {
    const query = JSON.parse(payload)
    let agentId = query.agentId
    if (query.sessionId) {
      const header = (await this.sessionHeaders()).find(h => h.id === query.sessionId)
      agentId = header?.agentPreset
      if (query.agentId && query.agentId !== agentId) throw new Error('当前会话角色不匹配，请重新选择 Action')
    }
    if (!agentId) return JSON.stringify({ agentId: null, name: '', revision: '', actions: [], writable: false } satisfies ActionCatalog)
    const presets = (this.ctx as any).get('agentPresets')
    const preset = (await presets?.list() ?? []).find((p: any) => p.id === agentId && !p.broken)
    if (!preset) throw new Error('Agent 不存在或不可用')
    const dir = dirname(String(preset.path))
    const catalog = await readActions(dir)
    const spec = await readSpec(dir)
    return JSON.stringify({ ...catalog, agentId, name: spec?.name ?? preset.name ?? agentId, writable: preset.trust === 'user' && presets.authorable !== false && resolve(dir) === resolve(userPresetRoot(), agentId) } satisfies ActionCatalog)
  }

  async saveAgentActions(payload: string): Promise<string> {
    const query = JSON.parse(payload)
    const catalog: ActionCatalog = JSON.parse(await this.agentActions(JSON.stringify({ agentId: query.agentId })))
    if (!catalog.agentId || !catalog.writable) throw new Error('这个 Agent 的 Actions 不可写')
    await saveActions(resolve(userPresetRoot(), catalog.agentId), query.actions, query.revision)
    return this.agentActions(JSON.stringify({ agentId: catalog.agentId }))
  }

  /** Host-registered metadata providers only; not a general MCP invocation API. */
  async agentActionOptions(payload: string): Promise<string> {
    const query: ActionOptionQuery = JSON.parse(payload)
    await this.ready
    const catalog: ActionCatalog = query.taskId ? this.creator.actions.read(query.taskId) : JSON.parse(await this.agentActions(payload))
    if ((!catalog.agentId && !catalog.taskId) || catalog.revision !== query.revision) throw Error('Action 已更新，请重新选择')
    const action = catalog.actions.find(a => a.id === query.actionId && a.enabled !== false)
    const parameter = action?.parameters.find(p => p.key === query.parameter)
    if (!parameter?.source) throw Error('参数没有已注册候选来源')
    optionPage([], query.search, query.page)
    const raw = query.values
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('参数依赖无效')
    const values = Object.fromEntries((parameter.dependsOn ?? []).map(k => [k, typeof raw[k] === 'string' ? raw[k].slice(0, 4000) : '']))
    if (!parameterVisible(parameter, raw)) throw Error('此参数当前不适用')
    const tool = sourceTool(parameter)
    const host = this.hostMcp().find(h => h.serverName === 'fleet-browser' && h.live && h.tools.includes(tool))
    const participantIds = catalog.taskId ? this.creator.actions.task(catalog.taskId).participants.map(p => p.agentId) : [catalog.agentId]
    const presets = (await (this.ctx as any).get('agentPresets').list()).filter((p: any) => participantIds.includes(p.id))
    const specs = await Promise.all(presets.map((p: any) => readSpec(dirname(String(p.path)))))
    if (!specs.some(spec => (spec?.mcpTools?.['fleet-browser'] ?? []).some((t: string) => t === '*' || t === tool))) throw Error('当前角色没有此只读候选能力；未扩大工具权限')
    if (!host) throw Error('候选 MCP 尚未就绪，请稍后重试；没有执行任何目标操作')
    try {
      const result = await fleetActionOptions(host.config, parameter, values, undefined, Boolean(catalog.taskId && ['fleet-base-v2','fleet-base-v3'].includes(this.creator.actions.task(catalog.taskId).workflowRecipe?.id ?? '')))
      const latest: ActionCatalog = catalog.taskId ? this.creator.actions.read(catalog.taskId) : JSON.parse(await this.agentActions(payload))
      if (latest.revision !== catalog.revision) throw Error('Action 已更新，请重新选择')
      return JSON.stringify(optionPage(result.items, query.search, query.page, result.notice))
    } catch (e) {
      // Known UI messages only, never propagate credentials, paths or raw bodies.
      const message = e instanceof Error ? e.message : ''
      throw Error(/^(此部署尚未|请先填写|目标尚无|目标未在|账号发现记录暂)/.test(message) ? message : '只读候选查询失败，请稍后重试；没有执行任何目标操作')
    }
  }

  /** Validates a fresh revision and actual session role; never sends or creates anything. */
  async prepareAgentAction(payload: string): Promise<string> {
    const query = JSON.parse(payload)
    const catalog: ActionCatalog = JSON.parse(await this.agentActions(payload))
    if (catalog.revision !== query.revision) throw new Error('Action 已更新，请关闭并重新选择')
    const action = catalog.actions.find(a => a.id === query.actionId)
    if (!action) throw new Error('Action 不存在或已删除')
    return JSON.stringify({ text: renderAction(action, query.values), agentId: catalog.agentId })
  }

  async previewAgent(payload: string): Promise<string> {
    const spec = validateSpec(JSON.parse(payload))
    const preview = renderComposition(spec, this.hostMcp(), this.hostToolNames())
    return JSON.stringify({ ...preview, yml: mask(preview.yml) } satisfies Preview)
  }

  /** Read-only drift audit. A green configuration is not a passed live invocation. */
  async agentCapabilityStatus(payload:string):Promise<string>{
    const {id}=JSON.parse(payload)
    if(typeof id!=='string'||!id.trim())throw Error('Agent id required')
    const presets=(this.ctx as any).get('agentPresets'),preset=await presets?.resolve(id)
    if(!preset)throw Error('Agent not found')
    const dir=dirname(String(preset.path)),spec=await readSpec(dir)
    if(!spec)return JSON.stringify({id,ready:false,status:'unmanaged',scope:'configuration-only',liveVerified:false})
    const expected=renderComposition(spec,this.hostMcp(),this.hostToolNames()).capabilities!
    return JSON.stringify({id,...await inspectCapabilityContract(dir,expected)})
  }

  async saveAgent(payload: string): Promise<string> {
    const spec = validateSpec(JSON.parse(payload))
    const presets = (this.ctx as any).get('agentPresets')
    if (presets && presets.authorable === false) throw new Error('这个部署没有可写的 preset 根')
    const shipped = presets ? (await presets.list() as any[]).find(p => p.id === spec.id && p.trust === 'system') : undefined
    if (shipped) throw new Error(`"${spec.id}" 是出厂 preset,不能覆盖;换个 id`)
    const { path, preview } = await writePreset(spec, this.hostMcp(), await scanSkills(), userPresetRoot(), this.hostToolNames())
    return JSON.stringify({ path, preview: { ...preview, yml: mask(preview.yml) } })
  }

  async deleteAgent(payload: string): Promise<string> {
    const { id } = JSON.parse(payload) as { id: string }
    const presets = (this.ctx as any).get('agentPresets')
    const row = presets ? (await presets.list() as any[]).find(p => p.id === id) : undefined
    if (row && row.trust !== 'user') throw new Error('出厂 preset 不能删')
    await removePreset(id)
    return JSON.stringify({ ok: true })
  }

  // ── proof ──────────────────────────────────────────────────────────────

  /**
   * Start a real session on the preset, ask one question, and report what
   * dsh actually handed the model. The session is disposed afterwards but
   * its log stays, so the evidence can be reopened.
   */
  async tryRun(payload: string): Promise<string> {
    const { id, prompt } = JSON.parse(payload) as { id: string; prompt?: string }
    const presets = (this.ctx as any).get('agentPresets')
    if (!presets) throw new Error('这个部署没有 preset 服务')
    const preset = await presets.resolve(id)
    if (preset.broken) throw new Error(`preset 坏了:${preset.broken}`)
    const spec = await readSpec(dirname(String(preset.path)))

    let selection = this.defaultModel()
    if (spec?.model && spec.model.includes('/')) {
      const [provider, ...rest] = spec.model.split('/')
      selection = { provider, model: rest.join('/'), ...(spec.effort ? { reasoningEffort: spec.effort } : {}) }
    }
    const sessionId = `tc-try-${id}-${Date.now().toString(36)}`
    const started = Date.now()
    const question = prompt?.trim() || '把你当前工具列表里的每个工具名逐行原样列出,不要省略、不要解释。然后用一句话回答:你有 bash 吗?'

    const result: TryRunResult = { sessionId, provider: selection?.provider ?? '', model: selection?.model ?? '', elapsedMs: 0, tools: [], answer: '' }
    let messageId = ''
    let consumed = false
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })

    const dispose = (this.ctx as any).on('session/event', (session: any, event: any) => {
      if (session?.id !== sessionId) return
      if (event.type === 'request/header' && result.tools.length === 0) {
        const tools = event.data?.header?.tools
        if (Array.isArray(tools)) result.tools = tools.map((t: any) => String(t.name))
      }
      if (event.type === 'user/message' && event.data?.id === messageId) consumed = true
      if (event.type === 'assistant/message') {
        const blocks = event.data?.message?.content
        if (Array.isArray(blocks)) result.answer = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
      }
      if (event.type === 'turn/end' && consumed) {
        const reason = event.data?.reason
        if (reason && reason.kind !== 'completed') result.error = JSON.stringify(reason)
        finish()
      }
    })

    let handle: any
    try {
      handle = await (this.ctx as any).agents.create({
        sessionId,
        ...(selection ? { agentOptions: selection } : {}),
        meta: { cwd: homedir(), agentPreset: preset.id },
        setup: async (agentCtx: object) => { await presets.mount(agentCtx, preset.id) },
      })
      applyAgentPermission(this.ctx, spec, handle.agent.session)
      messageId = randomUUID()
      handle.agent.followup({ id: messageId, role: 'user', content: [{ type: 'text', text: question }], source: { kind: 'user' } })
      const timeout = new Promise<void>((_, reject) => setTimeout(() => reject(new Error('120 秒没等到回合结束')), 120_000))
      await Promise.race([done, timeout])
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
    } finally {
      try { typeof dispose === 'function' && dispose() } catch { /* already gone */ }
      try { await handle?.dispose?.() } catch { /* already gone */ }
    }
    result.elapsedMs = Date.now() - started
    return JSON.stringify(result)
  }

  // ── chat with an agent ─────────────────────────────────────────────────

  /** Live handles for sessions started from the composer; disposing them would kill the chat. */
  private readonly chats = new Map<string, any>()

  /**
   * Start a root session on an agent's preset, pin a readable title, file it
   * under the workspace, and (optionally) submit the first message. The UI
   * then opens the session; the person keeps talking to it there.
   */
  async startAgentSession(payload: string): Promise<string> {
    const { agentId, text, cwd } = JSON.parse(payload) as { agentId: string; text?: string; cwd?: string }
    const presets = (this.ctx as any).get('agentPresets')
    if (!presets) throw new Error('这个部署没有 preset 服务')
    const preset = await presets.resolve(agentId)
    if (preset.broken) throw new Error(`preset 坏了:${preset.broken}`)
    const spec = await readSpec(dirname(String(preset.path)))
    const name = spec?.name ?? preset.name ?? preset.id
    let selection = this.defaultModel()
    if (spec?.model?.includes('/')) { const [provider, ...rest] = spec.model.split('/'); selection = { provider, model: rest.join('/'), ...(spec.effort ? { reasoningEffort: spec.effort } : {}) } }
    const workspaces = this.workspaces()
    const dir = cwd && cwd.trim() ? cwd.trim() : (workspaces[0]?.path ?? homedir())
    const sessionId = `agent-${agentId}-${Date.now().toString(36)}`
    const handle = await (this.ctx as any).agents.create({
      sessionId,
      ...(selection ? { agentOptions: selection } : {}),
      meta: { cwd: dir, agentPreset: preset.id },
      setup: async (agentCtx: object) => { await presets.mount(agentCtx, preset.id) },
    })
    try {
      applyAgentPermission(this.ctx, spec, handle.agent.session)
    } catch (error) {
      try { await handle.dispose?.() } catch { /* creation error wins */ }
      throw error
    }
    this.chats.set(sessionId, handle)
    // Operational input can contain SSH credentials. Do not copy it into sidebar titles.
    const head = ''
    try { (this.ctx as any).get('sessionTitle')?.rename?.(handle.agent.session, head ? `${name} · ${head}` : `${name} · 新会话`) } catch { /* cosmetic */ }
    try {
      const registry = (this.ctx as any).get('workspaceRegistry')
      const ws = registry ? (await registry.resolveByPath(dir).catch(() => undefined)) ?? (await registry.create(dir).catch(() => undefined)) : undefined
      await ws?.attachSession?.(sessionId)
    } catch { /* cosmetic */ }
    if (text && text.trim()) handle.agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: text.trim() }], source: { kind: 'user' } })
    return JSON.stringify({ sessionId, agentPreset: preset.id, name })
  }

  // ── turn ledger ────────────────────────────────────────────────────────

  async sessionCapabilities(payload: string): Promise<string> {
    return JSON.stringify(await this.capabilities.read(JSON.parse(payload).sessionId))
  }

  /** Fold one session's own log into turns → steps → tool calls (live or cold). */
  async sessionTurns(payload: string): Promise<string> {
    const { sessionId, page } = JSON.parse(payload) as { sessionId: string; page?: number }
    const persistence = (this.ctx as any).get('sessionPersistence')
    let events: any[] = []; let agentPreset: string | undefined
    if (persistence?.inspect) {
      const insp = await persistence.inspect(sessionId)
      events = insp.events ?? []; agentPreset = insp.header?.agentPreset
    } else {
      const live = (this.ctx as any).get('sessions')?.get?.(sessionId)
      events = live?.events ?? []; agentPreset = live?.header?.agentPreset
    }
    const ledger = foldTurns(sessionId, events, agentPreset)
    return JSON.stringify(page === undefined ? ledger : ledgerPage(ledger, page))
  }

  // ── tasks ──────────────────────────────────────────────────────────────

  async workflowCatalog(): Promise<string> {
    await this.ready
    return JSON.stringify(this.creator.catalog())
  }

  async taskPlans(payload: string): Promise<string> {
    await this.ready
    return JSON.stringify(this.creator.plans(JSON.parse(payload).page))
  }

  async taskPlan(payload: string): Promise<string> {
    await this.ready
    return JSON.stringify(this.creator.plan(JSON.parse(payload).id))
  }

  /** Console-only action: never registered as a Creator/worker tool. */
  async reviewTaskPlan(payload: string): Promise<string> {
    await this.ready
    const { id, hash, decision, reason } = JSON.parse(payload)
    return JSON.stringify(await this.creator.review(id, hash, decision, reason))
  }

  async launchWorkflow(payload: string): Promise<string> {
    await this.ready
    const { taskId, text, requestId, cwd } = JSON.parse(payload)
    return JSON.stringify(await this.creator.launch(taskId, text, requestId, cwd))
  }

  async taskActions(payload: string): Promise<string> {
    await this.ready
    return JSON.stringify(this.creator.actions.read(JSON.parse(payload).taskId))
  }
  async saveTaskActions(payload: string): Promise<string> {
    await this.ready
    const { taskId, actions, revision } = JSON.parse(payload)
    return JSON.stringify(this.creator.actions.save(taskId, actions, revision))
  }
  async launchTaskAction(payload: string): Promise<string> {
    await this.ready
    return JSON.stringify(await this.creator.launchAction(JSON.parse(payload)))
  }

  /** Submit one generic, credential-free Signal; the Task Agent routes it asynchronously. */
  async submitTaskSignal(payload: string): Promise<string> {
    await this.ready
    const input = JSON.parse(payload) as { signal?: unknown; wait?: boolean; timeoutMs?: number }
    const view = await this.intake.submit(input && Object.hasOwn(input, 'signal') ? input.signal : input)
    if (input?.wait) return JSON.stringify(await this.intake.wait(view.signal.id, Math.min(Math.max(Number(input.timeoutMs) || 300_000, 1_000), 600_000)))
    return JSON.stringify(view)
  }

  async taskSignal(payload: string): Promise<string> {
    await this.ready
    const { id } = JSON.parse(payload) as { id?: string }
    if (!id) throw new Error('缺少 Signal id')
    const signal = this.intake.get(id)
    if (!signal) throw new Error('没有这个 Task Signal')
    return JSON.stringify({ ...signal, events: this.intake.events(id) })
  }

  async taskSignals(payload: string): Promise<string> {
    await this.ready
    const { limit } = JSON.parse(payload || '{}') as { limit?: number }
    return JSON.stringify(this.intake.list(limit))
  }

  private withNext(t: any) {
    const schedule = t.trigger.kind === 'cron' ? this.runner.schedule.state(t.id) : null
    return { ...t, nextFire: t.trigger.kind === 'cron' && t.enabled ? (schedule?.next_at ? new Date(schedule.next_at).toISOString() : nextFire(parseCron(t.trigger.expr)!, new Date(), t.trigger.timeZone)?.toISOString() ?? null) : null }
  }

  async taskSchedule(payload: string): Promise<string> {
    await this.ready
    const { id, page } = JSON.parse(payload)
    if (!this.runner.store.tasks.has(id)) throw new Error('没有这个任务')
    return JSON.stringify(this.runner.schedule.view(id, page))
  }

  async executionHistory(payload: string): Promise<string> {
    await this.ready
    return JSON.stringify(executionHistory(this.runner.store, JSON.parse(payload)))
  }

  /** Every map as arrays — one payload for the board and the detail page. */
  async board(): Promise<string> {
    await this.ready
    const st = this.runner.store.s
    const out: BoardView = {
      tasks: [...st.tasks.values()].map(t => this.withNext(t)),
      batches: [...st.batches.values()].sort((a, b) => b.firedAt.localeCompare(a.firedAt)),
      cards: [...st.cards.values()],
      runs: [...st.runs.values()],
    }
    return JSON.stringify(out)
  }

  /**
   * Legacy projection for the 0.4 UI: a batch rendered as the old Run
   * with `legs`. Kept until the 0.5 pages land; then removed.
   */
  private taskPageCache = new Map<string, { stamp: string; at: number; value: string }>()

  async taskPage(payload: string): Promise<string> {
    await this.ready
    const input = JSON.parse(payload), store = this.runner.store, st = store.s, db = store.kernel.db
    const stamp = JSON.stringify([db.prepare('SELECT total_changes() n').get(), db.pragma('data_version')])
    const key = JSON.stringify(input), cached = this.taskPageCache.get(key)
    if (cached?.stamp === stamp && Date.now() - cached.at < 2000) return cached.value
    const presets = (this.ctx as any).get('agentPresets')
    const labels = new Map<string,string>((presets ? await presets.list() : []).map((p:any)=>[p.id,p.name??p.id]))
    const index = taskListIndex(store, input, labels)
    const rows = index.rows.map(({task,batch,state,history}) => {
      const {id,title,brief,trigger,enabled,createdAt,origin} = task
      const projected = {id,title,brief:brief.slice(0,240),trigger,enabled,createdAt,origin,participants:task.participants.map(p=>({agentId:p.agentId})),nextFire:this.withNext(task).nextFire}
      if (!batch) return {task:projected,state,history}
      const cards = batch.cardIds.map((id:string)=>st.cards.get(id)).filter(Boolean) as Card[]
      const legs = cards.map(c=>{const r=cardRun(st,c);return {agentId:c.kind==='gate'?'系统闸门':c.agentId,status:c.status==='ready'||c.status==='scheduled'?'queued':c.status,tries:c.runIds.length,
        question:c.wakeAt?`定时等待，${c.wakeAt} 自动继续：${r?.question??''}`:r?.status==='blocked'?r.question:undefined,error:c.error?.slice(0,400)}})
      const artifacts=withFinalArtifact([...st.artifacts.values()].filter(a=>a.batchId===batch.id),cards,batch)
      const final=artifacts.find(a=>a.final), result=final??artifacts.at(-1), rounds=cards.filter(c=>c.kind==='gate').length
      return {task:projected,state,history,latest:{id:batch.id,taskId:id,firedAt:batch.firedAt,by:batch.by,legs,settled:batch.settled,
        ...(final?{finalArtifact:this.artifactView(final)}:{}),...(result?{resultArtifact:this.artifactView(result)}:{}),rounds,reworks:Math.max(0,rounds-1)}}
    })
    const used=new Set(rows.flatMap(r=>r.task.participants.map(p=>p.agentId)))
    const value=JSON.stringify({...index,rows,agents:[...used].map(id=>({id,name:labels.get(id)??id}))})
    if (this.taskPageCache.size>=100) this.taskPageCache.clear()
    this.taskPageCache.set(key,{stamp,at:Date.now(),value})
    return value
  }

  async tasks(): Promise<string> {
    await this.ready
    const st = this.runner.store.s
    const tasks = [...st.tasks.values()].filter(t => !t.archivedAt)
    const visible = new Set(tasks.map(t => t.id))
    const runs = [...st.batches.values()].filter(b => visible.has(b.taskId) && !b.archivedAt).sort((a, b) => b.firedAt.localeCompare(a.firedAt)).map(b => {
      const legs = b.cardIds.map(id => st.cards.get(id)).filter(Boolean).map(c => {
        const r = cardRun(st, c!)
        const status = c!.status === 'done' ? 'done' : c!.status === 'review' ? 'review' : c!.status === 'running' ? 'running' : c!.status === 'blocked' ? 'blocked' : c!.status === 'failed' ? (r?.status === 'timed_out' ? 'timed_out' : r?.status === 'crashed' ? 'lost' : 'failed') : c!.status === 'cancelled' ? 'cancelled' : 'queued'
        return { agentId: c!.kind === 'gate' ? '系统闸门' : c!.agentId, status, tries: c!.runIds.length, sessionId: r?.sessionId || undefined, startedAt: c!.startedAt, endedAt: c!.endedAt, handoff: c!.summary, question: c!.wakeAt ? `定时等待，${c!.wakeAt} 自动继续：${r?.question || ''}` : r?.status === 'blocked' ? r.question : undefined, error: c!.error }
      })
      const bs = batchStatus(st, b)
      const cards = b.cardIds.map(id => st.cards.get(id)).filter(Boolean)
      const artifacts = withFinalArtifact([...st.artifacts.values()].filter(a => a.batchId === b.id), cards as Card[], b)
      const final = artifacts.find(a => a.final)
      const latestArtifact = final ?? artifacts.at(-1)
      const rounds = cards.filter(card => card?.kind === 'gate').length
      return {
        id: b.id, taskId: b.taskId, firedAt: b.firedAt, by: b.by, legs,
        ...(b.settled ? { settled: b.settled } : bs === 'done' ? { settled: { at: b.firedAt, outcome: 'done' } } : {}),
        ...(final ? { finalArtifact: this.artifactView(final) } : {}),
        ...(latestArtifact ? { resultArtifact: this.artifactView(latestArtifact) } : {}),
        ...(rounds ? { rounds, reworks: Math.max(0, rounds - 1) } : {}),
      }
    })
    return JSON.stringify({ tasks: tasks.map(t => this.withNext(t)), runs })
  }

  async createTask(payload: string): Promise<string> {
    const presets = (this.ctx as any).get('agentPresets')
    const rows = presets ? (await presets.list() as any[]) : []
    const ids = new Set<string>(rows.filter(p => !p.broken).map(p => String(p.id)))
    const raw = JSON.parse(payload)
    if(raw.saveOnly !== undefined && typeof raw.saveOnly !== 'boolean')throw Error('saveOnly 必须是布尔值')
    const task = validateTask(raw, ids)
    for (const p of rows) { const spec = p.trust === 'user' ? await readSpec(dirname(String(p.path))) : null; this.runner.rememberName(p.id, spec?.name ?? p.name ?? p.id) }
    await this.runner.store.append({ t: 'task/created', at: task.createdAt, taskId: task.id, task })
    if (task.trigger.kind === 'once' && !raw.saveOnly) await this.runner.fire(task.id, 'manual', {dispatch:'background'})
    return JSON.stringify({ id: task.id })
  }

  async setTaskEnabled(payload: string): Promise<string> {
    const { id, enabled } = JSON.parse(payload) as { id: string; enabled: boolean }
    if (!this.runner.store.tasks.has(id)) throw new Error('没有这个任务')
    if (enabled) await this.creator.assertScheduleActivation(this.runner.store.tasks.get(id)!)
    await this.runner.store.append({ t: 'task/enabled', at: new Date().toISOString(), taskId: id, enabled: !!enabled })
    this.runner.schedule.sync(this.runner.store.tasks.get(id)!, Date.now(), true)
    if (enabled) this.creator.scheduleActivated(this.runner.store.tasks.get(id)!)
    return JSON.stringify({ ok: true })
  }

  private async removeTask(id: string): Promise<void> {
    if (!this.runner.store.tasks.has(id)) throw new Error('没有这个任务')
    for (const b of this.runner.store.s.batches.values()) if (b.taskId === id && !b.settled && !b.archivedAt) await this.runner.cancelBatch(b.id)
    await this.runner.store.append({ t: 'task/deleted', at: new Date().toISOString(), taskId: id })
  }

  /** Reversible list cleanup, not deletion of execution rows or native sessions. */
  async setTasksArchived(payload: string): Promise<string> {
    await this.ready
    const { ids, archived } = JSON.parse(payload)
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id) || typeof archived !== 'boolean') throw new Error('请选择明确的任务和归档状态')
    const changed = await this.runner.store.setTasksArchived(ids, archived)
    for (const id of new Set<string>(ids)) this.runner.schedule.sync(this.runner.store.tasks.get(id)!, Date.now(), true)
    return JSON.stringify({ ok: true, changed, archived })
  }

  async setBatchArchived(payload: string): Promise<string> {
    await this.ready
    const { taskId, batchId, archived } = JSON.parse(payload)
    if (typeof taskId !== 'string' || !taskId || typeof batchId !== 'string' || !batchId || typeof archived !== 'boolean') throw new Error('需要明确任务、执行记录及归档状态')
    const changed = await this.runner.store.setBatchArchived(taskId, batchId, archived)
    return JSON.stringify({ ok:true, changed, archived })
  }

  async deleteTask(payload: string): Promise<string> {
    const { id } = JSON.parse(payload) as { id: string }
    await this.removeTask(id)
    return JSON.stringify({ ok: true })
  }

  /** Deletes only selected task-console records. DSH sessions and workspace files are never targets. */
  async deleteTasks(payload: string): Promise<string> {
    const { ids } = JSON.parse(payload) as { ids?: unknown }
    const unique = [...new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id) : [])]
    if (!unique.length) throw new Error('请选择至少一个任务')
    const missing = unique.find(id => !this.runner.store.tasks.has(id))
    if (missing) throw new Error(`没有这个任务：${missing}`)
    for (const id of unique) await this.removeTask(id)
    return JSON.stringify({ ok: true, deleted: unique.length })
  }

  async fireTask(payload: string): Promise<string> {
    const { id, by, requestId } = JSON.parse(payload) as { id: string; by?: 'manual' | 'retry'; requestId?:string }
    if(requestId!==undefined&&!/^[a-zA-Z0-9-]{16,80}$/.test(requestId))throw Error('Invalid execution requestId')
    const presets = (this.ctx as any).get('agentPresets')
    for (const p of presets ? (await presets.list() as any[]) : []) { const spec = p.trust === 'user' ? await readSpec(dirname(String(p.path))) : null; this.runner.rememberName(p.id, spec?.name ?? p.name ?? p.id) }
    const batch = await this.runner.fire(id, by === 'retry' ? 'retry' : 'manual', {dispatch:'background',...(requestId?{batchId:'b-manual-'+requestId}:{})})
    return JSON.stringify({ runId: batch.id, batchId: batch.id })
  }

  async cancelRun(payload: string): Promise<string> {
    const { runId, batchId } = JSON.parse(payload) as { runId?: string; batchId?: string }
    await this.runner.cancelBatch(batchId ?? runId ?? '')
    return JSON.stringify({ ok: true })
  }

  async taskEvents(payload: string): Promise<string> {
    const { id } = JSON.parse(payload) as { id: string }
    // The browser folds this stream, so task/created and batch/fired may never be truncated.
    return JSON.stringify(this.runner.store.all().filter((e: any) => e.taskId === id).map((e: any) => e.t === 'artifact/registered' ? { ...e, artifact: this.artifactView(e.artifact) } : e))
  }

  /** Initial detail payload in one round trip; live polling stays event-only afterwards. */
  async taskSnapshot(payload: string): Promise<string> {
    const { id, batchId, summary } = JSON.parse(payload) as { id: string; batchId?: string; summary?: boolean }
    const task = this.runner.store.s.tasks.get(id)
    if (summary && task && (task.graphMode === 'dynamic-rounds' || task.origin?.source === 'task-chat')) {
      const all = [...this.runner.store.s.batches.values()].filter(b => b.taskId === id).sort((a, b) => b.firedAt.localeCompare(a.firedAt))
      const selected = batchId ? all.find(b => b.id === batchId) : all.find(b => !b.archivedAt)
      if (batchId && !selected) throw new Error('执行记录不属于这个任务')
      const recent = all.slice(0, 10)
      if (selected && !recent.some(b => b.id === selected.id)) recent.splice(9, 1, selected)
      const batches = recent.map(b => b.id === selected?.id ? b : { ...b, turn: undefined, cardIds: [] })
      return JSON.stringify({ events: [], artifacts: [], batchId: selected?.id ?? null, detail: { task, batches, total: all.length, archived: all.filter(b => b.archivedAt).length } })
    }
    const events = this.runner.store.all().filter((e: any) => e.taskId === id).map((e: any) => e.t === 'artifact/registered' ? { ...e, artifact: this.artifactView(e.artifact) } : e)
    if (!this.runner.store.s.tasks.has(id)) return JSON.stringify({ events, artifacts: [], batchId: null })
    const selected = batchId ?? [...this.runner.store.s.batches.values()].filter(batch => batch.taskId === id && !batch.archivedAt).sort((a, b) => b.firedAt.localeCompare(a.firedAt))[0]?.id
    const artifacts = selected ? (await this.artifactsFor(id, selected)).map(a => this.artifactView(a)) : []
    return JSON.stringify({ events, artifacts, batchId: selected ?? null })
  }

  /** Raw normalized rows plus the canonical event log for DB-faithful replay. */
  async taskGraph(payload: string): Promise<string> {
    const { id, batchId, after } = JSON.parse(payload) as { id: string; batchId?: string; after?: number }
    if (!this.runner.store.s.tasks.has(id)) throw new Error('没有这个任务')
    const selected = batchId ?? [...this.runner.store.s.batches.values()].filter(batch => batch.taskId === id && !batch.archivedAt).sort((a, b) => b.firedAt.localeCompare(a.firedAt))[0]?.id
    if (!selected) throw new Error('这个任务还没有运行')
    return JSON.stringify(this.runner.store.graphSnapshot(id, selected, after))
  }

  private artifactView(a: Artifact): ArtifactView {
    const { storagePath: _storagePath, ...view } = a
    return view
  }

  private async artifactsFor(taskId: string, batchId?: string): Promise<Artifact[]> {
    const task = this.runner.store.s.tasks.get(taskId)
    if (!task) throw new Error('没有这个任务')
    const registered = [...this.runner.store.s.artifacts.values()].filter(a => a.taskId === taskId && (!batchId || a.batchId === batchId))
    const runs = [...this.runner.store.s.runs.values()].filter(r => r.taskId === taskId && (!batchId || r.batchId === batchId))
    const legacy = await discoverLegacyArtifacts(task, runs, new Set(registered.map(a => a.originalPath)))
    const rows = [...registered, ...legacy].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const batches = batchId
      ? [this.runner.store.s.batches.get(batchId)].filter(Boolean)
      : [...this.runner.store.s.batches.values()].filter(batch => batch.taskId === taskId)
    const projected = new Map(rows.map(row => [row.id, row]))
    for (const batch of batches) {
      const selected = rows.filter(row => row.batchId === batch!.id)
      const cards = batch!.cardIds.map(id => this.runner.store.s.cards.get(id)).filter(Boolean)
      for (const artifact of withFinalArtifact(selected, cards as Card[], batch)) projected.set(artifact.id, artifact)
    }
    return [...projected.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async taskArtifacts(payload: string): Promise<string> {
    const { id, batchId } = JSON.parse(payload) as { id: string; batchId?: string }
    return JSON.stringify((await this.artifactsFor(id, batchId)).map(a => this.artifactView(a)))
  }

  async artifactContent(payload: string): Promise<string> {
    const { id, batchId, artifactId } = JSON.parse(payload) as { id: string; batchId?: string; artifactId: string }
    const task = this.runner.store.s.tasks.get(id)
    if (!task) throw new Error('没有这个任务')
    const artifact = (await this.artifactsFor(id, batchId)).find(a => a.id === artifactId)
    if (!artifact) throw new Error('没有这个产物')
    const data = await readArtifact(this.runner.store.root, task, artifact)
    return JSON.stringify({ artifact: this.artifactView(artifact), base64: data.toString('base64') })
  }

  async publishArtifact(payload: string): Promise<string> {
    const { id, artifactId } = JSON.parse(payload) as { id: string; artifactId: string }
    const task = this.runner.store.s.tasks.get(id)
    const artifact = this.runner.store.s.artifacts.get(artifactId)
    if (!task || !artifact || artifact.taskId !== id) throw new Error('只能发布已登记并保存快照的产物')
    const token = process.env.DSH_TASK_CONSOLE_UPLOAD_TOKEN ?? process.env.UPLOAD_R2_TOKEN ?? ''
    if (!token) throw new Error('宿主未配置 DSH_TASK_CONSOLE_UPLOAD_TOKEN,不能发布公网链接')
    const data = await readArtifact(this.runner.store.root, task, artifact)
    const publicUrl = await publishHtml({
      endpoint: process.env.DSH_TASK_CONSOLE_UPLOAD_URL ?? process.env.UPLOAD_R2_URL ?? 'https://upload-r2.vyibc.com',
      domain: process.env.DSH_TASK_CONSOLE_PUBLIC_DOMAIN ?? process.env.UPLOAD_R2_DOMAIN ?? 'https://resource.vyibc.com',
      token,
    }, artifact, data)
    await this.runner.store.append({ t: 'artifact/published', at: new Date().toISOString(), taskId: id, artifactId, publicUrl })
    return JSON.stringify({ publicUrl })
  }

  async reviewCard(payload: string): Promise<string> {
    const { cardId, decision, note, targetCardId } = JSON.parse(payload) as { cardId: string; decision: 'approve' | 'changes'; note?: string; targetCardId?: string }
    if (decision !== 'approve' && decision !== 'changes') throw new Error('不支持的验收决定')
    await this.runner.reviewCard(cardId, decision, note, targetCardId)
    return JSON.stringify({ ok: true })
  }

  async recoverStudioCard(payload: string): Promise<string> {
    return JSON.stringify(await this.runner.recoverStudioCard(JSON.parse(payload)))
  }

  /** Console operator recovery only; never registered as an Agent tool. */
  async reconcileStudioImageOperation(payload:string):Promise<string>{
    const persistence=(this.ctx as any).get('sessionPersistence')
    if(!persistence?.inspect)throw Error('studio-image-reconcile-original-session-required')
    return JSON.stringify(await reconcileStudioImageOperation(this.runner.store,JSON.parse(payload),id=>persistence.inspect(id)))
  }

  async unblockCard(payload: string): Promise<string> {
    const { cardId } = JSON.parse(payload) as { cardId: string }
    if (!cardId?.trim()) throw new Error('缺少 cardId')
    await this.runner.unblockCard(cardId)
    return JSON.stringify({ ok: true })
  }

  /** What one agent has been doing: cards, last run, tasks it takes part in. */
  async agentActivity(payload: string): Promise<string> {
    const { agentId } = JSON.parse(payload) as { agentId: string }
    const st = this.runner.store.s
    const cards = [...st.cards.values()].filter(c => c.agentId === agentId)
    const runs = cards.flatMap(c => c.runIds.map(id => st.runs.get(id)).filter(Boolean)) as any[]
    const last = runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
    const tasks = [...st.tasks.values()].filter(t => t.participants.some(p => p.agentId === agentId)).map(t => ({ id: t.id, title: t.title }))
    const done = cards.filter(c => c.status === 'done').length
    const failed = cards.filter(c => c.status === 'failed').length
    return JSON.stringify({ cards: cards.length, done, failed, runs: runs.length, lastRunAt: last?.startedAt ?? null, lastOutcome: last?.outcome ?? last?.status ?? null, tasks })
  }
}
