# Opt-in Studio production quality loop

This change does not replace Task scheduling, its database graph, dependency links,
gates, state machine, or UI. Existing frozen tasks keep their legacy review profile.

## Enable for a new task

The task-draft composer accepts `qualityProfile: "scene-action-v1"`. It freezes
`reviewCoverage: "scene-action-v1"` and `structuredRepairs: true` into that task's
Studio policy. A prompt alone cannot enable the host gates.

The compiler derives review targets from the registered original storyboard,
component binding and execution board. Their exact source hashes and generated
index hash are retained. A strict candidate must come from the completed host
render job bound to that compilation; editing the generated index requires normal
recompilation and a new render, not relabelling old video bytes.

Targets include each scene's beginning/middle/end, transitions, every declared
motion interval, and the actual encoded candidate's final two seconds. The ending
requires both frame and audio evidence. Frame sampling remains sparse, not a claim
of every-frame viewing or proof that an undeclared action exists.

## Observe efficiently without lowering coverage

Progress uses only receipts for the current candidate and reviewer session.
Overlapping targets share observations; partially observed targets request missing
intervals rather than repeating their whole windows. Scheduled frame/audio coverage
windows remain at most two seconds. The target set and dimension-specific positive
evidence rules are unchanged.

Eight frame decodes use a bounded two-worker scheduler. Results preserve original
seek arguments and ordering; empty/oversized outputs and stale operations are
rejected. This optimizes extraction, not provider latency or the whole production
pipeline. Actual render, image, voice and upload jobs retain their original IDs for
reconciliation; an unknown paid result is not permission to resubmit under a new ID.

## Repair actual causes

Structured issues identify their dimension, original scene/line and time range,
responsible source stage, observed cause, concrete repair and verification plan.
An independent grounded rejection may hand back unfinished positive coverage with
unchecked dimensions pending; it cannot declare acceptance.

Historical issue IDs and original candidate/location remain auditable. A resolved
issue requires different video bytes and fresh matching independent evidence.
Metadata-only revisions do not count as new production rounds; materialized
preparation/production rounds do, including cancelled rounds. Stored repair counts
never decrease.

Source rewriting, voice acting and animation remain creative responsibilities.
Host evidence gates do not make a film enjoyable or turn a machine-assessed
candidate into user approval. The difficult-action pilot remains a production
brief requirement here, not a newly implemented native pilot gate.

## Host readiness is separate

Runtime paths and the audio observer model are host-owned configuration, never
model-supplied task fields. Legacy audio-model selection is retained when omitted;
changing it requires same-model clean/missing/silence/noise calibration evidence.
A successful short speech calibration is not universal recognition accuracy,
performance calibration or film quality approval. Do not alter expected words,
accept failed samples as passes, or waive homophone mistakes to clear a gate.

Installations and tests prove configured/local behavior only. Verify real model
selection in the new batch's frozen execution binding and real request ledger;
an authenticated CLI or current UI default is not proof of that batch's model.

## Actual local film regression, 2026-10-03

The real Task produced a 75-second 《免配送费》 candidate, SHA256
`703a1a8912e2f9c0a3bca35d08715051f1dda33a4383b116b7a30c032e8238b3`.
It is decodable, not accepted. The actual request effort was low despite the
authored high setting; the later fixed-entry mapping repair does not retroactively
change this film. Full-range sampled comparison and exact RGBA/source checks
found opaque face/body interiors removed during cropping, panel marks retained,
square-box amounts already present in a source image, contaminated onion groups,
and scripted rupture/head-holding replaced with labels/whole-image movement.
Reference quality was not reached. No full-speed or independent audio/Task QA pass
is claimed by these auxiliary inspections.

After normal cancellation preserving the film, original history and paid budgets,
the local implementation also addresses observed integration waste:

- Task workers, fixed tryRun and Intake install the SDK's scoped route/effort
  selection before first assembly, dispose it on every terminal path, and keep
  fallback precedence. Interactive user model switching is deliberately unchanged.
- Studio registration mirrors the existing role grants and still checks execution
  authorization. This does not fix the host FS plugin's own-scope read_image
  presentation gap or grant arbitrary preparation-image access to a planner.
- Exact declared image-capable producer routes receive actual bounded, hashed
  attachments as well as mediated observation. Text-only/unknown routes retain
  mediated compatibility; producer vision is not independent review evidence.
- Startup shows the canonical current-session required skill list and actual
  missing calls. Installed catalogs/other-session loads cannot clear the guard.
- Producer audio preview tolerates only <=1ms end rounding and reports the actual
  sampled range; strict reference/reviewer ranges are unchanged.
- BGM acquisition uses a unique exact ISRC/title match, not an undocumented UUID;
  license/host/filename/redirect/source-receipt boundaries remain enforced.

Quality next steps are clean opaque foreground masks, readable authored order
states, independent props and visibly implemented action states, followed by a
genuinely accepted difficult pilot before full rendering. The existing compiler
supports multiple images and keyframes but only image/text and basic transforms.
Advanced SVG/mask/custom-source support would need a compatible traceable contract,
not direct edits that bypass compiled SHA or render provenance. The reference's
revised HTML itself used clean pose PNGs and shot cuts, not skeletal animation;
such an engine is not a prerequisite to improve this first film.
