import type { CompletionCheck } from './runner.ts'

/** Host-owned native tool events, never model-authored summary/metadata. */
export function browserPatrolEvidence(input: CompletionCheck, events: any[]) {
  if (input.profileId !== 'browser-manager' || input.task.design?.evidenceContract !== 'browser-patrol-v1') return
  const calls = new Map<string, { name: string; args: any; seq: number }>()
  const inspections = new Map<string, any>()
  let inventory: any
  for (const e of events) {
    if (e.type === 'tool/call') {
      const name = /^mcp__fleet-browser(?:-browser-manager)?__(browser_fleet_inventory|browser_inspect)$/.exec(e.data.name)?.[1]
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
    }
  }
  if (!inventory) return { failure: '巡查缺少本会话真实 browser_fleet_inventory 回执；不能用模型清单交卷。' }
  const items: any[] = [], nodes: any[] = []
  for (const node of inventory.nodes) {
    nodes.push({ nodeId: node.nodeId, reachable: node.reachable, readAuthorized: node.readAuthorized, observedInstances: node.browsers.length })
    for (const browser of node.browsers) {
      const check = inspections.get(node.ip), actual = check?.browsers.find((b: any) => b.instance === browser.instance)
      const read = node.readAuthorized === true && node.reachable === true
      const fresh = actual && Date.parse(actual.checkedAt) <= Date.parse(check.observedAt) && Date.parse(actual.expiresAt) > Date.parse(check.observedAt)
      const state = !read ? 'skipped' : fresh && actual.gemini === 'verified' && actual.account?.fingerprint ? 'verified'
        : fresh && actual.gemini === 'signed_out' ? (browser.loginAuthorized ? 'signed_out' : 'skipped') : 'unknown'
      items.push({ ip: node.ip, instance: browser.instance, state,
        reason: !read ? 'read-not-authorized-or-unreachable' : !actual ? 'missing-inspection' : state === 'skipped' ? 'signed-out-without-login-grant' : actual.reason,
        checkedAt: actual?.checkedAt ?? null, observedAt: check?.observedAt ?? null,
        fingerprint: state === 'verified' ? actual.account.fingerprint : null,
        evidenceSeq: check?.evidenceSeq ?? inventory.evidenceSeq })
    }
  }
  const counts = { total: items.length, verified: items.filter(x => x.state === 'verified').length,
    unknown: items.filter(x => x.state === 'unknown').length, signedOut: items.filter(x => x.state === 'signed_out').length,
    skipped: items.filter(x => x.state === 'skipped').length }
  const summary = `宿主工具证据汇总：${counts.total} 个浏览器，${counts.verified} 个在检查时已验证，${counts.unknown} 个无法确认，${counts.signedOut} 个授权但未登录，${counts.skipped} 个因范围/权限跳过。没有列出的浏览器不代表未安装；不是所有节点均已登录。`
  const detail = [...items.map(i => `${i.ip}/browser-${i.instance}: ${i.state} (${i.reason || 'fresh-proof'}; event ${i.evidenceSeq}; checkedAt ${i.checkedAt || 'missing'})`),
    ...nodes.filter(n => n.observedInstances === 0).map(n => `${n.nodeId}: reachable=${n.reachable}; 0 observed instances (not proof of absence)`)].join('\n')
  return { counts, items, nodes, summary, metadata: { browserPatrol: { contract: 'browser-patrol-v1', counts, items, nodes } },
    failure: counts.unknown || counts.signedOut ? `${summary}\n${detail}\n巡查证据不完整，不能绿色交卷。补登录终态后须只读 inspect 留下实际结果；未知不能复制。其余独立目标收口后 task_block(kind=capability)，不要求用户重复授予已有权限。` : undefined }
}
