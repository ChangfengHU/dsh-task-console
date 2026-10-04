# Retirement runtime integration

Production disables `task-console` and loads a studio deployment through the web
profile's `cordis.patch.yml`. Checking the main package symlink alone does not
establish which implementation is running. Runtime script inspection confirmed
the final-handoff change was missing from the active studio implementation.

Integrated main commit fb7168b into studio source, preserving all subsequent
studio changes through b64162c73535. Notification completion now requires the
durable outbox receipt; empty retirement candidates complete without repeated
status/audit calls. Tests explicitly reject task_complete before task_notify.

Verification: 67 runner/design/studio-tool tests passed after the latest studio
delta (one earlier concurrent run had a transient failure; the full rerun passed).
Full combined suite previously passed 141/142; the studio calibration
fixture requires deployment-local evidence and was unknown in the isolated tree.
Production end-to-end verification and scheduler activation remain pending.

Deployment must compare the active path again immediately before switching and
must not interrupt unrelated running tasks. Preserve historical execution rows.
