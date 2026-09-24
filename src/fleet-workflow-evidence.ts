import type { CompletionCheck } from './runner.ts'
import { publicToolName } from './filtered-mcp-client.ts'

export const fullFleetRecipe = 'fleet-base-v3'
export const fleetRoles = ['fleet-installer', 'browser-manager', 'fleet-runner-operator'] as const
type Role = typeof fleetRoles[number]
/** Only host readback failures with a known owner may schedule bounded repair. */
export class FleetRepairRequired extends Error {
  constructor(readonly owner: Role, reason: string) {
    super(`完整 Fleet 接入验收未通过：${reason}`)
  }
}
const repair = (owner: Role, reason: string): never => { throw new FleetRepairRequired(owner, reason) }
type Receipt = { name: string; args: any; value: any; seq: number }
export type FleetRoleEvidence = { role: Role; sessionId: string; events: any[] }
const reject = (reason: string): never => { throw Error(`完整 Fleet 接入验收未通过：${reason}`) }
const stamp = (value: unknown) => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
const ipv4 = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value) && value.split('.').every(x => Number(x) <= 255)
export function fleetNodeForIp(nodes: any[], ip: string) {
  const matches = (nodes ?? []).filter(n => {
    try { return new URL(n.dashboardUrl).hostname === `clash-${ip.replaceAll('.','-')}.vyibc.com` } catch { return false }
  })
  if (matches.length !== 1) return reject(`${ip} Fleet 名册目标缺失或不唯一`)
  return matches[0]
}

