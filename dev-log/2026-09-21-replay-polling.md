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
