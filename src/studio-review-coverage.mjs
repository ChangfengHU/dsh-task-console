/** Opt-in, host-derived observation targets. Coverage is not aesthetic approval.
 * The host must load verified registered/frozen source bytes, never a reviewer
 * supplied target list, and bind this plan to the actual rendered candidate.
 * Like the other Studio ledgers, this is not a same-UID OS security boundary. */
// This module is shared by host and browser policy/review code. Keep hashing
// synchronous without importing node:crypto or dropping browser-side checks.
const SHA256_K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotate = (n,bits) => (n>>>bits)|(n<<(32-bits));
/** Portable SHA-256 integrity digest, not a signature/authentication boundary. */
export function studioReviewCoverageSha256(input) {
  const bytes=typeof input==='string'?new TextEncoder().encode(input):input;
  if (!(bytes instanceof Uint8Array)) throw Error('studio-review-coverage-sha256-bytes-required');
  const padded=new Uint8Array(Math.ceil((bytes.length+9)/64)*64);
  padded.set(bytes);padded[bytes.length]=0x80;
  const view=new DataView(padded.buffer),bits=bytes.length*8;
  view.setUint32(padded.length-8,Math.floor(bits/0x100000000),false);
  view.setUint32(padded.length-4,bits>>>0,false);
  const state=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const words=new Uint32Array(64);
  for (let offset=0;offset<padded.length;offset+=64) {
    for (let i=0;i<16;i++) words[i]=view.getUint32(offset+i*4,false);
    for (let i=16;i<64;i++) {
      const a=words[i-15],b=words[i-2];
      words[i]=(words[i-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+words[i-7]+(rotate(b,17)^rotate(b,19)^(b>>>10)))>>>0;
    }
    let [a,b,c,d,e,f,g,h]=state;
    for (let i=0;i<64;i++) {
      const t1=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+SHA256_K[i]+words[i])>>>0;
      const t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    for (const [i,value] of [a,b,c,d,e,f,g,h].entries()) state[i]=(state[i]+value)>>>0;
  }
  return [...state].map(n=>n.toString(16).padStart(8,'0')).join('');
}

export const STUDIO_REVIEW_COVERAGE = 'scene-action-v1';
const SCHEMA = 'studio-review-coverage-v1';
const HASH = /^[a-f0-9]{64}$/i;
const EPSILON = 0.001;
const DURATION_TOLERANCE = 0.04; // One 30fps output frame, not permission to trim a scene.
const MAX_TARGETS = 2000;
const MAX_WINDOWS = 4000;
const FRAME_DIMENSIONS = ['editorial','identity','composition','motion','captions','reference'];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const text = v => typeof v === 'string' && v.trim().length > 0;
const hash = v => typeof v === 'string' && HASH.test(v);
const sameHash = (a,b) => hash(a) && hash(b) && a.toLowerCase() === b.toLowerCase();
const digest = studioReviewCoverageSha256;
const fail = reason => {throw Error('studio-review-coverage-invalid: '+reason);};

function document(input,field,maxBytes) {
  if (!object(input) || !(input.bytes instanceof Uint8Array) || !input.bytes.length || input.bytes.length > maxBytes || !hash(input.sha256)) fail(field+': bounded original JSON bytes and SHA256 required');
  if (!sameHash(digest(input.bytes),input.sha256)) fail(field+': original document hash mismatch');
  let value;
  try {value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(input.bytes));} catch {fail(field+': invalid UTF-8 JSON');}
  if (!object(value)) fail(field+': JSON object required');
  return value;
}
function dialogue(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 80) fail('executionBoard.script: complete frozen dialogue required');
  const ids=new Set();
  return lines.map(line=>{
    if (!object(line) || Object.keys(line).sort().join(',') !== 'id,text' || !text(line.id) || !text(line.text) || ids.has(line.id)) fail('executionBoard.script: unique exact {id,text} lines required');
    ids.add(line.id);return {id:line.id,text:line.text};
  });
}
const pair = r => Array.isArray(r) ? r : object(r) ? [r.start,r.end] : [];
function validRanges(ranges,duration) {
  return Array.isArray(ranges) && ranges.length > 0 && ranges.every(r=>{
    const [a,b]=pair(r);
    return (!Array.isArray(r) || r.length===2) && finite(a) && finite(b) && a>=0 && b>a && b<=duration+EPSILON;
  });
}
function covered(range,spans) {
  let [cursor,end]=range;
  for (const [a,b] of [...spans].sort((x,y)=>x[0]-y[0])) {
    // An unrelated past/future span cannot satisfy a tiny target merely because
    // its initial cursor is already within EPSILON of the target end.
    if (b<=cursor || a>=end) continue;
    if (a>cursor+EPSILON) break;
    cursor=Math.max(cursor,b);
    if (cursor>=end-EPSILON) return true;
  }
  return false;
}
function chunks(start,end) {
  const values=[];
  for (let cursor=start;cursor<end-EPSILON;cursor+=2) values.push([cursor,Math.min(cursor+2,end)]);
  // The compiler permits sub-millisecond floating-point differences. A real,
  // very short motion still gets a target rather than silently disappearing.
  return values.length ? values : [[start,end]];
}
function planBody(plan) {
  return {schema:plan.schema,contract:plan.contract,storyboardSha256:plan.storyboardSha256,
    executionBoardSha256:plan.executionBoardSha256,scriptSha256:plan.scriptSha256,
    durationSeconds:plan.durationSeconds,originalSceneIds:plan.originalSceneIds,
    sceneMappings:plan.sceneMappings,targets:plan.targets};
}

