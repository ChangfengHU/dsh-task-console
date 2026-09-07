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

The first visible retry exposed another pre-existing intake problem: mentioning the
same IP again discarded earlier credentials, and model-role `user` Skill-catalog
injections could be parsed as a username (the prose "user names"). Intake now respects
message provenance and the contiguous same-target context; switching target or username
still prevents credential reuse. The owner's actual persisted history was replayed
locally against the parser: available=true and expected username, without printing a
password or contacting the machine. Ambiguous prose is not shorthand credential input.

The expanded full suite passes 116 tests with `--test-concurrency=1`. An earlier parallel
run exposed the new negative-case test plus three existing timing-sensitive Runner
tests; the negative case was corrected in production parsing and the final serial full
run passed without modifying unrelated Runner code. The incorrect credential question
is cancelled only in the owner-selected session before reloading; no history is removed.

Further real execution passed SSH preflight and reached managed-account setup. The
paired host repair `40855d1` fixes OpenSSH closing inherited identity descriptors;
it was reproduced with actual OpenSSH in all three affected transports and passed
273 Python tests. The old needs-user record cannot be blindly resumed; retain this
protection and use the existing audited executor-baseline migration instead.

Baseline migration now recalculates new/repair mode from fresh inventory rather than
carrying the previous active run's `new` mode after a partial account installation.
Same-baseline continuation still preserves the original mode. The focused suite
passes 25 tests, the full serial suite 117; the two existing central baseline-migration
tests also pass. No ledger rows are deleted and no needs-user policy is relaxed.

The new host receipt identified the actual second-stage failure boundary as
`vault-bootstrap`. Production `apply()` supplied the scoped Vault environment to
the intake provider but omitted it from the host subprocess, so bootstrap/commit
could not use it despite a healthy service. Pass the same narrow Vault environment
to trusted host subprocesses; never forward broad Vault, Fleet agent/executor, or
Cloud tokens. A production-entry wiring test failed before this fix and passes
afterward, including model-schema non-disclosure. Full serial suite: 118 passed.
No bearer values were changed, rotated or displayed.

Subsequent continuation exposed bootstrap reuse: historical intake always won over
the now-verified Vault login, making each resume report Stage 2 unhealthy again.
`resume` now prefers managed Vault material; only a genuinely absent record falls
back to intake. Initial explicit bootstrap intake remains supported; provider
transport/validation errors do not silently fall back. Discarded intake buffers are
zeroed. The paired host change requires independent managed resolution for Stage 4+
even within an initial `start` call. Full serial plugin suite: 119 passed.
