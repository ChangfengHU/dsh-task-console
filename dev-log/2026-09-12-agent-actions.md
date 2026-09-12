# Agent Actions — 0.30.12

## Scope and ownership

User confirmed reusable Actions rather than memorized behavior prompts. In an
existing Agent session `@` should expose that role's Actions; before a session,
Agent → Action is also supported. A click/preview does not execute. Explicit send
uses the role's native conversation and existing permissions, not a new Task.
Only plugin development/configuration and harmless UI acceptance were authorized
here. No developer-operated SSH, browser lifecycle, login-copy or proxy changes.

## Implementation

- Generic bounded Action schema: id/name/description/template and up to 12 typed
  parameters (text/number/boolean, required/default). One-pass interpolation,
  undefined/duplicate placeholders rejected, no expression/shell execution.
- Separate `actions.json`, atomic save with revision CAS. Normal preset saves and
  Action saves serialize and preserve each other. This leaves AgentSpec, composed
  permissions and frozen Task profile hashes unchanged.
- Config CRUD/copy/reload, native themed lazy popup, parameter preview, explicit
  send, cancel without dispatch, native input draft CAS cleanup. Current-session
  dispatch rejects a switched target; uncertain sends do not auto-retry.
- `@` resolves actual persisted role headers without loading transcripts; Actions
  precede the existing five/expand/search Agent list and workflow list. Failure to
  read a role's Actions must not suppress unrelated Agent/Task choices.
- Browser-manager starter pack (no fixed IP/account): create, delete, auto-login,
  inspect-login, recover. Config installation is explicit, not auto-restored.
  Existing instance grants and skill acceptance remain authoritative.

## Verification

- `NODE_ENV=test /usr/bin/node --import tsx --test --test-concurrency=1 test/*.test.ts`:
  final full run **257/257 passing**, 36.833s. Seven added tests cover typed values,
  injection-as-literal, defaults, invalid/duplicate parameters, concurrent CAS,
  preset rewrite preservation, revision/role drift, preview-without-execution,
  native same-session send, switched-session rejection and portable starter pack.
  One earlier full-suite summary showed one failure without retained detail; two
  subsequent full runs did not reproduce it. No failing behavior was suppressed.
- `/usr/bin/node scripts/build.mjs` and `git diff --check` pass. No new dependencies,
  native DSH package patches or schema migrations.
- Public Playwright/Chrome, 1440×1000 and 390×844: config create/edit/copy/delete,
  save/reload, two `@` entry paths, required-field blocking, exact prompt preview,
  cancellation with unchanged native session set, new-session and current-session
  sends. No page errors. Agent config ready at 19.74s cold; this feature does **not**
  claim to solve the host's existing cold startup delay.
- Successful safe native session:
  `agent-action-ui-check-4be020d821-mtyj1ysk`.
  Two user Actions, two completed model turns (15:15:55 / 15:16:01 UTC), 2 steps,
  **0 MCP, 0 native tool, 0 skill, 0 Task calls**. Exactly one new role session on
  first send, no additional session on second send. Model returned both markers.
- First UI attempt used an obsolete test-only model provider alias: new-session
  creation worked but native composer correctly refused that unavailable model.
  The smoke fixture now reads the host's actual default model; no business Agent
  or global model configuration was altered. The failed attempt's session remains
  `agent-action-ui-check-e64ac030ae-mtyiz5it`, not relabelled as successful.
- Actual browser-manager session `agent-browser-manager-mty0qfi0`: all five Actions
  visible; create-browser populated using documentation-only IP 192.0.2.1, previewed
  and **cancelled**. No tool call/target change. Dark-theme CSS branch verified:
  dialog rgb(22,27,33), foreground rgb(228,233,238); mobile form remains in viewport.

## Deployment and preserved state

Installed through the existing repository symlink and `sop-dsh-web.service`.
Waited for the existing scheduled patrol to finish, then verified zero active
native sessions, Task Runs, Browser operations and running/unknown proxy operations
immediately before the host restart. No Task/schedule was disabled to deploy.
The browser-manager sidecar was initially empty and received the five starter
Actions through native `saveAgentActions`; original `task-console.json` bytes match
before/after (SHA256 dfb0ec793c57884386ea6da21891f659264a81bb679170a032175c11e1cfe6d6).

Read-only post-check: original two non-archived business Tasks remain enabled;
patrol keeps `{kind:cron,expr:'0 * * * *',timeZone:'Asia/Shanghai'}`. Neither Task
definition, review nor execution history was written by this feature acceptance.
Browser operations themselves were deliberately **not** performed to test a menu.

## Cleanup and recovery

Both uniquely named test Agent presets were removed by the smoke script's exact-id
cleanup; their native sessions remain as acceptance evidence. No user preset,
session, Task, browser data or host grant was removed. New unit fixtures self-clean
their `mkdtemp` directories; Chrome temporary profiles are closed/removed by
Playwright. No new dependency/cache was installed. Tracked `lib/` is the production
runtime, not disposable build waste.

Six screenshots remain in `/tmp/dtc-actions-*.png` (762,687 bytes total) as temporary
acceptance evidence, not Git/public uploads of private conversation UI. Review then
remove only these exact six files, or regenerate via the opt-in smoke and real-role
preview checks. Retained filenames: editor-1440, editor-390, current-1440,
current-390, browser-menu-1440, browser-dark-390 (each with `dtc-actions-` prefix).

Operational contract and future installation: `docs/agent-actions.md`, referenced
from HANDOFF. No new standalone plugin, automatic Task, scheduler or permission
system was introduced.
