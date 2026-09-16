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

Before release, the host reported zero running native sessions and SQLite reported
zero running Task Runs. A completed unrelated plugin installation then restarted
the same user service, loading this already-pushed package. The public live
Capabilities tab subsequently passed the same read-only desktop/narrow acceptance:
two reads, no page errors, no business writes, and the post-check still found zero
running native sessions.

## Follow-up — light Tab style loading and mobile fit

The initial visual refresh accidentally placed the Capabilities rules only in
the deferred Agent/Board stylesheet. The conversation Tab is intentionally a
lightweight entry, so opening it first rendered unstyled host text. Its own
light stylesheet now carries the complete scoped token set and component rules;
it no longer depends on opening another Console page. Narrow layouts use a
two-column capability summary before the Tool/Skill cards collapse, keeping the
first useful controls above the fixed composer. Candidate desktop and narrow
browser acceptance passed with two read calls, no page errors and no business
writes. Screenshots were inspected then moved to the system trash; no temporary
assets remain in the project.

## Follow-up — effective Agent scope first

The page now answers the session question before rendering inventory: which
Agent owns this session, which MCP services, Skills and native Tools are
effective for it, and whether that result is explicit or inherited. MCP rows are
grouped by server and all tool/Skill details stay collapsed until requested.
Standard is explicitly labelled as the generic Agent that inherits the complete
environment directory; it is no longer presented as a bespoke Agent definition.
