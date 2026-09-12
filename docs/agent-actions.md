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
  not that preset's Actions. Pick the Agent in `@` first; its `@agent-id/` submenu
  then shows only its Actions. Clearing that choice hides Actions again. Existing
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
defaults. `{{key}}` substitution is one pass, never JavaScript, shell or recursive
template evaluation. Store reusable intent here, **not credentials**. Secrets in
user-entered prompts retain the ordinary DSH transcript/Trace privacy boundary.
All parameters, including defaulted ones, appear as visible `【label】` fields. The
hint shows `index/total` and the configured default. Enter/Tab accepts an unchanged
default before advancing; typed numbers/booleans override it. Final-field Enter
only finishes filling. Native Send can accept configured defaults but cannot skip
a required value that has no default.

## Storage and API

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
require the deployment's exact instance grants and existing skill acceptance rules.

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
Both patches reject unknown/partial source anchors, are idempotent, and are wired
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

## Verification

```sh
NODE_ENV=test /usr/bin/node --import tsx --test --test-concurrency=1 test/*.test.ts
/usr/bin/node scripts/build.mjs
DSH_ACTION_SMOKE=1 python3 scripts/test-agent-actions-browser.py
python3 scripts/test-agent-actions-tabs-browser.py
python3 scripts/test-agent-actions-keyboard-browser.py
python3 scripts/test-agent-actions-recovery-browser.py
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

Restart the production host only at a freshly verified zero-active-session,
zero-active-Task-Run/browser-operation/proxy-operation boundary. Scheduled business
Tasks and their historical records must not be changed to deploy this UI feature.
