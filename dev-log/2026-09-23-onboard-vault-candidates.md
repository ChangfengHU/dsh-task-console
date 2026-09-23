# Onboarding Action Vault machine candidates

Scope: the Fleet onboarding Task's machine selector reads the Vault SSH directory,
not Fleet membership. Browser-manager Actions still use Fleet inventory. Manual IP
entry, workflow roles, credentials, schedules and execution history are unchanged.

Added explicit `vault.ssh-nodes`, allowed only for a `fleet-base-v2` Task's target-IP
field through the existing host metadata adapter and participant read permission.
The adapter calls only `vyibc-vault_list_configs`, never `get_config`/SSH/verification.
Canonical `ssh:host-<IPv4>` and `ssh:managed-host-<IPv4>` keys become deduplicated IP
candidates. Key material/history and free-form descriptions are not parsed or returned.
Noncanonical aliases are not guessed. Candidate existence is not proof of working
credentials or machine reachability. Existing search/pagination and 5-second bounded
cache are reused. Failures do not silently fall back to the Fleet-only list.

Ten targeted tests passed, including unregistered candidates, duplicate and invalid
keys, no secret reads, pagination/search, manual IP entry, unrelated Action rejection,
and existing browser/Task Action behavior. Integrated Studio build based on production
source 7063694a00e273c9d4a71179552987877f616f43 passed using existing dependencies.
Live Vault metadata confirms 129.213.30.236 is a candidate; no target was accessed.
Deployment and public browser acceptance are pending at this commit.

## Deployment and acceptance

Main code commit `29a59e5` and integrated Studio commit `920a57c` were pushed.
Full primary suite: 337 tests, 334 passed, 3 skipped, no failures. Integrated build
preserves live Studio source, audio/proofs, schema and UI module registration ID.
Both native sessions (`running` boolean, not `status`) and SQLite Task Runs were
zero before stopping/restarting the host. New production release is
`/home/claude/dsh-studio-migration/task-console-vault-920a57c`; source bundle and
manifest retained. Previous frontend is retained there for rollback.

Existing Task `T-chat-b4c6fcb369f0c20a9739` Action `onboard-node` was updated through
revision-CAS: only its target-IP source changed from `fleet.nodes` to
`vault.ssh-nodes`. Live RPC returns seven unique IPs including 129.213.30.236.
No workflow/permission/schedule modification or target-machine operation occurred.

`scripts/test-vault-machine-candidates-browser.py` passed against the public
`https://dsh.vyibc.com` UI: @ Task selection, Action selection, real Vault popup,
clicking the 236 candidate fills only the draft. Execution/config-write endpoints
are blocked in the test; no blocked write was attempted, no page errors occurred,
and before/after Task snapshot and Action revision were identical. Screenshots:
`/tmp/dsh-vault-machine-candidates-1440.png` and `...-390.png`.
The narrow popup works, but the pre-existing native sidebar crowds the composer
at 390px; this is not full mobile-layout acceptance and was not redesigned here.

Temporary integrated worktree/build `/home/claude/dsh-vault-candidates-build`
was removed after verification (about 5.3 MiB freed), including its 1.7 MiB generated
build and dependency symlink, not the shared dependency installation. Restore with
`git worktree add --detach <temporary-path> 920a57c`, link existing dependencies,
then run `DTC_BUILD_OUT=<staging-path> /usr/bin/node scripts/build.mjs`.
Production release, source bundle and screenshots remain; nothing references the
removed temporary worktree in the production profile.
