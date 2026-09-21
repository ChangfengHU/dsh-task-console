# 0.31.6 — bounded Fleet node retirement Agent

## Scope

Added the `fleet-node-retirer` preset for one reusable retirement workflow. It
has no native tool or Skill inheritance and receives only three Fleet MCP
tools: read the code-enforced eligibility gate, retire one eligible node and
read lifecycle audit. It cannot SSH, call generic Vault deletion, disable a
healthy node or erase a remote machine.

The reusable Task is intentionally not tied to an IP. The first production
acceptance will use the owner's explicit host-206 eligibility override, then
hand the final receipt to the existing WeCom notifier. Future runs must rely on
the same server-side 168-hour gate and fresh-unreachable verification.

## Verification

- 322 tests passed, three existing environment-dependent cases skipped.
- Production bundle completed.
- Live preset installation, Task execution, schedule enablement and browser
  verification remain pending at this source checkpoint.
