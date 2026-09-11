# Proxy MCP (optional, deny by default)

`vyibc-proxy` is packaged with dsh-task-console but runs as an independent stdio
MCP subprocess. It is not a new scheduler, Cloudflare service, or automatically
granted Agent tool. Installing/upgrading Task Console does not enable it for an
existing Agent, approve a Task, or operate a machine.

## Tools

| Tool | Input | Authority / result |
| --- | --- | --- |
| `proxy_inspect` | `ip` | Allowed-node read; Controller state and explicitly historical evidence |
| `proxy_verify` | `ip`, `requestId` | Active independent network check, no routing/timezone repair; operation ID |
| `proxy_repair` | `ip`, `requestId` | Explicit per-node repair grant, approved Vault line only; operation ID |
| `proxy_status` | `operationId`, optional `after` | Same policy principal and allowed target; at most 50 events per page |

Request IDs are 16–96 letters, digits, `_` or `-`. Reuse the SAME ID after an
ambiguous call; changing action or target under it fails. No tool accepts shell
commands, local paths, credential values, configuration URLs, arbitrary endpoints,
or another caller's identity. `proxy_repair` is omitted from tools/list and denied
at execution when no node has a repair grant. A listed tool alone grants no target.

## Host setup (explicit authorization, not an install side effect)

Requirements: supported Node22 matching the package's better-sqlite3 ABI;
OpenSSH client/ssh-agent, an existing known_hosts trust record, and an already
managed node with the existing linux-clash-skill/Controller/systemd installation.
The adapter does not bootstrap missing components or trust unknown SSH host keys.

Start with the supported Node executable and the installed package path:

```json
{
  "mcpServers": {
    "vyibc-proxy": {
      "command": "/usr/bin/node",
      "args": ["/path/to/dsh-task-console/lib/proxy-mcp.js", "--config", "/private/path/proxy-policy.json"]
    }
  }
}
```

The config must be a regular, owner-only file (0600), owned by the MCP process's
user. Example values below are placeholders, not current fleet authorization:

```json
{
  "version": 1,
  "principal": "proxy-reader",
  "stateDir": "/private/path/proxy-state",
  "knownHostsFile": "/private/path/known_hosts",
  "vaultOrigin": "https://fleet.example.com",
  "vaultTokenFile": "/private/path/existing-vault-token",
  "sshResolveTokenFile": "/private/path/existing-onboard.env",
  "sshResolveTokenKey": "FLEET_ONBOARD_VAULT_RESOLVE_TOKEN",
  "nodes": [
    { "ip": "198.51.100.10", "lineId": "line-100", "repair": false }
  ]
}
```

Without `--config`, initialization/tools/list work but all operations are denied.
Configure separate protected policies/principals for readers and operators; share
the same protected stateDir for host-wide node reservations. Existing Agent tool
selection/fences remain an additional restriction. Do not put the writer policy on
a browser-manager or planner preset. Grant/review any future role changes explicitly.
No production policy, token copy, Agent grant, or MCP loader entry is created by
this feature's deployment.

Reuse the already provisioned Vault token file, and optionally the existing private
onboarding env file via the exact supported key above; no eval or shell expansion.
The narrow `fleet-onboard-vault/resolve_ssh` resolver must return the exact allowed
IP, managed `claude` account and Vault source. The desired URL AND expected exit
come from the SAME `clash:lines` row. A missing line/provider fails closed, with no
public token endpoint, root-password fallback, or stale node-cache substitution.

## Execution and safety

- Credentials are read by the adapter, not the model. The SSH key is supplied to a
  short-lived isolated ssh-agent over stdin. The source URL is carried over SSH
  stdin, never argv or public results. Temporary local directories contain only an
  agent socket and are removed. Persistent files contain policy/audit references,
  not secret values. Controller tokens stay on the node.
- SSH host-key checking is strict; current SSH configuration, proxy environment
  and arbitrary shell arguments are not inherited. The fixed remote Python adapter
  calls only the existing loopback Controller and verifier. It does not install a
  service, alter browsers, change accounts or rotate credentials.