/**
 * @param {{storyboard:{bytes:Uint8Array,sha256:string}, executionBoard:{bytes:Uint8Array,sha256:string}, scriptSha256:string, sceneMappings?:{sceneIndex:number,originalSceneId:string}[]}} input
 * @returns {object} Unbound serializable host plan. sceneMappings must come from
 * the verified execution sidecar; absent mappings require exact original IDs.
 */
export function buildStudioReviewCoveragePlan(input) {
  const board=document(input?.storyboard,'storyboard',8*1024*1024);
  const execution=document(input?.executionBoard,'executionBoard',1024*1024);
  if (!hash(input.scriptSha256)) fail('scriptSha256: host frozen script SHA256 required');
  const lines=dialogue(execution.script);
  if (!sameHash(digest(JSON.stringify(lines)),input.scriptSha256) || !sameHash(board.scriptSha256??board.script?.sha256,input.scriptSha256)) fail('scriptSha256: storyboard/execution must bind the current frozen dialogue');
  const declared=Array.isArray(board.script)?board.script:board.script?.lines;
  if (declared!==undefined && JSON.stringify(dialogue(declared))!==JSON.stringify(lines)) fail('storyboard.script: differs from frozen execution dialogue');
  if (execution.schema!=='studio-board-v1' || !finite(execution.duration) || execution.duration<=0 || execution.duration>7200) fail('executionBoard: finite bounded studio-board-v1 timeline required');
  if (!Array.isArray(board.scenes) || !board.scenes.length || board.scenes.length>60) fail('storyboard.scenes: complete bounded original scenes required');
  const originalSceneIds=board.scenes.map(s=>s?.id),originals=new Set(originalSceneIds);
  if (originalSceneIds.some(id=>!text(id)) || originals.size!==originalSceneIds.length) fail('storyboard.scenes: stable unique original IDs required');
  if (!Array.isArray(execution.scenes) || !execution.scenes.length || execution.scenes.length>120) fail('executionBoard.scenes: complete bounded execution scenes required');
  let mappings;
  if (input.sceneMappings===undefined) mappings=execution.scenes.map((s,sceneIndex)=>({sceneIndex,originalSceneId:s?.id}));
  else {
    if (!Array.isArray(input.sceneMappings) || input.sceneMappings.length!==execution.scenes.length) fail('sceneMappings: exactly one original binding for every execution scene required');
    mappings=input.sceneMappings.map(m=>({sceneIndex:m?.sceneIndex,originalSceneId:m?.originalSceneId}));
  }
  const mapped=new Map();
  for (const m of mappings) {
    if (!Number.isInteger(m.sceneIndex) || m.sceneIndex<0 || m.sceneIndex>=execution.scenes.length || mapped.has(m.sceneIndex) || !originals.has(m.originalSceneId)) fail('sceneMappings: unknown, duplicate or missing original scene binding');
    mapped.set(m.sceneIndex,m.originalSceneId);
  }
  if (originalSceneIds.some(id=>![...mapped.values()].includes(id))) fail('sceneMappings: an original storyboard scene was omitted');
  mappings=[...mapped].sort((a,b)=>a[0]-b[0]).map(([sceneIndex,originalSceneId])=>({sceneIndex,originalSceneId}));
  const targets=[];let cursor=0,totalWindows=0;
  const add=target=>{
    totalWindows+=target.ranges.length;
    if (targets.length>=MAX_TARGETS || totalWindows>MAX_WINDOWS) fail('coverage target bound exceeded; preserve the source actions and report the unsupported review workload, do not truncate the target list');
    targets.push(target);
  };
  execution.scenes.forEach((scene,si)=>{
    if (!object(scene) || !finite(scene.start) || !finite(scene.duration) || scene.duration<0.1 || Math.abs(scene.start-cursor)>EPSILON || scene.start+scene.duration>execution.duration+EPSILON || !Array.isArray(scene.layers)) fail('executionBoard.scenes: invalid/gapped/overlapping timeline');
    const start=scene.start,end=Math.min(start+scene.duration,execution.duration),originalSceneId=mapped.get(si);
    const length=Math.min(2,end-start),windows=[
      [start,start+length],
      [(start+end-length)/2,(start+end+length)/2],
      [end-length,end],
    ].filter((r,i,all)=>all.findIndex(x=>Math.abs(x[0]-r[0])<EPSILON && Math.abs(x[1]-r[1])<EPSILON)===i);
    windows.forEach((range,i)=>add({id:`scene:${si}:sample:${i}`,kind:'scene',sceneIndex:si,originalSceneId,
      sourcePath:`scenes[${si}]`,dimensions:[...FRAME_DIMENSIONS],evidenceKinds:['frames'],ranges:[range]}));
    if (si>0) {
      const previous=execution.scenes[si-1];
      add({id:`transition:${si-1}:${si}`,kind:'transition',sceneIndex:si,originalSceneId,
        previousOriginalSceneId:mapped.get(si-1),sourcePath:`scenes[${si}].start`,
        dimensions:['editorial','motion'],evidenceKinds:['frames'],
        ranges:[[Math.max(previous.start,start-1),Math.min(end,start+1)]]});
    }
    scene.layers.forEach((layer,li)=>{
      if (!object(layer) || (layer.motion!==undefined && !Array.isArray(layer.motion))) fail('executionBoard.layers: invalid motion array');
      if ((layer.motion?.length??0)>200) fail('executionBoard.layers: bounded complete motion array required');
      let last=0;
      (layer.motion??[]).forEach((motion,mi)=>{
        if (!object(motion) || !finite(motion.at) || !finite(motion.duration) || motion.at<0 || motion.duration<=0 || motion.at>=scene.duration || motion.at<last-EPSILON || motion.at+motion.duration>scene.duration+EPSILON) fail('executionBoard.motion: invalid, overlapping or out-of-scene action');
        last=motion.at+motion.duration;
        add({id:`action:${si}:${li}:${mi}`,kind:'action',sceneIndex:si,originalSceneId,layerIndex:li,motionIndex:mi,
          sourcePath:`scenes[${si}].layers[${li}].motion[${mi}]`,dimensions:['motion'],evidenceKinds:['frames'],
          ranges:chunks(start+motion.at,Math.min(start+motion.at+motion.duration,end))});
      });
    });
    cursor=end;
  });
  if (Math.abs(cursor-execution.duration)>EPSILON) fail('executionBoard.scenes: incomplete final timeline');
  const finalScene=execution.scenes.length-1;
  add({id:'ending',kind:'ending',sceneIndex:finalScene,originalSceneId:mapped.get(finalScene),sourcePath:'duration',
    dimensions:['ending'],evidenceKinds:['frames','audio'],ranges:[[Math.max(0,execution.duration-2),execution.duration]]});
  const body={schema:SCHEMA,contract:STUDIO_REVIEW_COVERAGE,storyboardSha256:input.storyboard.sha256.toLowerCase(),
    executionBoardSha256:input.executionBoard.sha256.toLowerCase(),scriptSha256:input.scriptSha256.toLowerCase(),
    durationSeconds:execution.duration,originalSceneIds,sceneMappings:mappings,targets};
  return {...body,planSha256:digest(JSON.stringify(body)),qualityApproved:false,fullFrameCoverage:false};
}

