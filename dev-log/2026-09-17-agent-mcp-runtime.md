# 0.31.4 — restore scoped Agent MCP registration

## Problem

Fresh browser-manager sessions declared the Fleet browser and read-only proxy
tools, but the request header contained only native tools. The capability
snapshot correctly classified all 19 scoped MCP tools as configured but not
registered. The local stdio MCP entries did not declare the transport now
required by the host MCP client, so their processes never started. After that
was corrected, a preset child scope also could not see the authoritative host
loader entry referenced by `sourceEntryId`.

## Change

- Resolve an unavailable child-scope `sourceEntryId` through the host
  task-console service while keeping transport credentials in memory.
- Declare the existing local MCP processes as stdio transports in the runtime
  profile; no credential or transport value is copied into an Agent preset.
- Keep rejecting missing, disabled, or non-official MCP entries.
- Add regression coverage for child-loader isolation.
- Remove the unrelated `awesome-novel` Skill accidentally imported into the
  live browser-manager preset; browser management remains MCP-only.

## Verification

- Targeted Node 22 tests cover filtered MCP resolution and preset generation.
- A new browser-manager session (`agent-browser-manager-mu4yswui`) registered
  the scoped tools and completed a real `browser_fleet_inventory` call.
- Browser acceptance loaded that session, including its tool trace, through
  both supported public DSH hostnames.
