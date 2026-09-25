# Studio asset search summaries

`asset_search` returns a bounded discovery index. It does not return full character
profiles, creative prompts, provenance histories, embedded binary data, or download
URLs. Select an exact ID and use the existing `asset_get` tool for full details.
No catalog storage data is changed.

The index preserves every candidate ID and its order, both exact-search and
separately labelled query-free catalog candidate groups, and their original
continuation cursors. Search invocations preserve credentials, all non-query
filters and the existing request/deadline budgets. Query-free candidates are never
represented as exact query matches.

Each candidate can carry bounded title/name, kind, tags, use cases, character IDs,
numeric duration, a compact object/archival description and license status.
Descriptive strings and tag lists can be shortened; candidate IDs are never
shortened or silently removed. `archiveState` describes metadata only;
`downloadVerified` and `rightsApproved` remain false. Actual acquisition, source
license/project review, listening/viewing and quality evaluation still apply.

A page with more than 100 candidates, invalid identity/cursor data, or a projected
response above 24,000 UTF-8 bytes returns an explicit error with `partial: true`
and `candidatesDelivered: false`. It does not return a subset with an advanced
cursor. Recovery starts from the original caller cursor and retains all filters,
with a smaller requested limit. If the provider ignores limits, report that
failure instead of repeating indefinitely. Upstream errors are not converted into
successful empty searches. Already wrapped upstream results are projected once,
without adding nested scans.

Both MCP `content` and `structuredContent` retain the same canonical summary. The
inspected DSH MCP adapter's `createOutput.render` renders `content` only; removing
`structuredContent` would change the tool value contract without demonstrated
model-context savings. This change does not alter the adapter or add an MCP tool.

## Trial08 read-only evidence and limits

The same Task's visual session showed six large search responses, each 32,394
characters after DSH's spill mechanism. Their corresponding next-request input
increases totalled 96,455 reported tokens. The full first spilled search result
was 54,500 characters; it included eight query-free catalog candidates. This was
the dominant observed growth, rather than repeated skill loading. Visual loaded
two skills once each (5,797 characters total), and separately fetched both the
locked profile and live character_get profile (9,876 + 9,648 characters).

There was one recorded request header per role. Visual had 54 tools with 35,237
serialized characters and an 18,008-character system field; sound had 62 tools
with 38,155 and 18,909 characters respectively. These are fixed initial overhead,
not evidence that the directory was cumulatively injected at each step. The
400-character text in the UI ledger is a separate display truncation. Real large
visual tool results contained an `Omitted ... bytes` spill notice and non-parseable
middle-shortened JSON.

Per-step usage is distinct from the sum of token usage across steps. The observed
visual session reached a reported 183,587 input tokens on step 44, while sound
reached 88,809 on step 80. The recorded contextWindow metadata was 131,072, but the
available log does not contain each fully assembled provider request and showed
no compaction event. This does not establish actual provider window enforcement,
truncation of the whole request, or prove that context size caused the behavioral
failure. Those remain separate transport/runtime questions.

Offline replay of two original results through the new summary code:

| Original result | Before | After | Reduction | IDs/order/cursors |
| --- | ---: | ---: | ---: | --- |
| Visual search step 6, complete same-session spill | 54,500 chars | 9,733 chars | 82.14% | Preserved, all 8 catalog IDs |
| Sound search step 13 | 5,846 chars | 5,581 chars | 4.53% | Preserved, both catalog IDs |

These are measured character lengths, not tokenizer estimates or a new production
run. No upload, search-provider call, image generation or live Task change was
performed. Sanitized measurements, hashes and shape metadata are saved in parent
`evidence/studio-creator-trial-08-context-size-audit-20260924.json` and
`evidence/studio-creator-trial-08-search-projection-size-comparison-20260924.json`;
full original result bodies are not copied into the report.

Further narrow opportunities, not implemented here: avoid fetching the live full
profile immediately after the same locked profile, expose only role-relevant tool
schemas, and verify the real provider context/compaction behavior before changing
it. Neither prompt length nor a bounded search index proves visual quality.
