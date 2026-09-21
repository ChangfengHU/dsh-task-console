# 0.31.6 — bounded Fleet node retirement Agent

## Scope

Added the `fleet-node-retirer` preset for one reusable retirement workflow. It
has no native tool or Skill inheritance and receives only four Fleet MCP
tools: discover due nodes, read one code-enforced eligibility gate, retire one
eligible node and read lifecycle audit. The read-only discovery call lets one
reusable schedule avoid hard-coded IPs. It cannot SSH, call generic Vault deletion, disable a
healthy node or erase a remote machine.

The reusable Task is intentionally not tied to an IP. The first production
acceptance will use host-206 only if live patrol evidence still satisfies the
gate (the owner-authorized override is a fallback, not fabricated history), then
hand the final receipt to the existing WeCom notifier. Future runs must rely on
the same server-side 168-hour gate and fresh-unreachable verification.

## Verification

- 322 tests passed, three existing environment-dependent cases skipped.
- Production bundle completed.
- Live preset installation, Task execution, schedule enablement and browser
  verification remain pending at this source checkpoint.
