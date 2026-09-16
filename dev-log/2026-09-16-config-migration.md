# Agent and Task configuration migration

Implemented `dsh-task-console` 0.31.1 configuration-only migration. Agent home
and Task home both link to the shared `#/tc/tasks/migration` page, with R2 export
and URL-based import. 0.31.1 fixes the missing Agent-page entry found in public UI.

Export allowlist: authored user AgentSpec, Agent Actions, non-archived Task
definition, Task Actions, participant order, workflow/DAG design, failure policy
and schedule definition. Excluded by construction: sessions, messages, batches,
runs, events, replay rows, artifacts, attachments, logs and credential stores.

Import is preview/apply rather than a direct write. It accepts only the configured
R2 HTTPS origin and `.json`, rejects redirects and packages over 5 MiB, verifies
the content digest, and gives the preview a single-use ten-minute server token.
Existing IDs are skipped; missing Skill/MCP/Agent dependencies are reported and
skipped. Imported cron definitions are persisted disabled and never execute.

Verification:

- 318 repository tests: 315 pass, 3 pre-existing skips, 0 failures.
- Four focused migration tests cover runtime-data exclusion, tamper rejection,
  R2-origin restrictions, credential confinement and exact post-upload bytes.
- Production build completed and user service restarted successfully.
- Public Chrome acceptance at 1440px and 390px opened the real migration page,
  found export/import controls, had no horizontal overflow or JS errors. It did
  not invoke export or import, so no real configuration package or data mutation
  was created during UI acceptance.
- Runtime process has configured upload token, endpoint and public-domain names;
  values were not printed.

Temporary build directories under `/tmp/dtc-config-migration-build*` were removed
after the final production build; they are reproducible with `npm run build` and
`DTC_BUILD_OUT`.
