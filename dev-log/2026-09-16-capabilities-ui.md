# Capabilities tab visual refresh

## 2026-09-16

The conversation Capabilities tab now presents the unchanged host-owned runtime
snapshot as a compact dashboard: live/history state, role, checked time, tool
and Skill counts, plus readable tool and Skill cards. Inheritance policy, the
authored role definition and the last observed model tool list remain available
under a collapsed diagnostics section. No MCP, Skill, credential, authorization,
or endpoint behavior changed.

`npm run build` completed. The read-only public browser candidate acceptance
rendered desktop and narrow layouts using the built client fixture: two capability
reads, no page errors and no business writes. The full Node suite was not usable
on this machine because the installed `better-sqlite3` binary targets a different
Node ABI; dependencies were not rebuilt or replaced.
