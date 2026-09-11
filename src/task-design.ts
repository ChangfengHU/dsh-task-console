/** An explicit, reviewable Agent decision contract; not executable JavaScript. */
export interface TaskDesign {
  evidenceContract?: 'browser-patrol-v1' | 'browser-patrol-v2'
  browserPatrol?: { scope: 'fleet-existing-authorized'; actions: ('provision' | 'resume')[]; observationMinutes: number; minSamples: number }
  notifications?: { channel: 'wecom'; chatIds: string[]; agentId?: string }
  proxy?: { agentId: string; lineId: string; maxAttempts: number }
  scope: string
  branches: { id: string; when: string; action: string; evidence: string }[]
  coordination: string
  failurePolicy: { isolateItems: boolean; maxAttempts: number; stopConditions: string[] }
  acceptance: string[]
}

export function validateDesign(value: unknown): TaskDesign {
  const d = value as TaskDesign
  if (d && Object.keys(d).some(key => !['evidenceContract','browserPatrol','notifications','proxy','scope','branches','coordination','failurePolicy','acceptance'].includes(key)))
    throw new Error('计划包含当前插件不支持的设计字段；不能将未实现的代理支线或跨任务 Gate 当成可执行能力')
  const text = (v: unknown, name: string) => {
    if (typeof v !== 'string' || !v.trim() || v.length > 4000) throw new Error(`计划 ${name} 必须是非空文本（最多4000字符）`)
    return v.trim()
  }
  const list = (v: unknown, name: string) => {
    if (!Array.isArray(v) || !v.length || v.length > 16) throw new Error(`计划 ${name} 需要1至16项`)
    return v.map(x => text(x, name))
  }
  if (!d || !Array.isArray(d.branches) || !d.branches.length || d.branches.length > 16) throw new Error('计划 design.branches 需要1至16个有证据要求的条件分支')
  if (d.evidenceContract !== undefined && !['browser-patrol-v1', 'browser-patrol-v2'].includes(d.evidenceContract)) throw new Error('未知 evidenceContract')
  let browserPatrol: TaskDesign['browserPatrol']
  let notifications: TaskDesign['notifications']
  let proxy: TaskDesign['proxy']
  if (d.proxy !== undefined) {
    const p = d.proxy
    if (d.evidenceContract !== 'browser-patrol-v2' || !p || Object.keys(p).some(k=>!['agentId','lineId','maxAttempts'].includes(k)) ||
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(p.agentId) || !/^line-[a-zA-Z0-9_-]{1,48}$/.test(p.lineId) || !Number.isInteger(p.maxAttempts) || p.maxAttempts<1 || p.maxAttempts>3)
      throw new Error('代理协作需要明确的独立 agentId、批准线路 lineId 和1至3次修复预算')
    proxy = { agentId:p.agentId,lineId:p.lineId,maxAttempts:p.maxAttempts }
  }
  if (d.notifications !== undefined) {
    const n = d.notifications
    if (d.evidenceContract !== 'browser-patrol-v2' || n.channel !== 'wecom' || !Array.isArray(n.chatIds) || !n.chatIds.length || n.chatIds.length > 5 || n.chatIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9@_.:-]{1,200}$/.test(id))) throw new Error('通知需要明确的企业微信群 chatIds；不能默认发送给全部群')
    if (n.agentId !== undefined && (typeof n.agentId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(n.agentId))) throw new Error('通知员 agentId 不合法')
    notifications = { channel: 'wecom', chatIds: [...new Set(n.chatIds)], ...(n.agentId ? { agentId: n.agentId } : {}) }
  }
  if (d.evidenceContract === 'browser-patrol-v2') {
    const p = d.browserPatrol
    if (!p || p.scope !== 'fleet-existing-authorized' || !Array.isArray(p.actions) || p.actions.some(a => !['provision', 'resume'].includes(a)) ||
        !Number.isInteger(p.observationMinutes) || p.observationMinutes < 20 || p.observationMinutes > 60 || !Number.isInteger(p.minSamples) || p.minSamples < 4 || p.minSamples > 12)
      throw new Error('browser-patrol-v2 需要现存授权范围、provision/resume 动作、20至60分钟且至少4次独立采样；不授权删除重建')
    browserPatrol = { scope: p.scope, actions: [...new Set(p.actions)], observationMinutes: p.observationMinutes, minSamples: p.minSamples }
  }
  const branches = d.branches.map(b => {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(b?.id)) throw new Error('分支 id 需使用短英文编码')
    return { id: b.id, when: text(b.when, 'when'), action: text(b.action, 'action'), evidence: text(b.evidence, 'evidence') }
  })
  if (new Set(branches.map(b => b.id)).size !== branches.length) throw new Error('分支 id 不能重复')
  if (typeof d.failurePolicy?.isolateItems !== 'boolean' || !Number.isInteger(d.failurePolicy.maxAttempts) || d.failurePolicy.maxAttempts < 1 || d.failurePolicy.maxAttempts > 3)
    throw new Error('failurePolicy 需要 isolateItems 和 1至3 的 maxAttempts；它不授权重复有副作用的操作')
  return { ...(d.evidenceContract ? { evidenceContract: d.evidenceContract } : {}), ...(browserPatrol ? { browserPatrol } : {}), ...(notifications ? { notifications } : {}), ...(proxy ? {proxy} : {}), scope: text(d.scope, 'scope'), branches, coordination: text(d.coordination, 'coordination'),
    failurePolicy: { isolateItems: d.failurePolicy.isolateItems, maxAttempts: d.failurePolicy.maxAttempts, stopConditions: list(d.failurePolicy.stopConditions, 'stopConditions') },
    acceptance: list(d.acceptance, 'acceptance') }
}

/** Three business roles stay intact; the optional notifier is a reviewed side participant. */
export function taskAgentIds(task: { participants: { agentId: string }[]; design?: TaskDesign }): string[] {
  return [...new Set([...task.participants.map(p => p.agentId), ...(task.design?.notifications?.agentId ? [task.design.notifications.agentId] : []), ...(task.design?.proxy ? [task.design.proxy.agentId] : [])])]
}