/** Bind only after the host has verified the actual rendered MP4. No source
 * plan is accepted from the review tool. Metadata revisions get a fresh binding. */
export function bindStudioReviewCoveragePlan(plan,candidate) {
  validatePlan(plan);
  if (!object(candidate) || !hash(candidate.sha256) || !Number.isInteger(candidate.revision) || candidate.revision<1 || !finite(candidate.durationSeconds) || Math.abs(plan.durationSeconds-candidate.durationSeconds)>DURATION_TOLERANCE) fail('candidate: invalid hash/revision or render duration differs from frozen execution');
  return {...plan,candidateSha256:candidate.sha256,revision:candidate.revision};
}

function validatePlan(plan,candidate) {
  if (!object(plan) || plan.schema!==SCHEMA || plan.contract!==STUDIO_REVIEW_COVERAGE || !hash(plan.storyboardSha256) || !hash(plan.executionBoardSha256) || !hash(plan.scriptSha256) || !hash(plan.planSha256)) fail('verified host plan required');
  if (!sameHash(digest(JSON.stringify(planBody(plan))),plan.planSha256)) fail('host plan digest mismatch');
  if (!finite(plan.durationSeconds) || plan.durationSeconds<=0 || !Array.isArray(plan.originalSceneIds) || !plan.originalSceneIds.length || new Set(plan.originalSceneIds).size!==plan.originalSceneIds.length || !Array.isArray(plan.sceneMappings) || !plan.sceneMappings.length || !Array.isArray(plan.targets) || !plan.targets.length || plan.targets.length>MAX_TARGETS) fail('host plan shape invalid');
  const ids=new Set();let windows=0;
  for (const t of plan.targets) {
    windows+=t?.ranges?.length??MAX_WINDOWS+1;
    if (!object(t) || !text(t.id) || ids.has(t.id) || !['scene','action','transition','ending'].includes(t.kind) || !plan.originalSceneIds.includes(t.originalSceneId) || !text(t.sourcePath) || !Array.isArray(t.dimensions) || !t.dimensions.length || t.dimensions.some(d=>!FRAME_DIMENSIONS.includes(d)&&d!=='ending') || !Array.isArray(t.evidenceKinds) || !t.evidenceKinds.length || t.evidenceKinds.some(k=>!['frames','audio'].includes(k)) || !validRanges(t.ranges,plan.durationSeconds) || t.ranges.some(r=>pair(r)[1]-pair(r)[0]>2+EPSILON)) fail('host target shape invalid');
    ids.add(t.id);
  }
  const ending=plan.targets.filter(t=>t.kind==='ending');
  if (windows>MAX_WINDOWS || ending.length!==1 || ending[0].id!=='ending' || JSON.stringify(ending[0].dimensions)!=='["ending"]' || JSON.stringify(ending[0].evidenceKinds)!=='["frames","audio"]' || JSON.stringify(ending[0].ranges)!==JSON.stringify([[Math.max(0,plan.durationSeconds-2),plan.durationSeconds]])) fail('host plan ending or workload invalid');
  if (candidate && (!sameHash(plan.candidateSha256,candidate.sha256) || plan.revision!==candidate.revision || !finite(candidate.durationSeconds) || Math.abs(plan.durationSeconds-candidate.durationSeconds)>DURATION_TOLERANCE)) fail('stale candidate binding or execution duration mismatch');
  return plan;
}
function liveTargets(plan,duration) {
  // Probe durations can differ by one output frame. Ending always means the
  // real candidate tail, never the beginning or just the nominal board end.
  return plan.targets.map(t=>({...t,ranges:t.kind==='ending'?[[Math.max(0,duration-2),duration]]:t.ranges.map(r=>[pair(r)[0],Math.min(pair(r)[1],duration)])}));
}
function currentReceipts(receipts,candidate,session) {
  const rows=Array.isArray(receipts)?receipts:[],counts=new Map();
  for (const r of rows) if (text(r?.id)) counts.set(r.id,(counts.get(r.id)??0)+1);
  return rows.filter(r=>object(r) && text(r.id) && counts.get(r.id)===1 && r.sessionId===session &&
    sameHash(r.candidateSha256,candidate.sha256) && hash(r.sha256) && ['frames','audio'].includes(r.kind) && validRanges(r.ranges,candidate.durationSeconds));
}
function missingRanges(range,spans) {
  // Keep the existing coverage predicate and its boundary tolerance. Scheduling
  // a smaller gap must never turn an unobserved source target into a pass.
  if (covered(range,spans)) return [];
  const [start,end]=range,missing=[];let cursor=start;
  for (const [a,b] of [...spans].sort((x,y)=>x[0]-y[0])) {
    if (b<=cursor) continue;
    if (a>end) break;
    if (a>cursor+EPSILON) missing.push([cursor,Math.min(a,end)]);
    cursor=Math.max(cursor,Math.min(b,end));
    if (cursor>=end-EPSILON) break;
  }
  if (cursor<end-EPSILON) missing.push([cursor,end]);
  // A completely unobserved sub-millisecond action remains a real target.
  // EPSILON tolerates observed boundaries, not the absence of any evidence.
  return missing.length ? missing : [[start,end]];
}
function observationProgress(target,current) {
  const missing=[];
  for (const kind of target.evidenceKinds) {
    const spans=current.filter(r=>r.kind===kind).flatMap(r=>r.ranges.map(pair));
    for (const range of target.ranges) for (const gap of missingRanges(range,spans)) missing.push({kind,range:gap});
  }
  return {...target,observed:missing.length===0,missing};
}
function nextObservationWindow(pending) {
  const kind=pending[0]?.missing[0]?.kind;
  if (!kind) return null;
  // One same-candidate observation can serve several source targets. Merge only
  // the missing intervals of the SAME evidence kind; per-dimension positive
  // checks and their linked receipt coverage are still validated separately.
  const jobs=pending.flatMap(target=>target.missing.filter(m=>m.kind===kind).map(m=>({target,range:m.range}))),merged=[];
  for (const [a,b] of jobs.map(j=>j.range).sort((x,y)=>x[0]-y[0])) {
    const last=merged.at(-1);
    if (last && a<=last[1]) last[1]=Math.max(last[1],b);
    else merged.push([a,b]);
  }
  const [start,limit]=merged[0];let end=Math.min(limit,start+2);
  // The inspection tool has a strict <=2s limit; a floating-point addition can
  // otherwise produce end-start=2.000000000000001 at fractional action starts.
  if (end-start>2) end-=Number.EPSILON*Math.max(1,Math.abs(end));
  const target=jobs.find(j=>j.range[0]<=start && j.range[1]>start).target;
  return {targetId:target.id,kind,start,end,originalSceneId:target.originalSceneId,sourcePath:target.sourcePath};
}

