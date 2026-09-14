# Agent Actions

An Action is a saved, parameterized **user prompt**, not a tool, permission grant,
workflow or Task. The existing Agent handles it through its normal model, skills,
MCP fence and host policy.

## Use

- In an Agent session, type `@`. Only that session's confirmed Agent contributes
  Actions. Select one to fill its prompt **directly in the native composer**;
  there is no Action modal or parameter form. The first `【parameter label】` is
  selected for typing. Enter/Tab advances; Shift+Tab goes back; Shift+Enter retains
  native newline behavior. IME confirmation does not advance a field.
- Enter on the final field only finishes filling. Another Enter or native Send
  submits the editable prompt as a normal user turn in **the same session**.
  Unfilled markers prevent sending, including by the Send button.
- In a new-session composer, type `@`, select an Agent with Actions, then choose
  an Action or an ordinary message. Only explicit send creates the role session.
  A blank composer may inherit DSH's selected preset, but inheritance/reusing a
  blank session is **not explicit selection**: bare `@` shows Agents/Tasks/Files,
  not that preset's Actions. Explicitly choosing the native hero's Agent chip also
  confirms that blank session's role: bare `@` then directly shows its Actions,
  invoked in the same Session. Re-selecting the already displayed role counts,
  without a redundant host write. Alternatively pick the Agent in `@`; its
  `@agent-id/` submenu shows only its Actions. Clearing that submenu choice hides
  its Actions again. Existing
  nonblank sessions use their actual role; other-role Actions remain hidden.
- Agent → **Actions tab** supports create, edit, copy, delete and a
  separate **Save Actions** button. Saving the Agent's normal configuration does
  not replace its Actions. Templates must reference every configured parameter.
  The default Configuration tab keeps identity and tool/skill settings first.
  Actions mount only when opened; switching tabs preserves both editors' unsaved
  drafts. `#/tc/agents/<id>?tab=actions` is a reloadable/shareable direct link.
- Selecting/editing/clearing a draft never executes. An uncertain send is not automatically retried;
  check the native session before submitting again.

Parameters support text, finite numbers and booleans, required fields and optional
defaults. Numeric fields can require integers and a minimum. `{{key}}` substitution is one pass, never JavaScript, shell or recursive
template evaluation. Store reusable intent here, **not credentials**. Secrets in
user-entered prompts retain the ordinary DSH transcript/Trace privacy boundary.
All applicable parameters, including defaulted ones, appear as visible `【label】` fields. The
hint shows `index/total` and the configured default. Enter/Tab accepts an unchanged
default before advancing; typed numbers/booleans override it. Final-field Enter
only finishes filling. `acceptDefaultOnEnter: false` requires explicit typing or
choice instead of accepting an untouched default; native Send cannot bypass this.
Omission retains the earlier default-acceptance behavior.

## Configurable candidates and conditional parameters

Each parameter's **输入行为** disclosure in the Actions editor configures these
behaviors without an invocation form. The native draft remains the only input:

- `choices`: 1–30 fixed text choices. Select with ↑↓ then Enter, or click; a typed
  value must match a configured choice. Initial focus shows all alternatives,
  including when revisiting a filled field. Typing filters the list.
  Keyboard navigation waits for the native textarea's matching draft revision
  before mounting choices, so Enter accepting a default opens the next field's
  list automatically without a mouse click.
- `source`: a registered read-only adapter (`fleet.nodes` or
  `fleet.gemini-accounts`). Candidate pages contain at most 20 items with search,
  loading/error/empty states and retry. No default first-machine selection.
  A new IP may be typed even if it is not in the known-machine suggestions.
- `dependsOn`: earlier parameter keys. Editing their effective values invalidates
  the dependent selection, including after draft refresh. For the current account
  adapter, the first dependency is the target IP parameter; this is not a target
  browser number and never invents a browser instance for source ranking.
