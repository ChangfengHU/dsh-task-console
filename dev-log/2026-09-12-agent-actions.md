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

## 0.30.16 — configurable defaults, read-only candidates and conditional intent

User approved configurable Enter-default behavior, machine IP suggestions,
count=1, default account allocation policy and optional explicit account sources.
These are Action parameter capabilities, not browser-specific logic embedded in
the generic composer. Invocation remains inline; no form/modal, new task, role
grant or machine operation is introduced.

Implementation:

- Sidecar schema validates Enter-default acceptance, fixed text choices,
  integer/minimum limits, registered source IDs and simple earlier-parameter
  equality/dependencies. Cycles, invalid defaults, duplicate labels and ambiguous
  repeated/reordered dependency fields fail. The Actions editor exposes these
  settings in per-parameter disclosures and preserves unsaved tab drafts.
- A small native-composer candidate popup supports search, keyboard/click choices,
  20-row pages, loading/empty/error/retry and responsive light/dark styling.
  Machine candidates do not silently select the first result; new IPs can still
  be entered. Revisiting a filled choice shows all alternatives, not only its
  current value. Last-field Enter remains a finish-filling step, never auto-send.
- The optional host Fleet adapter locates the existing browser MCP modules from
  its trusted composition entry and reuses its inventory and account ranker/policy.
  Only GET metadata is read, with coalescing/five-second memory cache; no discovery
  refresh POST, SSH, verification, export/import, source allocation or copy. The
  native RPC checks Action revision, actual role, configured source and existing
  read-tool visibility. Agent rights and MCP readiness have different errors.
- Live read-only integration returned machine suggestions and email/source-IP/
  browser account records. Existing discovery records can be expired: these are
  labelled pending execution-time verification, not current login proof. Only
  authorized discovered identities may express intent; excluded/ungranted accounts
  are omitted, other unavailable sources disabled. The MCP's actual mutation
  boundary and Agent must independently reverify account/source/target grants.
- Browser-manager creation defaults to one instance and the existing allocation
  policy. Specified-account mode reveals its dependent marker; changing IP or mode
  clears that choice. Automatic/no-login modes skip it without hidden placeholders.
  Only the five Actions were CAS-upgraded after an exact normalized comparison
  against the previous starter; no user-customized sidecar was overwritten.

Public testing caught an additional real failure absent from fast local tests:
editing a completed draft after refresh while the Action catalog was in flight
could invalidate persisted coordinates, lose its conditional relationship, and
leave Enter unable to advance. The lightweight watcher now tracks coordinates
and edited field indices during that wait, without storing values. After the
current catalog arrives, dependent selections are invalidated before use. Known
range-end edits must be attributed to that earlier field, not the static separator.
Unknown legacy dependency coordinates fail closed with the original text retained.
Focus also waits for the matching DOM revision with bounded/cancellable animation
frames; it cannot select over subsequent typing. Deterministic tests cover both
render lag and editing a fully filled Action during a deferred catalog read.

Verification:

- Full supported-host regression: **278/278 passed, zero skipped**, 37.124s,
  `/usr/bin/node`, `DSH_INSTALL_ROOT` set to the actual installed DSH. Build and
  `git diff --check` pass; native input patch check reports changed=false/needed=false.
- Public `test-agent-actions-keyboard-browser.py`: five Actions and retained Files
  keyboard order; typed/default numbers and login modes; forward/back navigation;
  no final-field send; desktop/390px; saved catalog and native turn totals unchanged.
- Public `test-agent-actions-recovery-browser.py`: partial refresh, exact edited
  ranges, missing-field Send guard, role switch/back, reused blank role isolation,
  explicit Agent choice, legacy draft recovery; one final same-session dispatch
  intercepted before HTTP delivery. No model/Agent/Task/target operation.
- Public `test-agent-action-options-browser.py`: real machine search and authorized
  account metadata; positive integer enforcement; conditional selection; IP/mode
  invalidation; refresh; deliberately held catalog while editing a completed draft;
  separate simulated failure/pagination/late-source replies; old-role replies stay
  hidden. 1440/390px bounds and both theme palettes pass. Every business write was
  intercepted; all tests leave actual turn totals and saved Actions unchanged.
- Public Actions-tab regression: default identity remains first and Actions lazy;
  per-field controls, unsaved default-acceptance toggle across tabs, routes/history,
  session/task tabs and desktop/mobile layouts pass without saving a preset.
  Screenshots were visually inspected, including the mobile expanded controls.

