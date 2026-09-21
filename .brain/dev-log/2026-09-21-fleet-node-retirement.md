# Fleet node retirement: first real DSH Agent execution

## Scope and boundary

- User-authorized target: retire the continuously unreachable Fleet node
  `host-206` / `206.189.196.65` so the Fleet UI and API no longer list it and
  other systems no longer discover its node-bound Vault or legacy access data.
- Execution owner was the reviewed DSH Task and its restricted
  `fleet-node-retirer` Agent. Development did not SSH to or mutate the target
  machine, DNS, tunnels, or remote services.
- The Agent is allowed only the Fleet status, retirement candidate/status,
  atomic retirement, and audit tools. It does not have ordinary disable,
  recycle, SSH, or general Vault mutation capabilities.

## Runtime issue and correction

The first two Task attempts had no Fleet tools because the preset selected
unprefixed MCP raw names. Production actually advertises the
`vyibc-fleet_*` raw names. The preset now selects those exact registered names
and maps the old `list_fleet` wording to the read-only `vyibc-fleet_status`
roster check. A new standalone Agent session first proved candidate discovery
without any write, then an independently reviewed revision rebound the paused
Task to the corrected role fingerprint.

The local Codex-backed creator/retirer model could not start because its app
server closed the protocol stream, so these two presets use the already
configured Qwen Plus runtime. This changes model availability only; no tools or
permissions were added.

## Real execution evidence

- Task: `T-chat-74a2ed1bccbf91f4db88`
- Reviewed revision: `P-chat-90cfe3476f0e6109e319`
- Manual Batch: `b-muarvddfoe2`
- Retirer session:
  `task-t-chat-74a2ed1bccbf91f4db88-b-muarvddfoe2-1`
- Candidate read found only `host-206`, with the server-enforced threshold met,
  51 observations, no active dispatch, and no active Runner jobs.
- Atomic retirement returned `changed=true`, `enabled=false`, Runner disabled,
  legacy `machine_access` deleted, and these exact key names deleted (values
  were never read or logged):
  - `clash-controller:host-206`
  - `dashboard:host-206`
  - `ssh:host-206-189-196-65`
- Post-write status returned `accessInventoryPresent=false` and `vaultKeys=[]`.
- Immutable audit event 6067 reports `action=retire` and `outcome=changed`.
- Read-only Fleet status lists six active nodes and excludes `host-206`.
- Public `/api/fleet` parsed successfully and contains neither the node id nor
  IP. A fresh headless Chrome DOM of `https://fleet.vyibc.com/#/fleet` likewise
  contains neither value. The temporary Chrome profile was deleted afterwards.

## Notification truth and remaining gap

The static-chain notification card attempted a direct WeCom MCP send. The
security fence correctly rejected it because Task notifications require a
reviewed recipient and durable outbox grant. The Batch was cancelled after the
retirement card had completed; its evidence remains intact. A separate visible
`wecom-notifier` Agent session `agent-wecom-notifier-muas0gpu` then queried the
single subscribed group and received a real `sent=1` delivery receipt.

Therefore the node retirement and external notification happened, but the
single-Task notification handoff has not passed. The hourly schedule remains
disabled and this task stays open until a generic, reviewed non-browser Task
notification outbox is implemented and a no-op/idempotent retry completes in
one Batch. Do not weaken the existing WeCom fence or describe the cancelled
Batch as a full workflow pass.

## Verification

- `PATH=/usr/bin:$PATH npm test`: 325 total, 322 passed, 3 skipped, 0 failed.
- `PATH=/usr/bin:$PATH npm run build`: passed.
- Production DSH service restarted only after the unrelated active video Agent
  had naturally completed.
- No credential values were written to source, docs, logs, or Git.