- `visibleWhen: {key, equals}`: one equality check against an earlier parameter,
  not an expression language. When false, `inactiveValue` (default `无需指定`)
  replaces the marker in the prompt, and navigation skips it. Changing back
  restores an empty marker, never a stale account. The parent/child fields must
  occur once and in dependency order in the template; labels are unique.
- `integer`, `min`: numeric validation. Defaults must obey the same type, choices
  and numeric limits as typed values.

The browser-manager starter uses count=1; login mode defaults to
`按账号分配策略`, with `指定账号` and (for creation) `不自动登录` alternatives.
Only the specified-account mode asks for an account source. Its popup displays
full email and, on Vault v2, one row per authorized stored account with current
version and holder IP/browser counts. The selected value includes stable accountId,
not cookies or a requirement that a source browser be online. Templates instruct
the Agent to pass accountId into browser_login_provision; unavailable IDs must not
be silently replaced. Legacy deployments retain source-browser choices.
For example, its account parameter is configured as:

```json
{
  "key": "account", "label": "指定账号来源", "type": "text", "required": true,
  "source": "fleet.gemini-accounts", "dependsOn": ["ip", "login_mode"],
  "visibleWhen": {"key": "login_mode", "equals": "指定账号"},
  "inactiveValue": "无需指定"
}
```

The optional Fleet adapter resolves the **host-owned** `fleet-browser` MCP entry's
absolute `server.mjs` path and reuses its adjacent `transport`, `runtime.policy`,
`inventory.browserInventory` and `login.rankLoginSources` exports. Those modules
belong to the browser-manager deployment; no workstation path, service origin,
token or account policy is baked into Action JSON or the generic input controller.
Other deployments without this adapter layout show an unavailable-source message.
Adding another provider requires registering and reviewing a host read-only
adapter, not accepting arbitrary URLs, JavaScript, module paths or MCP tool names
from Action configuration.

Only GET `/api/fleet` and paginated GET `/api/fleet/login-accounts?view=discovered`
are used. No SSH, refresh POST, verification, cookie export/import or MCP mutation
is invoked by selection. Concurrent reads coalesce and metadata is cached for five
seconds; policy and freshness ranking are reapplied. Fleet-scoped deployments read
the authenticated lightweight `/api/fleet/registry` for membership instead of old
per-IP/instance grants. Explicit-mode deployments retain those grants. The current
Agent must already have the corresponding registered tool:
`browser_fleet_inventory` or `browser_login_candidates`. Missing permission and
MCP-not-ready are reported separately; this feature does not create grants.

Account exclusions and source admission come from the MCP's own policy/ranker.
Explicitly excluded/ungranted accounts are omitted; busy/unknown-identity/limit
failures cannot be selected. A stale discovered identity may be selected as
**intent**, labelled `待执行前复验`, never as verified-current login. Submission
re-reads candidate metadata/admission and rejects a disappeared or newly denied
source. Actual execution must independently verify the account, source and each
target's transfer grant. Automatic policy mode sends no prechosen account and
does not query account candidates. Neither choice nor preview reserves an account
or claims that any browser has logged in.

Popup replies are discarded on draft/role/session changes; Escape closes it and
IME composition never accepts a candidate. Restored conditional ranges keep the
same position-only persistence contract. If legacy metadata is missing, recovery
does not guess filled parent values or silently erase a visible dependent field;
an applicable dependency whose coordinates cannot be recovered requires reselecting
the Action and keeps the original text. While its catalog is still loading, the
light entry tracks native range changes and edited field indices (no values).
Once the current catalog arrives, dependent selections are invalidated before the
claim becomes usable. This also covers edits to an already-completed draft after
refresh. Focus waits for a matching native DOM revision with bounded frame retries;
new typing or a later selection cancels that focus request.

## Storage and API

### Task-owned Actions (0.30.22)

Chat-created reusable Tasks have a separate `#/tc/tasks/:id/actions` editor.
`@Task` first opens that Task's Actions; selecting one fills the same native
composer and placeholders as Agent Actions. Defaults, conditional fields and
candidate providers are reused. Task fields are typed inputs: changing static
template text is rejected on send; edit the Task's Actions configuration instead.
The final placeholder Enter only finishes editing; a subsequent Send submits.
Default Action means first in the list, never automatic execution.