Deployment: the existing live symlink serves 0.30.16. Host restarts occurred only
after fresh zero checks for native `session.list.running`, SQLite running Task
Runs, running/unknown proxy calls and running/queued browser receipts. No cron
pause, history deletion or Agent execution was used to deploy. The two preserved
Task hashes and browser-manager executable spec hash match the 0.30.15 baseline
above; both Tasks remain enabled, the patrol trigger stays hourly (`0 * * * *`,
Asia/Shanghai). Action sidecar revision is
5a6cbedb6ec07c22dcb9453eb1e3788ed67caef66499051ba782fa8a05d07099.
The light entry is 34,360 bytes (previous 24,239); no Fleet query runs just because
an ordinary page opens. Candidates are fetched only on applicable field use.

No dependency or download cache was installed. Unit-test temporary roots and
Playwright temporary profiles are removed by their existing scoped teardown.
Tracked lib/ and original native patch backups remain production/rollback assets.
Five new local screenshots are retained for this UI's user acceptance (about
0.9 MiB; editor images are updated by the final run):
`/tmp/dtc-action-options-machines-1440.png`,
`/tmp/dtc-action-options-accounts-1440.png`,
`/tmp/dtc-action-options-machines-390.png`,
`/tmp/dtc-action-options-editor-1440.png`,
`/tmp/dtc-action-options-editor-390.png`.
These are regenerated by the options and tabs scripts; do not upload private
session screenshots as public artifacts. Earlier unique evidence is retained.
No source, user data, browser profile or runtime dependency was cleaned/deleted.

## 2026-09-13 — 0.30.17: native role confirmation and keyboard candidate mounting

User reported two concrete misses: selecting 浏览器管理员 in the native
“Into the Unknown” hero still required another @ Agent choice; Enter accepting
the default browser count selected 登录方式 but did not open its choices.
Scope is the existing UI only: no Agent configuration/permission, Task, schedule,
history or target operation changes.

Both were reproduced against the previously deployed 0.30.16 in public Chrome.
The new native-role regression failed after a real same-role chip selection;
the strengthened keyboard regression saw zero options instead of three after
Enter accepted count=1. Earlier tests exercised a typed count or checked only
text selection, so they missed the default-replacement DOM timing.

Fixes:

- Blank-session isolation now distinguishes a confirmed native chip choice from
  inherited defaults. The supported-host, anchor-checked installer adds an event
  bridge after a matching blank choice or successful selection response. Choosing
  the displayed role emits UI intent without another API mutation. Failed picks,
  nonblank switch attempts and default loading do not. Existing header/backend
  role checks remain authoritative. The only new tab-local metadata is Agent ID
  keyed by Session; refresh retains it, New Session/owner change invalidates it.
- Mount candidates only once the placeholder focus has a textarea matching the
  native draft revision. Clear old choices immediately on navigation; existing
  epoch, input-change, role and cancellation protections remain. Enter accepting
  a default now opens the next static choice list automatically.

Verification:

- 281/281 Node tests, zero skipped, 37.329s; build and diff checks pass. Tests use
  the actual supported native preset controller/input reducer/machine, including
  same-role selection, staged application, failed response and plugin-off cases.
- Public keyboard regression passes at 1440/390px, explicitly checking all three
  login-mode options after default-count Enter without clicking or typing again.
- Public native-role regression uses the existing blank acceptance session:
  real hero chip selection → bare @ → current-session Action, refresh, new-session
  isolation and mobile view all pass. No preset-select write is needed for the
  same-role check. Browser writes are intercepted. One test iteration used the
  visible “New Session” text instead of the native “New session” accessible label;
  corrected to the real control and reran the entire flow successfully.
- Existing public options and recovery scripts pass: live metadata selection,
  conditional account reset, refresh/edit during delayed catalog, explicitly
  simulated failures/pagination/late replies, Send/last-field guards and
  intercepted final same-session dispatch. Native turn totals and catalog hashes
  stay unchanged; this is UI acceptance, not execution of a browser operation.
- Public Actions-tab regression also passes with saved configuration unchanged.
  Its first reload assertion raced the asynchronous tab URL update; the test now
  waits for the actual Actions deep link before reload, then checks unsaved drafts,
  restored defaults, native history navigation and desktop/mobile configuration.

