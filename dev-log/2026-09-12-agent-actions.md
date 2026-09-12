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

## 0.30.13 — corrected interaction contract

User rejected the invocation modal/form and Actions displacing the Agent identity
editor. The same plugin now has Configuration / Actions / Sessions / Tasks tabs,
defaults to Configuration, lazy-mounts Actions, and preserves unsaved drafts across
tabs and history navigation. Action invocation fills the native composer instead:
select the first inline placeholder, Enter/Tab forward, Shift+Tab back, separate
Enter/Send after the final field. Missing markers block the Send button as well.
Native undo/redo, IME and Shift+Enter remain native; no contenteditable or second
draft store, no DOM textarea value writes.

Candidates use the selected session's actual header role, never the session name
or a sticky last Agent. Async replies from a previous role/session are discarded;
role changes dismiss the stale menu. A blank composer may already have DSH's
selected preset. Explicit Agent selection before starting can choose another role;
an existing other-role conversation does not expose browser-manager's Actions.
Submission rechecks role and sidecar revision and retains the existing Session.
The removed modal is not retained as a second invocation path.

Verification: 262/262 full regression tests pass (36.372s), build and diff checks
pass. Public browser acceptance verifies both entry paths, required Enter/Send
blocking, editable prompts, placeholder navigation, native undo/redo and IME
confirmation. Two harmless model turns in each successful test session; no tools,
MCP, skills or Task calls (native sessionTurns totals checked):
`agent-action-ui-check-38782b52da-mtykmfom` and
`agent-action-ui-check-a6a6e226fd-mtykokdv`. A local-host smoke also passed in
`agent-action-ui-check-a392d6d6a3-mtykk5kn`.

The initial keyboard test found a real range-tracking bug: a typed underscore
matching the template separator was attributed to the next placeholder. Tracking
the selected field's unchanged surrounding ranges fixes it; a sequential-typing
regression covers the failure. No failing test was removed. Layout-only public
1440/390px checks pass: default identity, independent tab, lazy load, no history
list leakage, draft preservation, reload/deep-link and history navigation, no
persisted configuration mutations or page errors. Cold ready remains ~17–22s;
this change does not claim to fix DSH startup latency.

This correction changes only plugin UI/assets/docs/tests. The existing live
repository symlink serves the tested client; no host restart or deployment pause
was needed, and no native DSH package was patched. Browser-manager executable spec
SHA256 remains dfb0ec793c57884386ea6da21891f659264a81bb679170a032175c11e1cfe6d6.
Both original business Task definitions match the pre-change hashes and stay
enabled; the hourly schedule, permissions, credentials and all histories remain
untouched. No Fleet target was operated. Randomized smoke presets are removed by
exact ID; harmless native transcripts and screenshots are retained as acceptance
evidence. No dependency or download cache was installed. Tracked lib/ is runtime,
not temporary waste. See the closing verification below for final screenshot and
cleanup evidence.

Final public smoke: `agent-action-ui-check-038ca8d40b-mtyl0i54`, two successful
text echo turns in one role session, zero page errors, Agent ready in 20.91s.
Includes the IME and native undo/redo checks, 1440/390px composer screenshots,
all config CRUD, field/button guards and role isolation. Mobile testing must wait
for DSH's resize-driven automatic sidebar collapse before deciding to toggle it;
clicking during that transition re-opened the sidebar in earlier failed test
attempts. The test was corrected and passed on both local host and the public
origin, without a host layout patch or weakening the usable-width assertion.
The final mobile screenshot was visually reviewed, not merely measured.

Removed only `/tmp/dtc-actions-sidebar-check.png` (64,554 bytes), a task-owned
rebuildable debug screenshot. Regenerate through the browser smoke's native
mobile view. Eleven acceptance screenshots remain (1,715,613 bytes, ~1.64 MiB):
the six original `dtc-actions-` names listed above (editor/current overwritten by
this version), `dtc-actions-browser-inline-1440.png`, and the four
`dtc-action-tabs-{config,actions}-{1440,390}.png` files. They remain until UI
acceptance; no new dependencies, build caches or downloaded assets need cleanup.

## 0.30.15 — keyboard, reload recovery and explicit blank-session ownership

The earlier "fixed" report was too broad. Read-only public reproduction confirmed:
native text/draft persistence survived reload but the Action claim and snippet
controller did not. The supported native input machine only re-adjudicated `/`,
so Enter on a restored `@Action` attempted the ordinary `session.prompt` path with
unfilled markers. The diagnostic browser intercepted that request before delivery.
New Session also reused a blank browser-manager session and exposed its Actions
without a fresh Agent choice. Chromium typing/paste/IME in an already-claimed
nonblank session worked; that narrower test did not cover either failure.

