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

## Packaged compiler resources

The public payload now includes exactly seven files in `studio/runtime-assets/`: `gsap.min.js`, `Chinese.ttf`, `GSAP-LICENSE.txt`, `DROID-NOTICE.txt`, `GSAP-STANDARD-LICENSE.html`, `SOURCES.json`, and `manifest.json`. They are separate from private Task media and host calibration proofs. Package MIT licensing applies to the owned helper code, not to these vendors: GSAP retains its Standard No Charge License, and the bundled Droid Sans Fallback Full font retains its Apache-2.0 notice. Preserve the vendor notices and source records with copied resources; consult their actual terms for the intended use.

At development packaging, `packageStudio(packageRoot, sourceRoot)` reads helpers from `sourceRoot` (normally `../autonomous-studio`) and vendors from `resolve(sourceRoot, '../runtime-assets')`. It verifies the exact filenames, real regular files/no symlinks, inner byte counts/hashes/target paths, and the helper's fixed manifest SHA before writing. The outer Studio manifest hashes every vendor file, including the inner manifest, and declares `runtimeAssetsPackaged:true`. Unexpected or missing files fail verification. An installed package verifies its own payload and requires no parent checkout.

The packaged `prepare_execution_assets.py` resolves `Path(__file__).parent.parent / 'runtime-assets'` by default. Its offline CLI is `python3 <package>/studio/helpers/prepare_execution_assets.py --project-root <existing real Task directory>`; it prepares GSAP/font/notices using the fixed targets and returns actual paths/hashes. This is host setup, not an instruction to models to create arbitrary workspaces. No network, provider call or user-home default is needed. `qualityApproved` and `compilerRuntimeVerified` remain false: local resource preparation is neither successful rendering nor film approval.

The payload test uses a disposable `npm pack --ignore-scripts` tarball, verifies all seven shipped members, imports the isolated helper closure with network/subprocess effects blocked, and executes only the offline preparation helper in a path containing spaces. Full bundle build/prepack lifecycle has separate package-bundle coverage; passing this payload test alone does not claim a new build or deployment.

## Registered candidate preview upload

The native `studio_upload_preview({candidateSha256})` is available only to the active Studio executor/editor. The argument is the exact SHA of the currently registered candidate; there is no model-supplied file path, object key, URL, token or configuration override. The service resolves candidate/location through the current workflow, verifies its live claim and progress/preparation fences, and rechecks candidate identity around dispatch and before returning. Public preview delivery does not approve the film or publish to a social platform.

The private host JSON selected by DSH `studioConfigPath` may provide this complete optional group:

```json
{
  "uploadScript": "/HOST/PACKAGE/studio/helpers/studio_preview_upload_host.py",
  "uploadScriptSha256": "<actual thin-adapter SHA256>",
  "uploadLibrarySha256": "<actual sibling studio_upload.py SHA256>",
  "vaultTokenFile": "/HOST/PRIVATE/vault-token",
  "uploadStateRoot": "/HOST/PRIVATE/durable-preview-intents",
  "uploadPublicOrigins": ["https://YOUR-CONFIGURED-PUBLIC-ORIGIN"]
}
```

These are placeholders, not working credentials or origins. Host paths must be absolute. `uploadStateRoot`, helper files and credential references must be outside Task workspaces; the upload module enforces its containment and file hash checks. The library path is fixed to `studio_upload.py` beside the adapter, not another configuration input. Public origins must be exact canonical HTTPS origins, without credentials, paths or query strings. Missing or malformed members in a supplied upload group fail with a sanitized configuration error. Omitting the whole group preserves installations without preview upload; invoking the tool then reports the missing host capability. No credentials are included in tool outputs or schemas.

### Production Task startup check

`studio-video-v1` Tasks promise an R2 preview and now require a complete production installation before creating their model session. The shared `src/studio-installation-contract.json` lists the required visual/audio observers, compiler, media downloader, render job and preview uploader, their pinned hashes, renderer files, calibration files and host-owned paths. The Task service checks these locally and returns a capability block listing the missing fields/files. It does not consume model or generation calls trying to repair host configuration. Other Task types are unaffected.

This check only verifies installation, readability and the declared hashes; it does not claim provider access, actual image/audio observation, rendering, upload or video quality passed. Existing production probes and actual tool calls remain necessary. Host credential/profile references are checked by file metadata and permissions, without reading their contents. Non-production installations may still omit upload configuration, but cannot start the full Studio delivery workflow until configured.

Enable this optional group through the existing configuration composer by adding both `--upload-state-root /HOST/PRIVATE/durable-preview-intents` and `--upload-public-origin https://YOUR-CONFIGURED-PUBLIC-ORIGIN` to the normal setup command. The state directory must already exist, have no group/other permission bits (normally mode 0700), and be readable/writable by the configuring host process. The composer does not create it or change permissions. Symlink directories, missing directories, partial option groups and noncanonical origins are rejected.

The composer derives `uploadScript`, `uploadScriptSha256` and `uploadLibrarySha256` only from the verified packaged helper manifest; it accepts no helper path or hash override. It reuses the existing `vaultTokenFile` reference without reading its contents. With neither upload flag, older non-upload setup remains valid and `checks.previewUpload` explicitly reads `disabled`; enabled plans report `configured-unverified`, never connectivity or publication success. The default remains a reviewable dry run; explicit `--install` atomically creates only a new mode-0600 configuration. The shipped two-helper closure is required before upload can be enabled. No provider call, upload, dependency installation or deployment occurs during composition.

Save the actual completed URL, SHA, bytes and public-hash verification receipt with the candidate's delivery record. `unknown` retains the original intent: a same-SHA call may verify that existing public object, never issue a blind replacement PUT. A verified saved receipt is restart-reusable. The uploader does not automatically register Fleet assets or evidence artifacts; those remain explicit existing workflow actions. Editor `requiredHostTools` now includes the real tool, while existing authored presets need the normal reviewed capability sync to obtain its schema; no active session/preset is rewritten.