- Repair refuses the operator's own machine ID before network changes. Healthy
  expected-source/exit nodes are independently checked and reused.
- Explicit source drift or fresh service/TUN/exit/path failure may run Controller
  `replace`, followed by `enable` only if necessary. This preserves the existing
  direct preflight, endpoint pinning and timed rollback. Inconclusive/stale verifier
  evidence alone is not a repair grant. No arbitrary provider/line switching.
- Controller connection refused can recover ONLY the existing root-owned managed
  Controller unit. Authentication failure, unknown connection failure, missing
  managed unit/script or an unfinished Controller transaction does not permit
  restart. This is bounded recovery, not a full onboarding fallback.
- A separate verifier invocation uses a fresh temporary result directory and no
  proxy environment or `--align-timezone`. Required generic/Cloudflare/Claude TCP
  and both STUN UDP observations must equal the approved exit; optional China-site
  evidence must agree when available. Source/runtime changes invalidate the check.
  Controller active/succeeded and historical result.json alone cannot pass.

## Receipts and uncertainty

The dedicated local `proxy.db` contains operations, per-node reservations and paged
events; it does not mutate the Task database. A node holds root-only receipts and
an in-flight marker under `/var/lib/linux-clash-skill/proxy-mcp` only AFTER a real
authorized call. These are audit data, not disposable install caches.

Host SQLite and node flock serialize this MCP's work across subprocesses. Existing
Controller busy checks also protect its transactions. This does NOT claim a global
lock over other tools, browser mutations, direct SSH or legacy onboarding scripts.

After lost POST/SSH results, a superseded Controller operation, or an interrupted
worker, outcome is `unknown` and its reservation remains. `proxy_status` may read
the exact remote receipt and release the reservation only when it records a
definitive quiescent outcome. It never resends repair. If the remote worker died
before writing a final receipt, explicit operational reconciliation is still needed;
do not delete the marker or manufacture a successful result. There is no blanket
exactly-once execution guarantee or automatic crash replay.

Provider, credential, SSH and receipt-reader failures cannot settle an earlier
unknown mutation. Reconciliation requires a final remote receipt explicitly
matching the operation ID; a generic blocked/succeeded reply cannot release its lock.

## Verification and remaining Task work

```bash
NODE_ENV=test /usr/bin/node --import tsx --test test/proxy-mcp.test.ts
/usr/bin/node scripts/build.mjs
```

Tests use isolated SQLite/temp directories, SDK in-memory/stdio clients and mocked
remote system/network operations. They never create a production Task or SSH to a
node. Protocol references: [stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
and [tool contract](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).

## Optional Task integration (0.30.9)

An independently reviewed browser-patrol-v2 revision may specify
`proxy: {agentId: "fleet-proxy-operator", lineId: "line-100", maxAttempts: 2}`.
Install the preset explicitly, with only the four proxy tools. Planner, browser
manager and independent reviewer receive a separate read-only proxy MCP connection.
Both connections use the same principal/state directory; their target repair grants
remain different. Plugin upgrades do not grant these capabilities automatically.

The planner freezes `proxyItems` alongside browser `items` in the same transaction.
The graph becomes planner → proxy → Gate → browser manager → reviewer → planner.
Every proxy target needs a definite outcome before handoff. A failed target remains
denied for login writes without blocking healthy targets. Unknown operations retain
their reservation; they cannot be bypassed with a different request ID or Session.

Task SQLite stores round items, requests, issues and canonical MCP receipts. Login
copy/provision/resume checks real approved-line five-path network evidence, at most
15 minutes old. Independent review is a separate role's real read-only verification,
not an executor claim. Its historical acceptance does not expire simply while waiting
for browser stability; a later adverse check, repair or pending operation invalidates
it. These facts and operation Sessions appear in persisted patrol snapshots/replay.

The mutex covers proxy MCP operations and this Task's ordered branch, not all legacy
tools or external SSH operations. No related installation Task is invoked implicitly.
Existing login stability/notification gates and prior execution history are preserved;
cron remains disabled until explicitly enabled after real acceptance. Tests and tool
availability are not proof that any production machine has been repaired.