Deployment is the existing live symlink plus the native client patch; no host
restart was needed. Public responses contain the new native bridge. Preserve
`dsh-client-ui-agent-preset/lib/client.js.dtc-action-role-backup` (about 76 KiB)
as a runtime rollback source. The light entry is 34,955 bytes; heavy/runtime
bundles are unchanged. Returning browsers should hard-refresh cached native
assets; an old blank session without new UI confirmation evidence needs one
explicit role choice, not an invented historical confirmation.

After verification, browser-manager AgentSpec hash remains
dfb0ec793c57884386ea6da21891f659264a81bb679170a032175c11e1cfe6d6;
Actions sidecar remains
5a6cbedb6ec07c22dcb9453eb1e3788ed67caef66499051ba782fa8a05d07099.
Both preserved Task hashes match the prior baseline; enabled=1 and hourly
Asia/Shanghai cron are unchanged. No model prompt, Task/Batch, browser operation,
SSH or notification was delivered.

No dependencies or download caches were installed. Existing scoped test teardown
removes temporary profiles/roots. Removed only the now-redundant diagnostic
`/tmp/dtc-action-role-before.png` (113,710 bytes), reproducible by the native-role
browser check. Four final acceptance screenshots are retained pending user review:
`/tmp/dtc-action-native-role-1440.png`, `/tmp/dtc-action-native-role-390.png`,
`/tmp/dtc-action-login-mode-1440.png`, `/tmp/dtc-action-login-mode-390.png`.
These are regenerated by the committed read-only browser scripts; private session
screenshots must not be uploaded as public artifacts. No user data was deleted.

## 2026-09-14 — Task Actions, 0.30.22 implementation checkpoint

Approved scope: reuse the Agent Actions native composer for Task-owned actions.
@Task selects an action and typed current inputs, submits the existing Task's new
Batch and opens its execution page, without an ordinary chat or second executor.
Do not run an installation in this development turn or change existing schedules,
roles, TaskSpec, history or the fleet-base-v2 dual-browser 20-minute acceptance.

Implemented separate SQLite CAS catalog/request deduplication, safe immutable
turn.action snapshots, explicit target/first-SSH/account bindings, account intent
fence, Task Actions editor/preview/default/disable and Creator proposal review.
The Task title or candidate source IP is never a target inference for this API.
New-node Vault selection is metadata-only and cannot grant admission or bypass
the MCP's runtime policy. Credentials use the existing private batch lease;
neither snapshot nor event history contains their supplied bytes.

Verification: build succeeded with the existing dependency tree; 293 tests passed,
zero skips, including the native host reducer/input tests with DSH_INSTALL_ROOT
set to the actual running CLI install. The first new private-lease test used the
fixture's parent instead of EventStore.root; corrected that assertion, not storage.
Real SQLite/runner tests cover frozen review, original Task/hash preservation,
one Batch/role-only Sessions, CAS and accepted retries after action deletion,
typed input failures and no accidental candidate/source target expansion.

Public Chrome and local Chrome ran scripts/test-task-actions-browser.py at
1440/390px: Task/Agent menu isolation, native default/conditional Vault fields,
refresh and request-ID restoration, failed-delivery retries, successful execution
URL routing, lazy editor and preview. Task APIs in that browser script are
explicit fixtures intercepted before the backend; this is not business execution
or a claim of successful installation. Screenshots were visually inspected.
Adjusted fixture keyboard movement from its initial unselected option and the
fixture error envelope; neither issue was a production login operation.

Deployment pending at this checkpoint: the real hourly patrol is active. Safety
checks declined restarting DSH. The source/UI build must not be reported as a
live backend installation or a seeded Task action. Original installer and patrol
definitions remain enabled and unmodified. No target SSH, browser import/create/
delete, model prompt, Task dispatch, permission changes or schedule change by this
development work. The existing autonomous patrol's ongoing work is separate.

No dependencies or download caches were installed. Test fixtures tear down their
own temporary SQLite/profile trees; tracked lib/ is production runtime. Retain the
three final task-actions screenshots for user review; the resolved diagnostic is
rebuildable and will be removed at final cleanup.

### Deployment and final acceptance

Implementation commit `8f26fe0` was immediately pushed to the verified authorized
GitHub upstream. Subsequent mixed-version UI gating keeps legacy Task entry buttons
usable until the host advertises Action support; adding a UI tab must not make an
in-flight older backend fail. Local browser fixture acceptance passed again.

At **2026-09-14T10:29:02.136Z**, read-only checks found no live native session,
running Task claim, fresh browser operation, or running proxy operation in the
actual proxy SQLite store. Restarted only the existing user sop-dsh-web service.
The autonomous patrol was not cancelled, archived or disabled. The service became
active with its existing configuration; no target host was touched.

