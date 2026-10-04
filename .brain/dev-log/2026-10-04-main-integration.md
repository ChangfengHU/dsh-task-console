# Main Integration

The user chose the remote DSH source as authoritative and excluded the Hermes single-card rework branch. Deployment bca7c63 and main had unrelated Git ancestry but shared source content. A content merge against the recorded source baseline preserved deployed Studio execution and main onboarding diagnostics; main-only archive omissions were restored rather than interpreted as intentional deletions.

Configuration asset migration and bounded R2 transfer fixes were integrated separately. Both host and client builds passed. Focused migration/runner/onboarding tests passed 147/147; the earlier execution regression suite passed 127/127, the real Python compiler suite passed 29/29 after supplying the installed compiler path, and Studio workflow tests passed 33/33. These are focused suites, not a full-suite or production acceptance claim.

The main source commits were pushed from host 95 only. Plugin Station workbench source passed 19 tests; CLI runtime workbench source passed typecheck/build and 137 tests before its independent main commit. Native dependency rebuilding uses the service Node version; Node 20 and Node 22 ABI must not be confused.

Deployment/local synchronization is not yet accepted. Model Console installed 0.3.0 has no corresponding source in the observed remote repository (main is 0.2.2); replacing it would downgrade the running feature. Its originating source is required. Existing snapshots, credentials, sessions and databases were not deleted.

Next: resolve the model-console source origin, verify zero active sessions/claims, build each accepted main, stage activation with rollback, then publish tracked source archives and manifests to R2 for local restoration.