/** Deterministic review predicate. The existing evidence gate still validates
 * every report receipt; this adds source-derived targets rather than trusting
 * the report to choose which part of the film has to be inspected. */
export function evaluateStudioReviewCoverage({policy,candidate,review,receipts,reviewerSessionId,reviewCoveragePlan}={}) {
  if (policy?.reviewCoverage!==STUDIO_REVIEW_COVERAGE) return {ok:true,issues:[],enabled:false};
  try {validatePlan(reviewCoveragePlan,candidate);} catch (error) {return {ok:false,enabled:true,issues:['reviewCoverage: '+error.message]};}
  const current=currentReceipts(receipts,candidate,reviewerSessionId),issues=[];
  for (const target of liveTargets(reviewCoveragePlan,candidate.durationSeconds)) {
    const progress=observationProgress(target,current);
    for (const {kind,range} of progress.missing) issues.push(`reviewCoverage: target ${target.id} lacks ${kind} observations at [${range.join(',')}]`);
    for (const dimension of target.dimensions) {
      const check=(Array.isArray(review?.checks)?review.checks:[]).find(c=>c?.dimension===dimension);
      if (!check || !validRanges(check.ranges,candidate.durationSeconds)) {issues.push(`reviewCoverage: check.${dimension} does not cover target ${target.id}`);continue;}
      if (!target.ranges.every(r=>covered(r,check.ranges.map(pair)))) issues.push(`reviewCoverage: check.${dimension} does not cover target ${target.id}`);
      const linked=current.filter(r=>Array.isArray(check.evidenceReceiptIds)&&check.evidenceReceiptIds.includes(r.id));
      for (const kind of target.evidenceKinds) {
        const spans=linked.filter(r=>r.kind===kind).flatMap(r=>r.ranges.map(pair));
        if (!target.ranges.every(r=>covered(r,spans))) issues.push(`reviewCoverage: check.${dimension} lacks linked ${kind} evidence for target ${target.id}`);
      }
    }
  }
  return {ok:issues.length===0,issues,enabled:true,planSha256:reviewCoveragePlan.planSha256};
}

