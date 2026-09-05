# Fleet continuation and routing safety

- Version 0.22.4 validates an idempotently reused run against its prior session before scoped CAS
  adoption. A regression test proves the same run can continue with the new session's receipts.
- Running onboarding tools explicitly return the resume action. Status/report never drive Cloud
  jobs. Installer/reviewer policies prevent completing running work or repeating empty rework.
- Task Signal receipts expose blocked DAG cards; Fleet can display the real waiting condition.
- Unscoped manual retry of a Signal task is rejected before creating a batch, preventing the
  original template's stale goal/team from being dispatched. Retry uses the source Signal path.
- Build and all 100 tests passed serially. Physical operations remain DSH-owned; tests use fixtures.
- Browser acceptance exposed an older immutable heavy bundle cached under the same candidate
  version. Version 0.22.5 includes the actual heavy-asset SHA256 in the loader URL; this keeps lazy
  loading while preventing a rebuilt version from showing the previous UI.
