# 2026-09-15 — Session capability truth and bounded standard chat

## Authorized objective and boundaries

Fix the capability-inventory question that led a standard Qwen session into
repeated MCP calls. Separate Agent definition, actual scoped runtime and available
environment inventory; do not claim installed tools are automatically usable.
Preserve every existing session, Task definition, schedule, Agent grant and business
receipt. No developer SSH or browser lifecycle/login operation on Fleet machines.
UI scope is one conversation tab, preserving Chat, Trajectory, Context and Trace.
Do not create a second scheduler, rewrite the Task engine, rotate tokens, or claim
automatic delegation before an actual delegation implementation exists.

## Verified diagnosis and containment

- Exact affected session: `session-d50d2a71-bed9-4b2f-bf1c-10de47e8c14a`.
- Original user asked only which Skills/MCP were installed. The standard role
  inherited raw host MCP definitions, attempted restricted browser operations
  with an invented task identity, then repeatedly queried login candidates.
- At the earlier diagnosis: 93 steps, 71 candidate calls, roughly 26 minutes.
- User explicitly authorized cancellation. Native `session.cancel` accepted it
  at 08:47:19Z; a second check at 08:47:52Z confirmed running=false and unchanged
  112 steps. No history deletion or service restart was involved.
- Native repeat-tool-reminder is advisory and targets consecutive calls; it is
  not a hard budget. The new standard-chat guard supplements rather than removes it.

## Implementation

- Host-owned read-only current/environment tools, shared Capabilities panel API.
- Safe SQLite latest runtime snapshots and observed request-header tool names.
- Explicit distinction between on-demand Skill availability, history loading,
  inherited registration, blocked identity and unknown CLI-private discovery.
- Ordinary raw browser identity schemas filtered from prompts and guarded at the
  native execution boundary. Existing Task/Agent business logic retained.
- Standard native inheritance options and configurable step cap; unchanged-result
  detection across interleaved tool calls, no duplicate-status polling cutoff.
- Native scoped fences admit the two platform metadata tools, not business grants.
- Qwen Flash synthetic function-call request via the already configured local
  provider completed in 2.46s with correct capability_probe arguments; no tool was
  executed. This proves this one route/schema response, not general benchmark speed.
  Prepared local model-catalog addition; no existing model selection was changed.

## Verification before production activation

- 313 tests passed, zero skipped (supported Node22, serial full test command).
- Native ToolRuntime fixture proved forged browser identity cannot execute.
- Public candidate Capabilities tab: 1440px and 390px after native sidebar collapse,
  two read requests, zero page errors and zero business mutations; 22.21s readiness.
- Screenshots retained in `/tmp/dsh-capabilities-candidate-{1440,390}.png`.
- Candidate build `/tmp/dsh-capability-build-3wM4gH` is rebuildable and must be
  removed after production validation; no new dependencies were installed.
- At 09:02Z onward, existing hourly Task Runs were active. No DSH restart was
  performed while those runs were active. Production activation and real-Qwen
  inventory completion must be recorded below when verified, not inferred here.

## Known scope limits

- No automatic cross-Agent delegation or CLI-private loader instrumentation yet.
- The standalone DeepSeek web_search authentication failure is separate. Vault
  directory inspection found Qwen/DashScope and Firecrawl entries, no DeepSeek
  service entry. No credential replacement or speculative token rotation performed.
- Registered tools still require per-call target/approval checks. A catalog entry
  is neither a target authorization grant nor a live connectivity guarantee.

## Production activation and real acceptance

- Deployed at verified native-session/Task dual-zero boundaries. Initial startup
  failed because the new reader accessed SQLite before runner initialization;
  moved construction after runner.start and awaited readiness before hook install.
  Service recovered without deleting any data. This was a real deployment defect,
  not covered by the initial isolated tests.
- First real Qwen run finished in 21.3 seconds with one directory call, but its
  answer overstated availability. Native complete prompts discarded the injected
  section. Moved guidance into retained runtime contexts and added a regression
  assertion; its presence was verified in a real user/message context event.
- Final visible test `session-capability-final-20260915`, qwen-plus-latest:
  original inventory question, 29.337 seconds, only session_capabilities and
  environment_capabilities, normal turn/end. No business tool calls. Answer now
  separates restricted browser operations. Some prose still calls registered
  services available; connectivity/authorization are NOT thereby verified. UI and
  tool metadata explicitly distinguish them. Do not claim perfect model compliance.
- Live public Capabilities tab desktop/390px: 20.91 seconds readiness, two reads,
  zero page errors and zero mutations. Screenshots `/tmp/dsh-capabilities-live-*.png`.
- Task specs, schedule bindings and Action catalog hashes match pre-deployment
  baselines exactly. Existing histories and reviewed roles were preserved.
- Native model catalog confirms qwen-flash is available; existing model choices
  were not changed. Synthetic function-call evidence above remains its bounded test.
- One full-suite run during concurrent browser/model tests hit an existing
  3-card runner fixture failure (undefined followups), consistent with timing but
  not conclusively diagnosed. Final serial rerun passed 313/313, zero skips in
  40.28s (`/tmp/dsh-capability-truth-tests-final.log`); no test was disabled.
- Removed the verified unused candidate build `/tmp/dsh-capability-build-3wM4gH`
  (1.5 MiB). Recreate with the retained build script and a temporary DTC_BUILD_OUT;
  production lib, source, lockfiles, screenshots and test logs were retained.
