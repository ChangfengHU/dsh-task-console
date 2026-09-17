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

## 0.31.2 direct new-machine import

The export now seals a package-URL-bound, expiring bootstrap capability into the
same R2 JSON after the trusted Fleet service issues it. Import preview aggregates
the declared missing MCPs and Skills and offers one action that starts an
owner-only detached installer. The capability is passed through a mode-0600
file, not browser output, process arguments or logs. The installer survives the
expected DSH restart, validates registered MCP tools and Skills, then imports the
Agents and Tasks with schedules disabled.

Verification: the five focused configuration-migration tests passed, the
production bundles built, TypeScript/esbuild accepted the new RPC and UI paths,
and diff checks passed. The broader suite could not be used as a clean signal on
this host because the existing `better-sqlite3` binary targets Node ABI 127 while
the active Node targets ABI 115; failures began in unrelated SQLite tests. No
temporary dependency installation or rebuild was retained.

## 0.31.3 configuration-first import

The migration boundary was corrected after live new-machine feedback. A package
is now self-contained: every Task participant must name an Agent included in the
same package. Import upserts every packaged Agent definition first, then imports
non-conflicting Task definitions disabled. Missing MCPs and Skills are runtime
diagnostics only; they neither make an Agent absent nor block Task import. An
unavailable Skill reference remains in the Agent spec with an empty managed
Skill directory so the definition stays loadable and can be completed later.

The migration UI no longer offers or waits for runtime installation. It reports
same-ID Agents as configuration updates, shows missing capabilities as a
non-blocking notice, and always offers one complete configuration import. Same-ID
Tasks remain protected because replacing them could collide with local execution
history. Nineteen focused migration/preset tests and the production build passed.