Submission uses `launchTaskAction({taskId,actionId,revision,values,requestId,cwd?})`,
not `session.prompt` or `startAgentSession`. The existing TaskCreator and runner
create one Batch on the same Task and only its internal role Sessions, then the UI
navigates to `#/tc/tasks/:taskId/runs/:batchId`. No normal conversation is created.
The tab-local request ID survives refresh and failed delivery. An accepted retry
returns the same Batch even if the Action has since changed; changing inputs with
that ID is rejected. Selecting the Action again is an explicit new invocation.
Existing reviewed cron overlap/role checks remain in force; Actions do not modify
or silently enable schedules. Legacy Tasks without Actions retain their old entry.

`taskActions({taskId})` and `saveTaskActions({taskId,actions,revision})` use
`dsh_task_action_catalog` in the existing SQLite database, with revision CAS.
`dsh_task_action_requests` records submission deduplication, not another scheduler.
Actions are not part of TaskSpec or its reviewed definition/hash. Empty catalogs
stay empty; installing `presets/fleet-task-actions.json` is an explicit CAS save,
never a migration that overwrites user configuration. The editor supports create,
copy, delete, disable, one default, schema controls and non-executing preview.

Task parameters can declare `binding`: `target-ip`, `ssh-user`, `ssh-password`,
`gemini-account`. The exact target comes from the bound IPv4, not all IP addresses
mentioned by candidate labels or prompt text. First-login credentials are stored
only in the existing mode-0600, 24-hour batch private input mechanism; they are
redacted in Task events/turns. Native composer drafts still contain what the user
types: this is not a masked secure credential form. No password default is allowed.
Each Batch freezes `turn.action` with the Action identity/revision/schema/template
and safe parameter values. See it under “创建与编排 → 本次输入”; editing Actions never
rewrites a historical execution.

Task candidate reads require the matching read capability on a participating
Agent, not the unrelated role of the current conversation. Only the existing
fixed metadata providers are callable. `fleet-base-v2` may select a Vault account
intent for a not-yet-registered IP; this grants no node access and allows no live
browser fallback. Runtime MCP policy still checks actual admission and inventory.
With an explicitly bound Gemini account, the trusted Task login fence rejects
wrong targets/accounts and live-browser copy; resume must refer to a matching
stored operation. It narrows, never expands the existing role/MCP permissions.
Healthy unrelated logins and the original dual-browser 20-minute gate remain intact.

Creator's context now supplies the Action contract and Fleet example. Its public
`task_create_submit` requires Actions on new plans; reuse/revise cannot overwrite
the current Action catalog. Independent review displays and hashes the proposed
Actions. Only approval installs them, idempotently, alongside the new Task.
Legacy saved plans remain readable/reviewable. No new Agent permissions are granted.

`scripts/test-task-actions-browser.py` uses the real native browser UI with clearly
labeled intercepted Task API fixtures: it exercises selection isolation, keyboard
defaults and Vault candidates, refresh, failed-delivery retries, successful route
navigation, lazy configuration/preview and responsive layouts. It never dispatches
a production Task. Real SQLite/scheduler integration is separately covered in the
runner tests. A real installation requires a separately confirmed target.
`scripts/test-task-actions-live-browser.py` reads the installed Task catalog and
real Fleet/Vault candidates with every execution/config mutation blocked. It
preserves the original session history and catalog. Mixed-version static/host
deployments expose Task Actions only when workflow metadata advertises support,
so the older host's execution entry is not broken while waiting for a safe reload.

Each preset may have `actions.json` next to `task-console.json`:

```json
{
  "version": 1,
  "actions": [{
    "id": "inspect-login",
    "name": "检查登录",
    "description": "只读验证浏览器登录",
    "template": "请只读检查 {{ip}} 的浏览器登录，报告证据时间。不要执行修复。",
    "parameters": [{ "key": "ip", "label": "机器 IP", "type": "text", "required": true }]
  }]
}
```

