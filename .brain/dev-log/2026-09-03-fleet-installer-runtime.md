# Fleet installer runtime bridge

- Added a managed `fleet-installer` preset with a pinned, content-locked Skill tree and no arbitrary host Bash/filesystem/job access.
- Added four strict IP-only runtime tools for start, status, resume and report. Missing credentials remain conversational intake and do not create a run.
- Added tool-level native/MCP fencing, scoped request-header clients, signed inventory validation, a central lease/CAS ledger and a fixed Stage 2 host adapter.
- Routed Stage 5/6/7/8/10 through an HTTPS-only Cloud Workflow transport whose POST body has exactly schema, operation id, stage and IP. Stage 1/3/9 remain fresh probe gates; Stage 4 is a fixed host-side machined reconciler.
- Running Cloud work resumes with the same operation id and attempt. Cloud success is not accepted until a new host probe proves the stage healthy; disabled Fleet state becomes a visible needs-user blocker.
- Refreshed the managed Skill lock to linux-clash-skill commit `fed3d6f5f1c158d441706b80c54e9aaf3a7d4434`; machine-local Python bytecode/cache files are excluded from copies and content hashes.
- The DSH adapter now requires both fixed host stages (account and machined convergence) before advertising execution availability, and routes both through the same attested host adapter.
- Verification: `npm test` passed 81/81, `npm run build` passed, managed Skill check passed for all three Skills, and `git diff --check` passed.
- No production deployment, target-node access, Fleet mutation, or vault mutation was performed.
