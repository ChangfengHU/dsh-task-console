/** Deterministic evidence integrity gate. Passing is NOT human aesthetic approval. */
export const DEFAULT_DIMENSIONS = Object.freeze(['technical', 'editorial', 'identity', 'composition', 'motion', 'intelligibility', 'performance', 'mix', 'captions', 'ending', 'reference', 'source_records']);
const HASH = /^[a-f0-9]{64}$/i;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const hash = x => typeof x === 'string' && HASH.test(x);
const nonempty = x => typeof x === 'string' && x.trim().length > 0;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const sameHash = (a,b) => hash(a) && hash(b) && a.toLowerCase() === b.toLowerCase();

export function validateStudioPolicy(value) {
  const issues = [];
  const input = object(value) ? value : {};
  const policy = {width:1080, height:1920, fps:30, durationMin:90, durationMax:110, maxRepairRounds:3, ...input,
    requiredDimensions: input.requiredDimensions ?? [...DEFAULT_DIMENSIONS]};
  if (!object(value)) issues.push('policy: expected object');
  if (!nonempty(policy.characterId)) issues.push('policy.characterId: required');
  if (!hash(policy.referenceSha256)) issues.push('policy.referenceSha256: expected SHA-256');
  for (const key of ['width','height','fps']) if (!finite(policy[key]) || policy[key] <= 0) issues.push(`policy.${key}: expected positive number`);
  if (!Number.isInteger(policy.width) || !Number.isInteger(policy.height)) issues.push('policy: dimensions must be integers');
  if (!finite(policy.durationMin) || !finite(policy.durationMax) || policy.durationMin <= 0 || policy.durationMax < policy.durationMin) issues.push('policy: invalid duration bounds');
  if (!Number.isInteger(policy.maxRepairRounds) || policy.maxRepairRounds < 0 || policy.maxRepairRounds > 3) issues.push('policy.maxRepairRounds: expected integer 0..3');
  if (policy.generationLimits !== undefined) {
    const limits=policy.generationLimits;
    if (!object(limits) || Object.keys(limits).sort().join(',') !== 'imageCalls,voiceSegments' ||
      !Number.isInteger(limits.imageCalls) || limits.imageCalls<0 || limits.imageCalls>6 ||
      !Number.isInteger(limits.voiceSegments) || limits.voiceSegments<0 || limits.voiceSegments>80)
      issues.push('policy.generationLimits: expected bounded imageCalls 0..6 and voiceSegments 0..80');
  }
  const dims = policy.requiredDimensions;
  if (!Array.isArray(dims) || dims.some(d => !nonempty(d)) || new Set(dims).size !== dims.length || DEFAULT_DIMENSIONS.some(d => !dims.includes(d))) issues.push('policy.requiredDimensions: must include every baseline dimension once');
  return {ok:issues.length === 0, issues, policy};
}

// Accept [start,end] or {start,end}; all times in seconds in the final candidate.
function validRanges(ranges, duration) {
  if (!Array.isArray(ranges) || !ranges.length) return false;
  return ranges.every(r => {
    const [start,end] = Array.isArray(r) ? r : object(r) ? [r.start,r.end] : [];
    return (!Array.isArray(r) || r.length === 2) && finite(start) && finite(end) && start >= 0 && end > start && end <= duration + 0.001;
  });
}
function pair(range) { return Array.isArray(range) ? range : [range.start,range.end]; }
function covered(range, receipts) {
  let [cursor,end] = pair(range);
  const spans = receipts.flatMap(r => r.ranges.map(pair)).sort((a,b) => a[0]-b[0]);
  for (const [a,b] of spans) {
    if (a > cursor + 0.001) break;
    if (b > cursor) cursor = b;
    if (cursor >= end - 0.001) return true;
  }
  return false;
}
const kinds = {technical:['probe'], motion:['frames'], performance:['audio'], mix:['audio'], intelligibility:['audio'],
  identity:['frames'], composition:['frames'], captions:['frames'], ending:['frames','audio'], editorial:['frames'], reference:['frames'], source_records:['source']};

