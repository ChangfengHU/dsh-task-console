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