CAS-installed `presets/fleet-task-actions.json` into the previously empty catalog
of **T-chat-b4c6fcb369f0c20a9739**. Action `onboard-node`, name 装机与账号验收,
revision `2a835ee80745dae14ab5606d40fb5d8a6941e0edcee2879e5f3092de4b0e65b4`.
No new Task or Batch was created. Installer and patrol raw spec_json SHA256 values
remained respectively `0be6047f328727afab0526080b4f4c1e5d0162f00415a7840ae7ad63b7fda9cd`
and `c5da82ac3c1b78f3f19189e951668019b5a76c9a3a2591edec487f6b74f36b06`;
both enabled=1, patrol `0 * * * *` / Asia/Shanghai. Browser-manager AgentSpec file
hash remains `dfb0ec793c57884386ea6da21891f659264a81bb679170a032175c11e1cfe6d6`.

Live metadata returned seven Fleet machine choices and three admitted Vault
accounts for the documentation-only unregistered IP 192.0.2.30, with no login
transfer or source-browser fallback. Public live browser test passed at1440/390:
installed editor, @ original Task → Action, native defaults, actual machine and
Vault dropdowns, explicit excluded-account omission and no page errors. All
execution/config writes were blocked in that browser test. Original session totals
and catalog were identical before/after. Images were visually inspected:
`/tmp/dtc-task-actions-live-editor-1440.png`, `-390.png`, and
`/tmp/dtc-task-actions-live-vault-1440.png`, `-390.png`.

The live launchTaskAction endpoint was separately tested with `not-an-ip` and a
fresh fixture request ID. It rejected at the IPv4 gate; installer Batch IDs were
unchanged and dsh_task_action_requests remained empty. This proves rejection and
registration of the real endpoint, not a successful production installation.
Successful scheduler/role-only Session routing is proved by the real-kernel fake
host tests; successful UI receipt routing uses intercepted fixtures. No claim of
live successful installation is made.

Original Agent Actions keyboard/default/mobile regression first hit one public
menu timeout; local then public reruns passed, preserving its session and sidecar.
Do not report the first timeout as a repaired production login failure. Full
native-host-aware suite: **293 passed / zero failed / zero skipped**, build and
diff checks passed. No npm release or target operation was performed.

Removed only `/tmp/dtc-task-actions-diagnostic.png` (255,190 bytes); it was this
task's resolved, reproducible UI fixture diagnostic. Seven final screenshots
(three fixture, four live) remain as private user-review evidence; regenerate with
the committed browser scripts, never upload them publicly. No dependencies or
cache downloads were installed; tracked lib/ and running dependencies remain.

## 2026-09-14 — Standalone execution-page Focus V1 prototype

User requested a separately reviewable HTML prototype, not a production UI change.
The existing page placed repeated headers, four technical statistics, creation
metadata and lease narration above the useful execution view. A real 1440x1000
browser showed the graph title around y=430, role cards around y=680 and results
below the first viewport. This was layout evidence, not machine acceptance.

Added only `prototype/task-execution-focus-v1.html` and the standalone browser
acceptance script. The prototype brings the workspace to approximately y=214,
keeps the dependency graph central and places current role progress, Trace and
raw snapshot data in a selectable inspector. Results have a top-level entry;
creation/plan, Sessions and Action metadata are secondary. Fullscreen retains
the inspector; mobile uses a dismissible detail sheet. Replay changes actual
fictional snapshots: roles and links do not appear before their creation frames.
The original three-role sequential contract is represented, without inventing
a Gate or additional agent for this workflow.

All status, times, accounts, sessions, receipts and reports are fictional and
visibly marked. Target is documentation IP 192.0.2.63. Includes running, blocked
and passed examples, single-step/autoplay, trace filters with request/response,
conversation preview, report/HTML preview and JSON download. No service API,
external script, font, image, credentials or production identifiers are included;
CSP denies network connections. No runtime source, bundle, preset, Task/Batch,
database, permission, schedule or machine was modified. No build/deploy/restart
of DSH occurred. The currently running user's Task was not interrupted.

Vault service:github and service:suqu-api were read in process. GitHub read-only
/user and repository checks verified ChangfengHU and authorized push access.
Upload host/public domain matched configured endpoints. Upload service sanitizes
slashes in `name` to underscores: the first guessed nested URL returned 404.
Read existing upload implementation, located the single actual uploaded object,
and verified that URL instead; did not upload a second duplicate or change the
upload service. Final public GET is 200, text/html; charset=utf-8, 48,561 bytes,
identical SHA256 `dcc3ec849199286316aa3d46d56b12fd55611ffdd1aa77572ed054190230c248`.

