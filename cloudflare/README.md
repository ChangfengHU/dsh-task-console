# DSH task kernel

Cloudflare Worker + D1 coordination kernel. It borrows Hermes' durable task/run/event semantics without copying single-machine PID assumptions into a distributed service.

## Invariants

- `tasks` is the current projection; `task_events` is append-only audit history.
- A claim is one conditional `UPDATE ... WHERE status='ready' AND version=? RETURNING ...`.
- The claim trigger creates the matching `task_runs` row and `run_handoff_inputs` snapshots in the same D1 transaction.
- Every mutation after claim is guarded by `run_id + claim_token + current task ownership`.
- Heartbeats extend a finite lease. Only an expired lease can be reclaimed; exhausting `max_attempts` fails the task.
- Dependencies use explicit edges. A claim independently rechecks every parent and pre-execution gate, so a stale `ready` projection cannot start early.
- Completion review is a gate after work, not before it. `changes_requested` closes the old run and returns the task to `ready`; approval releases downstream tasks.
- Full handoff summaries and metadata stay in `task_runs`. Events carry only audit-sized payloads.

## Core API

All `/v1/*` calls use `Authorization: Bearer ...`.

| Operation | Endpoint |
| --- | --- |
| Board snapshot | `GET /v1/boards/:id/snapshot` |
| Run context + immutable parent handoffs | `GET /v1/runs/:id/context` |
| Create board / agent / group / task | `POST /v1/boards`, `/agents`, `/groups`, `/tasks` |
| Add dependency / gate | `POST /v1/tasks/:id/dependencies`, `/gates` |
| CAS claim / stale reclaim | `POST /v1/tasks/:id/claim`, `/reclaim` |
| Worker lifecycle | `POST /v1/runs/:id/worker-started`, `/session-created`, `/prompt-dispatched`, `/heartbeat` |
| Terminal lifecycle | `POST /v1/runs/:id/complete`, `/block`, `/review`, `/resume` |
| Gate decision | `POST /v1/gates/:id/decide` |

## Develop and deploy

Use Node 22 or newer.

```sh
npm install
npm run check
npx wrangler d1 migrations apply dsh-task-kernel --local
npx wrangler dev --var API_TOKEN:local-test-token
```

Remote credentials and `API_TOKEN` must be passed through Wrangler authentication/secrets; do not put either value in `wrangler.jsonc` or a committed dotenv file.