No Actions are added to `AgentSpec`, its composition, or the profile hash used by
Task review. An empty file does not restore deleted defaults automatically.
The browser-manager starter pack is `presets/browser-manager-actions.json`; merge
it explicitly through `saveAgentActions` when installing, never overwrite existing
user Actions. It references no fixed host or account. Creation/deletion/login still
require the deployment's MCP scope, exact operation targets and existing skill acceptance rules.

Authenticated native `taskConsole` RPCs (standard string JSON argument/result):

- `agentActions({agentId})` reads config and writable status. `{sessionId}` instead
  resolves the actual role from lightweight native headers, not an ID prefix or
  transcript. A supplied mismatching `agentId` is rejected.
- `saveAgentActions({agentId,actions,revision})` only writes a user-owned preset
  in the configured writable root. Revision is the hash returned by the read API;
  stale saves fail. Writes use an atomic sidecar rename and serialize with normal
  preset replacement/deletion inside the host process.
- `prepareAgentAction({agentId,sessionId?,actionId,values,revision})` validates the
  current configuration and actual role and renders the message. It does **not**
  create a session, send a prompt, call tools or create a Task.
- `agentActionOptions({agentId,sessionId?,actionId,revision,parameter,values,search?,page?})`
  reads an existing parameter's registered metadata source. Role, revision,
  parameter, conditional applicability and read-tool visibility are validated;
  only configured dependency values reach the adapter. Returns
  `{items:[{value,label,detail?,disabled?}],page,pages,total,notice?}`. It is not a
  general-purpose tool execution API and cannot create a Task or Session.

The browser then uses native `SessionFace.prompt(..., 'queue')` for an existing
session or `startAgentSession` for a new one. The Action name/id and rendered prompt
are visible in the normal conversation; parameters are not stored in the sidecar.
Action selection uses native command claims and the session-owned input facade,
including draft persistence/undo. DOM access only selects text; it never writes
the textarea value. Async candidate responses are discarded after a session/role
switch, and role plus sidecar revision are rechecked before dispatch. An Action
is a prompt convenience, not a substitute for the Agent's tool authorization.
Placeholder ranges track edits inside the selected field before falling back to
a whole-draft diff: a typed delimiter identical to the following template text
must not be attributed to the next field. Regression coverage includes typing,
undo/redo, required-field Send blocking and Chinese IME confirmation.

## Refresh and native host integration

The native composer remains the only prompt store. Tab-local `sessionStorage`
under `dtc:action-draft:<sessionId>` contains just Action IDs/revision, prefix,
range coordinates and filling progress with a non-security staleness checksum;
it does not duplicate user-entered parameter values or confer any permission.
Clearing/cancelling the draft removes its metadata. Refresh/revisit revalidates
the actual session role, current Action revision and native draft revision, then
restores a native command claim and the edited ranges. A saved Action revision or
owner mismatch keeps the draft and refuses sending. Older drafts or unavailable
metadata recover remaining literal markers without guessing ranges for filled
free text. They do not overwrite the user's edited prompt.
Empty pre-hydration shells do not start lookups; if hydration/typing supersedes an
in-flight lookup, discard the stale result and re-check the latest draft revision.

DSH `0.1.1-rc.2` natively re-adjudicates `/` but not `@` on plain-draft submission.
Restoring text alone therefore bypasses Action guards. The version-fenced
`scripts/patch-input-menu.mjs` extends native adjudication to leading `@` **only
while this plugin is mounted** (`data-dsh-task-entry`). Both keyboard and Send use
that same native state machine. If restoration is still pending, the first
Enter/Send restores editing instead of falling through to a normal model prompt.
No refresh automatically sends, creates a Task or operates an Agent.

The same installer corrects native menu default focus: late async results choose
the first visible group until the user explicitly moves; late results cannot
steal a deliberate highlight. Files retain their native keyboard ordering.
These patches reject unknown/partial source anchors, are idempotent, and are wired
into the existing host patch script. On a verified supported host installation:

