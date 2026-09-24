# Configure the packaged Studio helpers

After installing the DSH Task Console package, run its local configuration command with existing host paths:

```sh
node /path/to/dsh-task-console/scripts/configure-studio.mjs \
  --output '/home/alex/private/studio-host.json' \
  --runtime '/home/alex/render runtime' \
  --profile '/home/alex/.dsh/profiles/web/cordis.patch.yml' \
  --vault-token-file '/home/alex/private/vault-token' \
  --cache-root '/home/alex/private/observation-cache'
```

This defaults to a dry run. It verifies the package's helper/import and role-file hashes, checks that the supplied local files/directories and renderer package files exist, and prints the proposed configuration. Profile and token contents are not read. It does not contact providers or install dependencies, roles or credentials.

Add `--install` to create the proposed config atomically with mode `0600`. The output parent and cache directory must already exist. An existing output is always refused, including an identical file; use a new versioned output path to preserve the previous configuration. No DSH profile or service is modified.

Point the existing DSH Task Console plugin configuration at the result:

```yaml
config:
  studioConfigPath: /home/alex/private/studio-host.json
```

The command also prints this exact configuration field. The host rejects a missing or malformed explicitly selected file. Omitting the field retains the legacy package-adjacent lookup.

If genuine calibration evidence is available, supply both `--calibration-path` and `--regression-path`. Missing proof files are reported as missing; present files remain unverified until the existing host calibration checks validate their contents. The command never creates calibration records or declares a render, provider, role installation or video-quality check passed. Node/Chrome/ffprobe availability and actual rendering still need host verification.

## Install the six role definitions

The Task Console RPC namespace exposes `studioRoleInstallPlan()` and `studioRoleInstallApply({expectedPlanSha256})`. Use the host's ordinary JSON RPC envelope. The first method returns a read-only plan and its hash; the second recomputes that plan before creating missing roles. It accepts only the plan hash: preset paths, skill roots, MCP references and registry authority come from the host, not request parameters.

An identical existing role is kept. Customized, damaged or symlinked roles are reported as conflicts and preserved. Missing skills, unavailable MCP tool enumeration and absent transport references remain explicit blockers; installation does not silently remove tools. Model selection inherits the host default. Installation copies role definitions and selected skills with the existing preset writer, and references host MCP entries without copying credentials.

This installs definitions only. Provider health, rendering, observation calibration, Task creation and final video quality remain separate checks. No Task or publication is started. These RPCs do not yet add a setup button to the browser UI.

## Create a Studio plan in an ordinary Creator session

Read `task_create_context` for the actual installed roster and the same-source `studioCreationContract.request`. Use `task_create_studio_sources({query})` to find real character IDs, then `{characterId}` to read the full current profile and reference candidates. This read-only tool uses the host's existing `vyibc-cartoon-assets` connection; the model cannot supply transport credentials or a different endpoint.

A reference card must be linked to that character, have `kind: reference`, use an HTTPS `cdn.vyibc.com` source URL, and contain `technical.studio_reference` with `schema: studio-reference-v1`, `character_id`, and the video's explicit `sha256`. A card's own ID/hash is not the video hash. Missing references are returned as missing. Metadata discovery neither selects a baseline nor approves its quality or publication rights. The Creator may submit the selected candidate URL and its source-declared expected SHA-256 unchanged in a pending-review draft; it does not need a download tool before submission. The saved resolution explicitly reports `verifiedByComposer: false`, `downloadVerification: pending_host_preflight` and `baselineApproval: not_established_by_composer`. Missing metadata must be resolved, never invented. Before production, host preflight must download the actual reference bytes and match the expected SHA-256; failures remain blocking. Actual reference observation is subsequently required. A matching hash proves byte identity, not user approval or video quality.

Submit `task_create_submit` with a JSON plan containing only `decision: create`, `reason`, and `studioRequest`. The request supplies the resolved character/reference, six distinct installed role IDs, and explicit authorized generation limits; the topic may be omitted for autonomous selection. The host builds the complete pending plan and a reusable topic Action. The composer supports zero to two repair rounds, does not silently lower larger requests, and preserves bounded execution retries. Independent plan review remains required; submission does not start production or authorize publication.

Existing Creator presets with a frozen tool fence need an explicit capability audit and regeneration before opening a new session with the new source-discovery tool. A bundle upgrade alone does not grant newly added tools to an old saved preset. Preserve authored customizations when regenerating; report unexpected drift instead of overwriting it.