/** Pair host-native calls/results. Neither model metadata nor an unpaired result is evidence. */
export function fleetReceipts(role: Role, events: any[]): Receipt[] {
  const native = role === 'fleet-installer' ? ['fleet_onboard_start', 'fleet_onboard_resume', 'fleet_onboard_report']
    : role === 'fleet-runner-operator' ? ['fleet_runner_ensure', 'fleet_runner_status'] : []
  const names = new Map(native.map(name => [name, name]))
  if (role === 'browser-manager') for (const server of ['fleet-browser', 'fleet-browser-browser-manager'])
    for (const name of ['browser_inspect', 'browser_status']) names.set(publicToolName(server, name), name)
  const calls = new Map<string, { name: string; args: any }>(), results: Receipt[] = []
  for (const event of events) {
    if (event.type === 'tool/call' && names.has(event.data?.name)) {
      try { calls.set(event.data.callId, {name:names.get(event.data.name)!,args:JSON.parse(event.data.arguments)}) } catch { /* malformed calls prove nothing */ }
    }
    if (event.type !== 'tool/result') continue
    for (const part of event.data?.message?.content ?? []) {
      const call = calls.get(part.toolCallId)
      if (part.type !== 'tool-result' || !call) continue
      calls.delete(part.toolCallId)
      if (part.isError) { results.push({...call,value:{ok:false},seq:event.seq}); continue }
      try {
        const value = JSON.parse((part.content ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join(''))
        results.push({...call,value,seq:event.seq})
      } catch { results.push({...call,value:{ok:false},seq:event.seq}) }
    }
  }
  return results
}

function checkBase(ip: string, receipts: Receipt[]) {
  const actions = receipts.filter(r => ['fleet_onboard_start','fleet_onboard_resume'].includes(r.name) && r.args?.ip === ip)
  const action = actions.at(-1), value = action?.value
  if (!value || value.ip !== ip || value.ok !== true || value.phase !== 'complete' || value.current_stage !== 10 || value.probe_executed !== true || value.report_available !== true || typeof value.run_id !== 'string')
    return reject(`${ip} 缺少本会话新鲜探测后完成基础十阶段的回执；只读取旧 status/report 不算本次验收`)
  const report = receipts.filter(r => r.name === 'fleet_onboard_report' && r.args?.ip === ip).at(-1)
  if (!report || report.seq <= action!.seq || report.value.ip !== ip || report.value.run_id !== value.run_id || report.value.phase !== 'complete' || !report.value.report_available || !report.value.report)
    return reject(`${ip} 缺少同一基础事务的最终报告`)
  const latest = new Map<number, any>()
  for (const stage of report.value.stages ?? []) if (!latest.has(stage.stage) || stage.attempt >= latest.get(stage.stage).attempt) latest.set(stage.stage, stage)
  if (Array.from({length:10},(_,i)=>i+1).some(i => latest.get(i)?.status !== 'passed')) return reject(`${ip} 基础阶段证据不完整`)
  return {ip,runId:value.run_id,eventSeq:report.seq,stages:[...latest.values()].map(s=>({stage:s.stage,status:s.status,action:s.action}))}
}

function checkRunner(ip: string, evidence: FleetRoleEvidence, started: number, now: number) {
  const receipts = fleetReceipts(evidence.role,evidence.events)
  const ensure = receipts.filter(r => r.name === 'fleet_runner_ensure' && r.args?.ip === ip).at(-1)
  const result = receipts.filter(r => ['fleet_runner_ensure','fleet_runner_status'].includes(r.name) && r.args?.ip === ip).at(-1)
  const value = result?.value, observed = stamp(value?.updatedAt)
  if (!ensure || !result || result.seq < ensure.seq || value?.ip !== ip || value.sessionId !== evidence.sessionId || value.ok !== true || value.phase !== 'complete' || value.signatureVerified !== true || value.runnerCoverageHealthy !== true || typeof value.signedJobId !== 'string' || !value.signedJobId || !Number.isFinite(observed) || observed < started || observed > now + 5000 || now-observed > 600_000)
    return reject(`${ip} 缺少本次 Runner 接入与真实签名作业回执；旧记录或仅有心跳不能交卷`)
  // Signed delivery proves Runner coverage, not node health. Required business
  // observations are independently read below; an optional probe failure is retained.
  return {ip,targetId:value.targetId,jobId:value.signedJobId,checkedAt:value.updatedAt,eventSeq:result.seq,nodeHealthy:value.nodeHealthy === true,
    checks:(value.checks ?? []).map((c: any)=>({name:c.name,status:c.status})),action:value.action}
}

function checkBrowser(ip: string, evidence: FleetRoleEvidence) {
  const rows = fleetReceipts(evidence.role,evidence.events).filter(r => r.args?.ip === ip)
  const inspect = rows.filter(r => r.name === 'browser_inspect').at(-1)
  if (!inspect || inspect.value.ip !== ip || inspect.value.ok !== true) return reject(`${ip} 缺少浏览器管理员本会话成功 inspect 证据`)
  return {ip,eventSeq:rows.at(-1)!.seq}
}

function checkBrowserReadback(ip: string, node: any, now: number) {
  if (!node?.reachable) return reject(`${ip} Fleet 当前不可达，需要先定位接入原因`)
  if (node.capabilityError || !node.browserService) return repair('browser-manager',`${ip} 独立浏览器管理能力未接入或读取失败`)
  for (const instance of [1,2]) {
    const browser = node.browsers?.find((b: any)=>b.browserNo === instance), check = browser?.loginVerification
    if (!browser || browser.desktopOnly || !Number.isInteger(Number(browser.cdpPort)) || Number(browser.cdpPort) < 1)
      return repair('browser-manager',`${ip}/browser-${instance} 只有桌面信息或缺少 CDP`)
    if (!['verified','signed_out'].includes(check?.status) || !Number.isFinite(stamp(check.checkedAt)) || stamp(check.checkedAt)>now+5000 || !(stamp(check.expiresAt)>now))
      return repair('browser-manager',`${ip}/browser-${instance} 登录检测未知、缺失或过期；这不是明确未登录`)
  }
}

export async function validateFleetWorkflowEvidence(input: CompletionCheck, deps: {
  evidence: (role: Role) => Promise<FleetRoleEvidence | undefined>
  read: (kind: 'fleet' | 'exits' | 'lines') => Promise<any>
  now?: () => number
}) {
  if (input.task.workflowRecipe?.id !== fullFleetRecipe) return
  const now = (deps.now || Date.now)(), started = stamp(input.batch.firedAt)
  const targets = [...new Set((input.batch.turn?.targets ?? []).filter(t=>t.kind === 'fleet-node').map(t=>t.id))]
  if (!Number.isFinite(started) || started > now || !targets.length || targets.some(ip=>!ipv4(ip))) return reject('缺少本次执行的明确目标或开始时间')
  const index = fleetRoles.indexOf(input.profileId as Role)
  if (index < 0 || input.task.participants.map(p=>p.agentId).join(',') !== fleetRoles.join(',')) return reject('完整接入必须使用已审查的三个角色及交接顺序')
  const accepted: any[] = []
  for (const role of fleetRoles.slice(0,index+1)) {
    const source = await deps.evidence(role)
    const evidence = source && { ...source, events: source.events.filter(e => Number.isFinite(e.time) && e.time >= started && e.time <= now + 5000) }
    if (!evidence || evidence.role !== role || !evidence.sessionId || role === input.profileId && evidence.sessionId !== input.sessionId) return reject(`缺少同一执行中的 ${role} 原始会话证据`)
    const receipts = fleetReceipts(role,evidence.events)
    for (const ip of targets) accepted.push({role,sessionId:evidence.sessionId,...(role === 'fleet-installer' ? checkBase(ip,receipts)
      : role === 'browser-manager' ? checkBrowser(ip,evidence) : checkRunner(ip,evidence,started,now))})
  }
  const nodeIds = new Map<string,string>()
  if (index >= 1) {
    const fleet = await deps.read('fleet')
    for (const ip of targets) {
      const node = fleetNodeForIp(fleet.nodes,ip)
      nodeIds.set(ip,node.id)
      checkBrowserReadback(ip,node,now)
      if (input.task.workflowRecipe.login === 'provision-gemini' && node.browsers.filter((b: any)=>[1,2].includes(b.browserNo)).some((b: any)=>b.identities?.gemini !== 'in' || b.loginVerification?.status !== 'verified')) return repair('browser-manager',`${ip} 本次要求的 Gemini 登录尚未通过；先定位，不绕过人工挑战或重复导入健康账号`)
      if (index === 2) {
        if (accepted.find(r=>r.role === 'fleet-runner-operator' && r.ip === ip)?.targetId !== node.id) return reject(`${ip} Runner 回执目标与 Fleet 名册不一致`)
        const reach = node.reachability
        if (reach?.state !== 'reachable' || reach.fresh !== true || reach.source !== 'signed-runner-result' || !(stamp(reach.lastObservedAt)>=started) || stamp(reach.lastObservedAt)>now+5000)
          return repair('fleet-runner-operator',`${ip} 缺少本轮 Runner 持续状态观测`)
        const telemetry = node.telemetry, network = node.network
        if (telemetry?.contract !== 'fleet-host-v1' || telemetry.complete !== true || !(stamp(telemetry.checkedAt)>=now-180_000) || stamp(telemetry.checkedAt)>now+5000 || !(node.host?.totalMb>0) || !(node.host?.disk?.totalGb>0) || network?.status !== 'fresh' || !(stamp(network.checkedAt)>=now-180_000) || stamp(network.checkedAt)>now+5000 ||
          ['gemini','claude','chatgpt','youtube','github'].some(id=>network.targets?.[id]?.ok !== true)) return repair('fleet-installer',`${ip} 主机或代理指标缺失、失败或过期`)
      }
    }
  }
  if (index === 2) {
    const [exits,lines] = await Promise.all([deps.read('exits'),deps.read('lines')])
    for (const ip of targets) {
      const nodeId = nodeIds.get(ip), job = accepted.find(r=>r.role === 'fleet-runner-operator' && r.ip === ip)?.jobId
      const exit = exits.rows?.find((r: any)=>r.id === nodeId), line = lines.rows?.find((r: any)=>r.id === nodeId)
      if (exit?.jobId !== job || exit.source !== 'fleet-probe-runner' || !ipv4(exit.exitIp) || !(stamp(exit.verifiedAt)>=started) || stamp(exit.verifiedAt)>now+5000 || !(stamp(exit.expiresAt)>now)) return repair('fleet-runner-operator',`${ip} 缺少本次签名巡检的有效出口验证`)
      if (exit.exitIp !== exit.expectedIp) return repair('fleet-installer',`${ip} 本次观测出口不符合期望线路`)
      if (line?.jobId !== job || line.source !== 'fleet-probe-runner' || line.error || !Array.isArray(line.lines) || !line.lines.length || !(stamp(line.checkedAt)>=started) || stamp(line.checkedAt)>now+5000) return repair('fleet-runner-operator',`${ip} 缺少本次候选线路实拨结果`)
    }
  }
  return {contract:fullFleetRecipe,scope:index === 2 ? input.task.workflowRecipe.login === 'provision-gemini' ? 'node-and-login' : 'full-node' : 'role-handoff',checkedAt:new Date(now).toISOString(),accepted}
}