/** Receipt-derived next observations only, never a quality score. A missing or
 * stale plan is explicitly blocked rather than rendered as an empty checklist. */
export function studioReviewCoverageProgress({policy,candidate,receipts,reviewerSessionId,reviewCoveragePlan}={}) {
  if (policy?.reviewCoverage!==STUDIO_REVIEW_COVERAGE) return null;
  try {validatePlan(reviewCoveragePlan,candidate);} catch (error) {return {contract:STUDIO_REVIEW_COVERAGE,status:'blocked',issues:[error.message],observationsComplete:false,pendingTargets:[],nextWindow:null,qualityApproved:false,fullFrameCoverage:false};}
  const current=currentReceipts(receipts,candidate,reviewerSessionId);
  const targets=liveTargets(reviewCoveragePlan,candidate.durationSeconds).map(t=>observationProgress(t,current));
  const pending=targets.filter(t=>!t.observed);
  return {contract:STUDIO_REVIEW_COVERAGE,status:pending.length?'pending':'observed',planSha256:reviewCoveragePlan.planSha256,
    storyboardSha256:reviewCoveragePlan.storyboardSha256,executionBoardSha256:reviewCoveragePlan.executionBoardSha256,scriptSha256:reviewCoveragePlan.scriptSha256,
    observationsComplete:pending.length===0,targets,pendingTargets:pending,
    nextWindow:nextObservationWindow(pending),
    qualityApproved:false,fullFrameCoverage:false,
    note:'Host targets cover frozen scenes, declared motion, transitions and the real ending. Frame windows still contain sparse samples, not continuous playback or an automatic guarantee of story, acting or aesthetics.'};
}
