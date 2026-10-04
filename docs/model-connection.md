# Model connection evidence in the session ledger

The existing `sessionTurns` endpoint now includes `connection` at session and turn level. This is a read-only fold of persisted or live session events. No new model requests, timeouts, task retries, paid operations, or host configuration changes are made.

States: `unknown` (no sufficient evidence), `active` (observed model output/request), `reconnecting` (Codex error explicitly says `willRetry:true`), `failed` (explicit `willRetry:false` or failed turn end), `resumed` (subsequent model text/reasoning or tool/action request), and `ended` (turn ended without terminal failure). A terminal failure stays terminal within its turn. Starting a new turn clears prior connection state. Reaching a displayed retry limit alone is not terminal evidence. Missing retry metadata is not guessed.

The projection only exports status, reason category, event/progress timestamps, and exact numeric reconnect attempt/limit. It does not export error message/details, raw Codex snapshots, thread IDs, or request credentials. Existing transcript/tool previews are unchanged; this is not a transcript-wide secret scrubber.

Context injection, inbox updates, request context, lifecycle notifications and tool results do not establish model recovery. A `resumed` status proves additional model output or action, not successful production, artifact quality, or delivery. The elapsed counter in the UI describes ended-turn wall time including waiting, not productive model execution time.

Evidence reused: `../autonomous-studio/CODEX_TRANSPORT_AUDIT.md` (2026-09-21), plus the pinned local adapter `src/protocol.ts` Codex action envelope. No provider configuration remedy is claimed. Tests cover the actual block-end error envelope, redaction-by-allowlist, context false positives, resumption, terminal behavior, new turns, and both endpoint log sources. Client build is validated locally; live deployment is outside this change.
