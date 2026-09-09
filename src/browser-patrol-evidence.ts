import type { CompletionCheck } from './runner.ts'
import { createHash } from 'node:crypto'

/** Host-owned native tool events, never model-authored summary/metadata. */
export function collectBrowserEvidence(input: Pick<CompletionCheck, 'profileId' | 'sessionId'>, events: any[]) {
  const names = new Map<string, string>()
  for (const server of ['fleet-browser', `fleet-browser-${input.profileId}`]) for (const raw of ['browser_fleet_inventory', 'browser_inspect', 'browser_status']) {
    const full = `mcp__${server}__${raw}`
    names.set(full.length <= 64 ? full : `${full.slice(0, 51)}_${createHash('sha256').update(`${server}\0${raw}`).digest('hex').slice(0, 12)}`, raw)
  }
  const calls = new Map<string, { name: string; args: any; seq: number }>()
  const inspections = new Map<string, any>()
  const verifications = new Map<string, any>()
  const verificationHistory: { key: string; row: any }[] = []
  let inventory: any
  for (const e of events) {
    if (e.type === 'tool/call') {
      const name = names.get(e.data.name)
      if (!name) continue
      try { calls.set(e.data.callId, { name, args: JSON.parse(e.data.arguments), seq: e.seq }) } catch { /* malformed call cannot prove anything */ }
    }
    if (e.type !== 'tool/result') continue
    for (const part of e.data?.message?.content ?? []) {
      const call = calls.get(part.toolCallId)
      if (part.type !== 'tool-result' || part.isError || !call) continue
      let value: any
      try { value = JSON.parse((part.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')) } catch { continue }
      if (call.name === 'browser_fleet_inventory' && value.ok === true && Array.isArray(value.nodes) && !inventory)
        inventory = { ...value, evidenceSeq: e.seq }
      if (call.name === 'browser_inspect' && value.ip === call.args.ip && Array.isArray(value.loginAssessment?.browsers))
        inspections.set(value.ip, { ...value.loginAssessment, evidenceSeq: e.seq })
      if (call.name === 'browser_status' && value.id === call.args.operationId && value.args?.ip === call.args.ip &&
          value.args.sessionId === input.sessionId && ['login-verify', 'login-provision', 'login-copy', 'login-resume'].includes(value.action) && value.phase === 'complete') {
        const proof = value.result?.verification ?? (value.action === 'login-resume' ? value.result : undefined), v = proof?.loginVerification, a = proof?.identity?.account
        if (proof?.instance !== value.args.instance || !v) continue
        const observedAt = value.updatedAt
        // The receipt carries real verifier timestamps, never status polling time.
        const fresh = Date.parse(v.checkedAt) <= Date.parse(observedAt) && Date.parse(v.expiresAt) > Date.parse(observedAt)
        const verified = fresh && v.status === 'verified' && proof.loginVerified === true && proof.identity?.gemini === 'in' && a?.source === 'gemini-account-control' && /^[a-f0-9]{8,64}$/.test(a.fingerprint || '')
        const key = `${value.args.ip}:${value.args.instance}`, row = { instance: value.args.instance,
          gemini: verified ? 'verified' : fresh && v.status === 'signed_out' && proof.identity?.gemini === 'out' ? 'signed_out' : 'unknown',
          account: verified ? a : null, checkedAt: v.checkedAt, expiresAt: v.expiresAt, reason: v.reason,
          observedAt, evidenceSeq: e.seq, operationId: value.id }
        verifications.set(key, row)
        verificationHistory.push({ key, row })
      }
    }
  }
  return { inventory, inspections, verifications, verificationHistory }
}

export function browserPatrolEvidence(input: CompletionCheck, events: any[]) {
  if (input.profileId !== 'browser-manager' || input.task.design?.evidenceContract !== 'browser-patrol-v1') return
  const { inventory, inspections, verifications } = collectBrowserEvidence(input, events)
  if (!inventory) return { failure: '巡查缺少本会话真实 browser_fleet_inventory 回执；不能用模型清单交卷。' }
  const items: any[] = [], nodes: any[] = []
  for (const node of inventory.nodes) {
    nodes.push({ nodeId: node.nodeId, reachable: node.reachable, readAuthorized: node.readAuthorized, observedInstances: node.browsers.length })
    for (const browser of node.browsers) {
      const check = inspections.get(node.ip), snapshot = check?.browsers.find((b: any) => b.instance === browser.instance)
      const receipt = verifications.get(`${node.ip}:${browser.instance}`)
      const actual = receipt && (!snapshot?.checkedAt || Date.parse(receipt.checkedAt) >= Date.parse(snapshot.checkedAt)) ? receipt : snapshot
      const observedAt = actual === receipt ? receipt?.observedAt : check?.observedAt
      const read = node.readAuthorized === true && node.reachable === true
      const fresh = actual && Date.parse(actual.checkedAt) <= Date.parse(observedAt) && Date.parse(actual.expiresAt) > Date.parse(observedAt)
      const state = !read ? 'skipped' : fresh && actual.gemini === 'verified' && actual.account?.fingerprint ? 'verified'
        : fresh && actual.gemini === 'signed_out' ? (browser.loginAuthorized ? 'signed_out' : 'skipped') : 'unknown'
      items.push({ ip: node.ip, instance: browser.instance, state,
        reason: !read ? 'read-not-authorized-or-unreachable' : !actual ? 'missing-inspection' : state === 'skipped' ? 'signed-out-without-login-grant' : actual.reason,
        checkedAt: actual?.checkedAt ?? null, observedAt: observedAt ?? null,
        fingerprint: state === 'verified' ? actual.account.fingerprint : null,
        evidenceSeq: actual === receipt ? receipt?.evidenceSeq : check?.evidenceSeq ?? inventory.evidenceSeq,
        operationId: actual === receipt ? receipt?.operationId : undefined })
    }
  }
  const counts = { total: items.length, verified: items.filter(x => x.state === 'verified').length,
    unknown: items.filter(x => x.state === 'unknown').length, signedOut: items.filter(x => x.state === 'signed_out').length,
    skipped: items.filter(x => x.state === 'skipped').length }
  const summary = `宿主工具证据汇总：${counts.total} 个浏览器，${counts.verified} 个在检查时已验证，${counts.unknown} 个无法确认，${counts.signedOut} 个授权但未登录，${counts.skipped} 个因范围/权限跳过。${counts.total > 0 && counts.verified === counts.total ? '本次观测到的所有实例均在检查时通过登录验证。' : '尚未达到全部现存浏览器登录目标。'}没有列出的浏览器不代表未安装。`
  const detail = [...items.map(i => `${i.ip}/browser-${i.instance}: ${i.state} (${i.reason || 'fresh-proof'}; event ${i.evidenceSeq}; checkedAt ${i.checkedAt || 'missing'})`),
    ...nodes.filter(n => n.observedInstances === 0).map(n => `${n.nodeId}: reachable=${n.reachable}; 0 observed instances (not proof of absence)`)].join('\n')
  return { counts, items, nodes, summary, metadata: { browserPatrol: { contract: 'browser-patrol-v1', counts, items, nodes } },
    failure: !counts.total || counts.unknown || counts.signedOut || counts.skipped ? `${summary}\n${detail}\n巡查证据不完整，不能绿色交卷。补登录终态后须有真实 inspect 或本会话 verify/provision status 验证回执；未知先真实 verify，不能直接复制。其余独立目标收口后才报告具体未达标原因，不要求用户重复授予已有权限。` : undefined }
}