The user's subsequent "继续修改" authorized this correction. Earlier uncommitted
0.30.14 menu focus/default-field changes are retained in this 0.30.15 work; no
separate 0.30.14 GitHub publication is claimed.

Implementation remains in the same plugin:

- Bare `@` in a blank/default-inherited session offers Agents, workflows and Files,
  never default-role Actions. Explicit @ Agent selection exposes its own submenu;
  clearing the selection hides it again. Nonblank sessions retain actual-role
  isolation, async cancellation and submit-time owner checks.
- Every parameter now has a visible marker, including defaults, plus an index/total
  hint. Enter/Tab accepts unchanged defaults or advances edited values; last-field
  Enter only finishes filling. No Action modal or alternate editor was reintroduced.
- Native draft recovery revalidates Action identity/revision/owner and draft CAS,
  restores a native claim and resumes range tracking. Tab-local sessionStorage
  holds only identity/ranges/progress and a non-security checksum, not another
  prompt copy. Older drafts recover only real remaining markers. Empty, cancelled,
  changed-role or obsolete-action data cannot silently grant a new Action owner.
- A real additional timing failure appeared during repeated acceptance: hydration
  or typing could supersede a pending lookup, discard its old result, then leave
  the latest revision unprocessed. Empty shells no longer look up configuration;
  superseded lookups re-check the latest revision. A deterministic async unit test
  exercises hydration, changed draft revision and exactly one current claim.
- `scripts/patch-input-menu.mjs` is version-fenced to DSH 0.1.1-rc.2. Native menu
  focus follows visible source order until the user deliberately moves; late
  source results cannot steal that highlight. Native conversation Enter/Send now
  re-adjudicates leading @ while this plugin's marker is mounted, rather than
  bypassing guards after reload. Unmounted-plugin behavior and Files are retained.
  Unknown/partial anchors are rejected; the installer validates both files before
  writing and is wired into the existing host installer.

Verification (supported Node /usr/bin/node, actual installed host path in
DSH_INSTALL_ROOT): all **270/270 tests pass**, no skips, 39.114s. This includes the
actual native menu reducer/input machine, metadata corruption/staleness, inherited
blank isolation and the deterministic recovery race. Build and `git diff --check`
pass; native patch `--check` returns changed=false, needed=false.

Public keyboard acceptance passes on 1440/390px: five Actions selected by arrows,
Enter pick, Files ordering, three visible fields, forward/back, edited and default
numbers/booleans, and no final-field send. Public recovery acceptance passes:
mid-field refresh retaining typed `2`, missing-field Send, session switch/back,
reused blank hiding Actions, explicit Agent selection with another refresh,
clearing, and legacy draft recovery without metadata. A separate final Enter was
intercepted before HTTP delivery and checked for exactly one native same-session
prompt with the Action label and rendered values, no placeholders. This proves
dispatch routing only, not a browser operation or model execution. Real native
turn totals remain unchanged; no Agent/preset/session was created for these tests.
Recovery UI screenshots were visually inspected, not only measured.

Deployment uses the existing live repo symlink; no service restart or business
pause. Executable browser-manager spec SHA256 remains
dfb0ec793c57884386ea6da21891f659264a81bb679170a032175c11e1cfe6d6.
Both original Task definition hashes remain respectively
0be6047f328727afab0526080b4f4c1e5d0162f00415a7840ae7ad63b7fda9cd and
c5da82ac3c1b78f3f19189e951668019b5a76c9a3a2591edec487f6b74f36b06;
enabled=1, original hourly schedule/permissions/reviews/history unchanged.
No Fleet SSH/browser/login/proxy operation or new dependency installation.

Runtime backup files are retained beside the two native client.js files:
`.dtc-menu-focus-backup` (36,837 bytes) and `.dtc-action-submit-backup` (448,468
bytes); these are production rollback sources, not disposable caches. Four new
temporary acceptance screenshots are retained in /tmp until user acceptance:
dtc-action-keyboard-menu-1440.png, dtc-action-keyboard-fields-1440.png,
dtc-action-keyboard-fields-390.png, dtc-action-recovery-role-1440.png (about 694 KiB
combined). They can be regenerated by the two read-only browser scripts; earlier
unique acceptance evidence is preserved. Playwright closes its isolated temporary
profiles. Tracked lib/ remains production runtime; no cache/dependency cleanup or
user data deletion was needed. Exact recovery commands/contracts are in the
existing docs/agent-actions.md and HANDOFF.md, not a second handoff file.
