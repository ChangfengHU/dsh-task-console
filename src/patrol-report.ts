/** Presentation of persisted patrol facts; never refreshes or re-judges a historical run. */
export function patrolItemView(row: any) {
  const freshness = row.freshness ?? (row.reason === 'not-currently-verified' ? 'expired' : row.accepted ? 'fresh' : 'unknown')
  const recordedState = ({ verified: '检查时已登录', signed_out: '检查时未登录', unknown: '登录状态未知' } as Record<string, string>)[row.state] ?? '尚无检查结果'
  const state = row.verificationFailure ? `后续复验未完成 · 上次${recordedState}` : recordedState
  const reasons: Record<string, [string, string, string]> = {
    'read-not-authorized': ['scope', '未获读取授权', '保留未覆盖项，不操作浏览器'],
    unreachable: ['scope', '节点不可达', '单列覆盖缺口，不当作浏览器未登录'],
    'not-currently-verified': ['refresh', '当时证据已过期', '待只读复验；过期不等于登录失效'],
    'signed-out': ['signed_out', '检查确认未登录', '新鲜未登录证据与既有权限齐备后，才可补登录'],
    'verification-unknown': ['unknown', '后续检查无法确认登录', '有界只读复验，不能直接复制或重建'],
    'verification-operation-incomplete': ['unknown', '复验操作未完成', '保留忙碌/失败原因；不得用旧成功回执冒充本次复验'],
    'missing-independent-verification': ['missing', '缺少有效独立检查', '由评估者独立验证，不复用执行者的自评'],
    'independent-recheck-required': ['missing', '后续变化尚未独立复验', '由评估者复验最新状态和账号'],
    'observation-window-pending-or-failed': ['stability', '修复后稳定性尚未通过', '保留原采样数与观察时长要求'],
  }
  if (row.accepted) return { kind: 'passed', state, freshness, verdict: row.observation ? '本轮稳定性验收通过' : '本轮检查通过',
    reason: freshness === 'expired' ? '检查事实保留，实时证据待刷新' : '已有本轮独立检查证据',
    next: freshness === 'expired' ? '无需因过期修复；下轮巡查刷新实时状态' : '健康登录复用，不重复复制' }
  const [kind, reason, next] = reasons[row.reason] ?? (row.state === 'signed_out' ? reasons['signed-out'] : ['unknown', '证据不足，尚不能验收', '根据真实工具回执继续核查'])
  return { kind, state, freshness, verdict: kind === 'refresh' ? '待复验（非登录失败）' : reason, reason, next }
}

export function patrolReportSummary(items: any[], uncovered: any[]) {
  const counts = { total: items.length, passed: 0, refresh: 0, signedOut: 0, unknown: 0, missing: 0, stability: 0, scope: 0, uncovered: uncovered.length }
  for (const row of items) {
    const view = patrolItemView(row)
    if (row.accepted) counts.passed++
    if (view.freshness === 'expired') counts.refresh++
    if (view.kind === 'signed_out') counts.signedOut++
    if (view.kind === 'unknown') counts.unknown++
    if (view.kind === 'missing') counts.missing++
    if (view.kind === 'stability') counts.stability++
    if (view.kind === 'scope') counts.scope++
  }
  const parts = [`${counts.total} 个浏览器：${counts.passed} 个本轮已验收`,
    counts.signedOut && `${counts.signedOut} 个检查时未登录`, counts.unknown && `${counts.unknown} 个登录状态未知`,
    counts.missing && `${counts.missing} 个待独立复验`, counts.stability && `${counts.stability} 个稳定性待验`,
    counts.scope && `${counts.scope} 个无法检查`, counts.refresh && `${counts.refresh} 个证据待刷新（不等于未登录）`,
    counts.uncovered && `${counts.uncovered} 个节点未覆盖`].filter(Boolean)
  return { counts, summary: parts.join('；') + '。' }
}