Public review URL:
https://resource.vyibc.com/dsh-task-console_prototypes_task-execution-focus-v1-20260914.html

Verification: `python3 scripts/test-execution-focus-prototype.py` against a
loopback static server, then `DSH_PROTOTYPE_URL=<public URL>` with the same script.
Both passed: desktop/mobile overflow, role selection, Trace types and I/O, raw
snapshot, fullscreen inspector, creation-order replay, blocked/passed outcomes,
HTML preview, JSON download, session conversations, autoplay, execution switching
and dark theme. Zero page errors; only the HTML GET, no API/subresource requests.
Local page load 118ms; public measured 1652ms on this machine, not a guarantee for
other clients or an optimization of the real production plugin. Screenshots were
visually inspected. Fixed mobile wrapping/fit and captured completed transitions.

No dependencies, build directories or download caches were installed. Test JSON
downloads were deleted by the test; Playwright temporary profiles are disposed.
Five final `/tmp/dtc-focus-prototype-*.png` screenshots (549,654 bytes total) are
temporarily retained as review evidence; regenerate with the committed script
and remove after UI review. Local preview server is stopped at closing. The HTML
and test remain source, not disposable generated files.

## 2026-09-14 — V2 narrows scope to compact layout, preserves original interactions

User rejected the breadth of V1: preserve the existing Sessions side drawer and
the existing inline collaboration plan, keep secondary evidence collapsible,
and make the execution page single-screen. Do not interpret this as approval to
replace or deploy the live plugin. The confirmed scope is recorded in
`prototype/task-execution-compact-v2-scope.md`.

Read original `WorkflowPlan.tsx`, `DynamicTaskReplay.tsx` SessionDrawer and the
corresponding CSS before designing V2. Preserved inline 协作计划 / 本次输入 /
计划 JSON; creator conversation and Trace links; Related Sessions right drawer
with authoring/run groups, Trace, back-to-list and open-session actions; original
row inspector; report, Canonical task_events and full task/runtime boundary
information. The prototype's open-session links open only a separate mock view
of the same static HTML. No native session is created or requested.

The only layout changes are compact header/creation/statistics, a dominant DAG,
bounded inline plan and bottom evidence areas, and internal scrolling rather
than document scrolling. Plan/bottom sections are mutually exclusive to retain
canvas room. Fullscreen keeps the inspector; Escape closes a session drawer
without also exiting fullscreen. Runtime IDs/lease remain accessible but folded.
Complete boundary content includes the user request, target, workspace, role
responsibilities, timeout/failure policy, preservation/forbidden operations,
Vault account selection and original browser-1/2 20-minute acceptance. All are
explicitly fictional sample records; no TaskSpec or operational claim is changed.

Browser testing caught and corrected the initial selector typo in the new
inline-plan handler and insufficient canvas room in short landscape windows.
Final script `scripts/test-execution-compact-prototype.py` passed locally and
against the published URL. It checks 1440x1000, 1366x768, 1920x1080, 390x844,
390x667 and 844x390 document bounds, actual internal scrolling, all plan tabs,
right drawer geometry/grouping, Trace requests/responses, isolated mock session
tab, unchanged replay cursor after drawer closing, fullscreen inspector and
Escape behavior, all three evidence sections, creation/link replay, autoplay,
blocked/passed examples, download disposal and dark theme. Zero page errors;
all requests are GETs to the same prototype document, including mock-session
query parameters. No API or external dependency requests. Local measured load
179ms, public 1751ms; these are not performance results for the real DSH plugin.

Vault service:github and service:suqu-api were freshly read in memory. GitHub
read-only checks verified ChangfengHU and push permission for the existing
repository. Verified configured upload host, public domain and 404 for the new
basename before upload; checked the returned image_url/object_key rather than
guessing a path. Public GET is 200, text/html; charset=utf-8; 82,328 bytes and
SHA256 `d0cb20a0a320f0ba2593e5899b93727831d51282dbc2c1e9d417cfd461cd4ef8`,
byte-identical to the source HTML.

Public V2:
https://resource.vyibc.com/dsh-task-execution-compact-v2-20260914.html