export function evaluateStudioReview({policy:input, candidate, review, producerSessionId, reviewerSessionId, receipts, budget, interventions=[]} = {}) {
  const parsed = validateStudioPolicy(input);
  const {policy} = parsed;
  const issues = [...parsed.issues];
  const fail = text => issues.push(text);
  candidate = object(candidate) ? candidate : {};
  review = object(review) ? review : {};
  if (!nonempty(producerSessionId) || !nonempty(reviewerSessionId) || producerSessionId === reviewerSessionId || reviewerSessionId === 'host') fail('sessions: distinct producer and reviewer required');
  if (review.reviewerSessionId !== reviewerSessionId) fail('review: reviewer session mismatch');
  for (const field of ['sha256','manifestSha256']) if (!hash(candidate[field])) fail(`candidate.${field}: expected SHA-256`);
  if (!Number.isInteger(candidate.revision) || candidate.revision < 1) fail('candidate.revision: expected positive integer');
  if (!sameHash(candidate.referenceSha256,policy.referenceSha256)) fail('candidate: reference hash mismatch');
  if (!finite(candidate.durationSeconds) || candidate.durationSeconds < policy.durationMin || candidate.durationSeconds > policy.durationMax) fail('candidate: duration outside policy');
  for (const field of ['width','height','fps']) if (candidate[field] !== policy[field]) fail(`candidate: ${field} mismatch`);
  if (!sameHash(review.candidateSha256,candidate.sha256) || review.revision !== candidate.revision) fail('review: stale or mismatched candidate');
  if (!sameHash(review.referenceSha256,policy.referenceSha256)) fail('review: reference hash mismatch');
  if (!Array.isArray(interventions) || interventions.length) fail('autonomy: manual interventions or missing intervention ledger');
  if (!object(budget) || !Number.isInteger(budget.repairRounds) || budget.repairRounds < 0 || budget.repairRounds > policy.maxRepairRounds) fail('budget: invalid or exceeded repair rounds');
  if (budget?.exceeded === true) fail('budget: exceeded');
  if (budget?.maxRepairRounds !== undefined && budget.maxRepairRounds !== policy.maxRepairRounds) fail('budget: repair limit differs from policy');
  if (budget?.used !== undefined || budget?.limits !== undefined) {
    if (!object(budget.used) || !object(budget.limits)) fail('budget: used and limits must be objects');
    else for (const key of new Set([...Object.keys(budget.used),...Object.keys(budget.limits)])) {
      if (!finite(budget.used[key]) || !finite(budget.limits[key]) || budget.used[key] < 0 || budget.limits[key] < 0 || budget.used[key] > budget.limits[key]) fail(`budget: invalid or exceeded ${key}`);
    }
  }
  const receiptMap = new Map();
  if (!Array.isArray(receipts)) fail('receipts: host ledger required');
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    if (!object(receipt) || !nonempty(receipt.id) || receiptMap.has(receipt.id)) { fail('receipts: malformed or duplicate ID'); continue; }
    receiptMap.set(receipt.id,receipt);
  }
  const checks = Array.isArray(review.checks) ? review.checks : [];
  if (!Array.isArray(review.checks)) fail('review.checks: required');
  const seen = new Set();
  for (const check of checks) {
    if (!object(check) || !nonempty(check.dimension)) {fail('check: malformed');continue;}
    const dim = check.dimension;
    if (seen.has(dim)) fail(`check.${dim}: duplicate dimension`);
    seen.add(dim);
    if (check.status !== 'pass') fail(`check.${dim}: not passed`);
    if (!nonempty(check.finding)) fail(`check.${dim}: missing finding`);
    const rangeOK = validRanges(check.ranges,candidate.durationSeconds);
    if (!rangeOK) fail(`check.${dim}: invalid ranges`);
    const ids = check.evidenceReceiptIds;
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) {fail(`check.${dim}: missing or duplicate evidence receipts`);continue;}
    const valid = [];
    for (const id of ids) {
      const r = receiptMap.get(id);
      if (!r) { fail(`check.${dim}: unknown receipt ${id}`);continue; }
      if (r.sessionId !== reviewerSessionId && !(dim === 'technical' && r.kind === 'probe' && r.sessionId === 'host')) { fail(`check.${dim}: receipt not acquired by reviewer`);continue; }
      if (!sameHash(r.candidateSha256,candidate.sha256) || !hash(r.sha256)) {fail(`check.${dim}: stale or invalid receipt hash`);continue;}
      if (!['frames','audio','probe','source'].includes(r.kind) || !validRanges(r.ranges,candidate.durationSeconds)) {fail(`check.${dim}: invalid receipt kind or ranges`);continue;}
      valid.push(r);
    }
    const required = kinds[dim] ?? ['frames'];
    for (const kind of required) {
      const matching = valid.filter(r => r.kind === kind);
      if (!matching.length) fail(`check.${dim}: requires ${kind} evidence`);
      else if (rangeOK && !check.ranges.every(range => covered(range,matching))) fail(`check.${dim}: ranges exceed ${kind} evidence coverage`);
    }
  }
  for (const dim of Array.isArray(policy.requiredDimensions) ? policy.requiredDimensions : DEFAULT_DIMENSIONS) if (!seen.has(dim)) fail(`check.${dim}: missing`);
  if (!Array.isArray(review.issues)) fail('review.issues: required explicit list');
  const issueIds = new Set();
  for (const issue of Array.isArray(review.issues) ? review.issues : []) {
    if (!object(issue) || !nonempty(issue.id) || issueIds.has(issue.id) || !['blocker','major','minor','info'].includes(issue.severity) || !['open','pending','resolved','verified'].includes(issue.status)) {fail('review.issues: malformed or duplicate issue');continue;}
    issueIds.add(issue.id);
    if (issue.status === 'pending' || (['blocker','major'].includes(issue.severity) && !['resolved','verified'].includes(issue.status))) fail(`issue.${issue.id}: unresolved ${issue.severity}`);
  }
  return {ok:issues.length === 0, issues, label:issues.length === 0 ? 'machine_assessed_candidate' : 'candidate'};
}
