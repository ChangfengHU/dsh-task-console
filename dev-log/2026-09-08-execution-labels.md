# Execution-history labels

Owner wants business-readable execution choices, not a raw b-chat ID list. Commit
cb91565 adds fixed Asia/Shanghai firedAt date/time to seconds and short display
codes; full IDs remain unchanged in option values, URLs and hover titles. Both
legacy and database replay share the picker. Existing records were not rewritten,
no new execution was submitted and no DSH/node service was restarted.

127 serial tests and build passed, including UTC/local-offset equivalence,
cross-year midnight, DST-independent Beijing formatting, invalid timestamps and
unchanged identities. Real public Chrome configured to America/New_York displayed
2026-09-08 10:49:38 / #69621B7F and 10:36:05 / #AF090739 correctly. Selecting each
record changed the full-ID URL and loaded its own original signed-job report.
390px mobile picker and header fit without overflow. Screenshots were inspected;
a small balanced-caption style avoids an isolated last character on narrow screens.
No page errors. Evidence is presentation/navigation only, not a new node acceptance.
