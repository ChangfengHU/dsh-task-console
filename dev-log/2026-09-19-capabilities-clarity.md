# 0.31.5 — make session capabilities truthful and scannable

## Problem

Agent-isolated MCP namespaces were displayed as unrelated runtime tools. The
same configured tools therefore appeared both registered and missing, and the
UI grouped them under an unidentified service. The Capabilities tab also mixed
a light page background with dark-theme cards and repeated the same counts
without a clear operational conclusion.

## Change

- Map isolated runtime MCP names back to stable Agent-defined services and
  tool identities before calculating registration state.
- Lead with one loading conclusion, then separate Agent scope, service detail,
  grouped exceptions and raw diagnostics.
- Add service/tool search and an exception-only filter while keeping long MCP
  lists collapsed by service.
- Use Beijing time, the active DSH theme and sufficient bottom clearance for
  the fixed conversation composer.

## Verification

- Unit coverage checks stable identity recovery for isolated MCP namespaces.
- Targeted capability and filtered-MCP tests pass except for the pre-existing
  ToolRuntime schema fixture incompatibility documented by that test suite.
- Production acceptance requires the browser-manager session to show its two
  named MCP services, no contradictory missing warning, and a consistent dark
  theme.
