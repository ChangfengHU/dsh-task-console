# Replay polling follow-up

Serial DAG and Trace polling prevents overlapping slow requests, pauses hidden
pages, stops after disposal/terminal results and retries transient DAG failures.
Switching execution/session clears stale evidence before rendering the new one.
Run evidence is indexed in one event pass instead of rescanning events per Run.
All graph rows/events and existing replay controls are retained.

Six focused polling/graph tests pass in the studio integration build; five
polling/query tests pass in main. This is not event/Trace API pagination yet.
Public-origin DOM loaded in 6.14 seconds in one fresh Chrome sample but still
displayed Loading plugins; this is not a task-page-ready measurement.
Production has an active Run, so host restart is deferred to avoid interrupting
user work. Deployment/browser acceptance must be reported separately.

## Client hot deployment

Merged current studio host 2b9c380 (including concurrent Qwen changes) into the
integration branch as 465970e before building. 35/36 broader integration tests
pass; the remaining saved-calibration test requires the absent
../autonomous-studio/evidence/speech-calibration.json fixture. No gate was relaxed.
Hot-deployed only client-heavy and the frontend entry; HMR publishes the new hash.
Live host PID 1213999 unchanged; active video production was not interrupted.
Fresh public Chrome loaded the Board in 48.75 seconds with no JS errors and
requested heavy SHA256 da9defa6c9c5d507327b707011297da457e1a3513a9b718b527ff3ee3114cb58.
This verifies new client delivery, NOT resolution of public bootstrap latency.
Host evidence indexing and selected Agent first-use fix remain staged.
