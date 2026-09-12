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
  A blank composer may inherit DSH's selected preset; an explicit Agent selection
  may choose another role before the conversation starts. An existing different
  role's session does not expose that other role's Actions.
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

## Verification

```sh
NODE_ENV=test /usr/bin/node --import tsx --test --test-concurrency=1 test/*.test.ts
/usr/bin/node scripts/build.mjs
DSH_ACTION_SMOKE=1 python3 scripts/test-agent-actions-browser.py
python3 scripts/test-agent-actions-tabs-browser.py
```

The opt-in public smoke test requires the installed Playwright/Chrome environment.
It creates a uniquely named **tool-free** Agent, exercises config CRUD, clearing,
role isolation, inline placeholders, keyboard navigation, premature-send blocking,
new/current-session dispatch and desktop/mobile views, then removes only that
preset. Its two-message native session remains as evidence. It does not operate
Fleet hosts or modify business Agents/Tasks. `DSH_ACTION_BASE` and `DSH_ACTION_RPC`
override the test's browser URL and authorized native RPC endpoint.

Restart the production host only at a freshly verified zero-active-session,
zero-active-Task-Run/browser-operation/proxy-operation boundary. Scheduled business
Tasks and their historical records must not be changed to deploy this UI feature.