Only prototype, scoped design document, test and these continuity records changed.
V1 remains intact. No plugin build/restart/deployment, target operation, task
prompt, permission update, database write or schedule change occurred.
No dependencies/build caches were installed. The test deletes its downloaded
demo JSON and disposes browser contexts. Eight final `/tmp/dtc-compact-v2-*.png`
screenshots (1,006,333 bytes) remain temporarily for design review; reproduce
with the committed test and remove after review. The loopback preview server is
stopped at closing. Production runtime files and existing evidence are untouched.

## 2026-09-14 — Approved V2 execution layout, 0.30.23

The user approved implementing V2 in the existing plugin. This supersedes the
prototype-only scope above, without authorizing workflow/permission changes or
direct machine operations. Agent/Board remain one plugin. No new task, service,
schema, role, schedule, installation or login operation was introduced.

Reused DynamicTaskReplay, WorkflowPlan, SessionDrawer/TurnLedger, ExecutionPicker,
TaskRunAction, ArtifactDelivery and PatrolEvidence. The layout-specific stylesheet
applies only while the database execution view is mounted: compact header and
inline counters, remaining-height DAG, scrollable original inspector, local
plan/report/event/boundary overflow. The original plan tabs and source sessions
remain in place. Plan and bottom evidence expansion are mutually exclusive.
Canonical event selection, step/play/live projection and real Gate nodes are
unchanged. Every event retains a visible label, with full facts in a disclosure.
Fullscreen places Sessions above the graph and handles Escape one layer at a
time; narrow screens expose the same inspector as a sheet. Other pages retain
their own scrolling. Actions and all execution controls remain available.

Validation:

- `DTC_BUILD_OUT=/tmp/dtc-layout-build.67onY0 /usr/bin/node scripts/build.mjs`
  built a candidate before publication. New optional build output only selects
  a staging directory; the default still writes tracked production `lib/`.
- `DTC_LAYOUT_ASSETS=/tmp/dtc-layout-build.67onY0 python3 -u
  scripts/test-execution-layout-browser.py` tested the candidate against live
  read-only APIs. Tests caught and corrected mobile picker overflow, narrow
  landscape graph height and 390x667 expanded-plan squeezing before release.
- `/usr/bin/node scripts/build.mjs` published through the existing verified
  `/home/claude/.dsh/profiles/web/node_modules/dsh-task-console` repo symlink.
  Only `lib/client.js` and `lib/client-heavy.js` differ; host bundles are unchanged.
  Candidate and published heavy SHA256 both:
  `5290f4b31a565862dffed88bc12ded23f46882a64ceb574f4f98b6b515b561eb`.
- `python3 -u scripts/test-execution-layout-browser.py` then passed against
  the actual public service, with NO asset override. Tested 1440x1000,1366x768,
  1920x1080,390x844,390x667,844x390, expanded areas, dark palette, native session
  navigation, real Trace, fullscreen/inspector, accurate start/step/autoplay,
  Canonical rows, actual dynamic Gate/PatrolEvidence, and old HTML sandbox
  preview/download. The download is deleted by the test. Mutation endpoints
  are guarded; no execution/config writes were attempted and no page errors.
- The ended execution `b-chat-c1cfcc3f3d6db787c30e` was unchanged before/after
  each test (full graph snapshot comparison). Other regression views use an
  ended patrol Batch and existing `T-mtj1xwah` artifacts, not fabricated tasks.
- Full test suite: 293 passed, 0 failed/cancelled/skipped. Command:
  `DSH_INSTALL_ROOT=/home/claude/.local/lib/node_modules/@deepseek-ai/dsh
  NODE_ENV=test /usr/bin/node --import tsx --test --test-concurrency=1
  --test-reporter=tap test/*.test.ts`. Build and `git diff --check` pass.
- DSH PID remained 1673240 with the same 2026-09-14 06:29:02 EDT activation.
  No restart or interruption. Public cold readiness was 20.81–24.60 seconds;
  this is a remaining startup issue, not fixed or hidden by the layout work.

No dependency installation. After public verification and a /proc open-file/cwd
check finding no dependent process, removed only the uniquely owned candidate
directory `/tmp/dtc-layout-build.67onY0` (1,440,962 bytes including directory).
Recover with source/lockfile and the staging build command. Production `lib/`,
source and existing prototype evidence are preserved.
The 24 `/tmp/dtc-layout-*.png` screenshots (3,770,619 bytes, including candidate
failure evidence) are private acceptance evidence, not
public uploads of real task/session content. Keep them through review; reproduce
with the committed browser test. GitHub identity and repository push permission
were verified using Vault `service:github`, without persisting credentials.