```sh
DSH_INSTALL_ROOT=/absolute/path/to/running/dsh node scripts/patch-input-menu.mjs --check
DSH_INSTALL_ROOT=/absolute/path/to/running/dsh node scripts/patch-input-menu.mjs --apply
```

The exact native `lib/client.js` files receive exclusive original backups:
`dsh-client-ui-input-trigger` → `.dtc-menu-focus-backup`,
`dsh-client-ui-conversation` → `.dtc-action-submit-backup`. Preserve these runtime
rollback sources. A host upgrade needs source/version revalidation, not a blind
reapply. Neither patch changes backend permissions, stored Sessions or Tasks.

The same version-fenced installer also bridges the native Agent chip's **applied**
choice to Actions (`dsh-client-ui-agent-preset` → `.dtc-action-role-backup`). This
reports only a matching blank role or a successful host selection, including a
staged choice when its blank session appears. Loading the inherited default,
failed selection and attempting to switch a running session do not confirm a role.
`dtc:action-role:<sessionId>` in tab-local sessionStorage stores only the chosen
Agent ID. Refresh retains it; a new-session entry or native owner change clears
it. It is UI intent, not authority: current selection, real header and backend
role checks still apply. Old blank sessions without this UI evidence need one
explicit chip choice after upgrading, never a guessed confirmation from the label.

## Verification

```sh
NODE_ENV=test /usr/bin/node --import tsx --test --test-concurrency=1 test/*.test.ts
/usr/bin/node scripts/build.mjs
DSH_ACTION_SMOKE=1 python3 scripts/test-agent-actions-browser.py
python3 scripts/test-agent-actions-tabs-browser.py
python3 scripts/test-agent-actions-keyboard-browser.py
python3 scripts/test-agent-actions-recovery-browser.py
python3 scripts/test-agent-action-options-browser.py
python3 scripts/test-agent-actions-native-role-browser.py
```

The opt-in public smoke test requires the installed Playwright/Chrome environment.
It creates a uniquely named **tool-free** Agent, exercises config CRUD, clearing,
role isolation, inline placeholders, keyboard navigation, premature-send blocking,
new/current-session dispatch and desktop/mobile views, then removes only that
preset. Its two-message native session remains as evidence. It does not operate
Fleet hosts or modify business Agents/Tasks. `DSH_ACTION_BASE` and `DSH_ACTION_RPC`
override the test's browser URL and authorized native RPC endpoint.
Set `DSH_INSTALL_ROOT` in the test process to exercise the **actual supported
native reducer and input machine**, not just the patch fixtures. The keyboard and
recovery scripts reuse existing sessions and never deliver a business prompt.
Recovery covers refresh midway through typed fields, Send with missing values,
session switch/back, reused blank roles, explicit Agent choice, old drafts without
metadata, and an explicitly requested final dispatch intercepted before delivery.
That last check proves routing, not execution of any browser operation.
The options script reads real machine/account metadata and tests search, default
count, positive integers, conditional account selection, parent invalidation and
refresh. It separately labels simulated pagination, failure and delayed-response
tests; a forced catalog delay also edits a completed draft before configuration
recovery and checks pending range tracking plus dependent-field invalidation.
The native-role script reuses a blank acceptance session, selects the displayed
role through the real hero menu and checks direct same-session Actions, refresh
and New Session isolation. It blocks host role writes and all business sends;
different-role successful/rejected responses and staged selection are exercised
against the actual supported native controller in unit tests. The keyboard script
explicitly accepts the numeric default, then asserts all next-field options are
visible without pointer interaction; a typed count alone does not cover this race.
Those fixtures never reach Fleet. All business-send requests are blocked
before delivery. Desktop/mobile screenshots are local acceptance evidence, not
public artifacts containing private session history.

Restart the production host only at a freshly verified zero-active-session,
zero-active-Task-Run/browser-operation/proxy-operation boundary. Scheduled business
Tasks and their historical records must not be changed to deploy this UI feature.
