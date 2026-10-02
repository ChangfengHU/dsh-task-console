# Runtime Source Audit

## 2026-10-02

The deployed Task snapshot was newer than the repository main branch. Its source.bundle was imported into the existing remote repository without changing the dirty checkout. The R2 upload and verification timeouts were committed from the deployed source, built with the service Node binary, and covered by 19 passing migration tests.

The fix branch and two deployed source archive branches were pushed from the remote host only. Existing CLI frontend edits were not included. Main was not merged because the snapshot contains a larger independent change set.

Two older Studio runtime directories contain compiled lib files but no src or source.bundle. Next: locate their originating source before replacing or claiming reproducible builds. The built Task files are on disk; no service restart was performed in this audit.
