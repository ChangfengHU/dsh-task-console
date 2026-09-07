# Safe host-adapter diagnostics

The owner's real installer Session `agent-fleet-installer-mtqvs1cv` stopped before
creating a transaction. linux-clash-skill's updated SSH inventory producer emitted
two undeclared telemetry fields. Its strict runtime rejected the output, while
this adapter discarded the diagnostic and returned only `host-adapter-failed`.

`794cc41` adds allowlisted diagnostic codes and a fixed execution boundary. Unknown,
oversized, multiline or credential-bearing stderr never crosses into model output.
The result preserves configured execution availability instead of treating every
probe/contract error as an absent executor. Input schemas remain IP-only. No grants,
credentials, storage schema or Task behavior changed.

Validation: `NODE_ENV=test /usr/bin/node --import tsx --test test/*.test.ts` — 115 passed;
the focused onboarding suite — 23 passed. `/usr/bin/node scripts/build.mjs` passed.
Tracked `lib/fleet-onboard-tools.js` is included in the delivery. Production resolves
`dsh-task-console` to this checkout. Before reloading host code, the live Session API
reported zero running sessions; the existing user service was restarted, with no
plugin reinstall, session cleanup or credential changes.

The paired producer fix is linux-clash-skill `ccb0235`. Its new test runs real probe
serialization, HMAC assembly, strict validation and assessment with only external
I/O mocked. Production retry stays in the owner's original DSH Session; this developer
does not directly SSH to the target or execute its installation.
