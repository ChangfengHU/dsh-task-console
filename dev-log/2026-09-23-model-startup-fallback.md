# Controlled Task model startup fallback

Failure under investigation: Task `T-chat-b4c6fcb369f0c20a9739`, Batch
`b-chat-70d2a9aac267e53c183f`, Run 1103. Persisted request selected
`codex-local/gpt-5.6-terra`; it failed before tools. Root cause is the pinned
Codex CLI/global model catalog mismatch, not Qwen credentials.

Host configuration adds optional `taskFallbackModel` (`provider/model`) and
`taskFallbackFromProvider` (default `codex-local`). Empty fallback disables it.
Only TRANSPORT/AUTH/RATE_LIMIT/PROTOCOL_VERSION errors before any tool call or
terminal submission qualify, once per worker Run. The same session, CAS claim,
deadline, role, tool fence and Task inputs are retained. Provider-specific effort
and output budget are re-resolved. Canonical `model_fallback` records the switch;
business failures, approval requirements and cancellation do not trigger replay.

Tests cover scoped prompt/request selection, no duplicate session/run, one-shot
fallback, preserved permission preset, cleanup and no fallback after tools.
Production still requires a zero-active deployment window and actual model/Task
and browser verification; no target-machine operations by the developer.
