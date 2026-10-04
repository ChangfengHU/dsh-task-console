# Main Deployment Source Unification

## Problem
A deployment directory may combine generated host files and an independently registered frontend. Its package version and nominal repository main do not identify the whole running system.

## Decision Method
Parse enabled plugin entries without printing credential-bearing configuration. Resolve each real package path, inspect its source revision/bundle, compare compiled file hashes, and query GitHub main from the remote host. Compare package versions as well as commits. If installed source is missing, preserve the installed package and recover source; never silently replace it with an older main.

## Evidence And Reasoning
Snapshots can have unrelated Git ancestry and omit repository directories. A blind unrelated-history merge creates false add/add conflicts, while accepting snapshot omissions can delete valid main source. An explicit content baseline and per-file checks are necessary; keep omitted main paths unless intentional removal is established. Build and test the merged content before updating main. The service Node version, not the default SSH Node, determines native ABI compatibility.

## Related
See [[deployed-source-provenance]] and ../dev-log/2026-10-04-main-integration.md. A main commit is not deployment acceptance; verify actual loading and local runtime health separately.

## Date And Expiry
Recorded 2026-10-04. Recheck after changing plugin registration, snapshot packaging, native dependencies, or host Node versions.
