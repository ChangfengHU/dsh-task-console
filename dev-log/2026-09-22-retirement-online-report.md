# Retirement Task: include all observed nodes in WeCom reports

## Scope

- Keep the existing reusable Task and two-role final handoff. Candidates alone
  authorize retirement; deferred records are report-only. No extra Fleet tool
  grants, SSH, fabricated outages, direct notifications or history deletion.
- The retirer preset now requires online/unreachable/unknown counts and each
  returned node's observed duration, observation time and reason in the actual
  `task_complete.summary`. Missing IP stays the original node ID. Stale evidence
  is unknown; observation continuity is not operating-system uptime.
- Notification delivery continues through the existing frozen outbox and
  independent notifier, not an implementation-session message.

## Live acceptance

- Creator revision went through independent plan review. The first proposal
  was rejected for removing original retirement audit/safety requirements.
- Approved revision `P-chat-54efc524214c1d3459b6` retained those requirements.
  Public Chrome clicked approval and the target card's **立即执行** once,
  producing `b-muckp7ctkyt`.
- First execution: six reachable, fresh observations,
  no retirement candidates, exactly one candidate lookup and no retirement
  writes. The notifier's durable receipt was `sent`, attempt 1.
- This first report was insufficient: the Agent wrote per-node detail in chat
  but submitted a compressed English summary. Do not treat chat prose as the
  delivered report. A follow-up reviewed revision requires full Chinese detail
  inside the summary itself.
- Second revision `P-chat-c34a84eadf85c6d4e6e3` and page-triggered execution
  `b-muckwn3sig9` delivered Chinese per-node detail, but comparing the stored
  tool response exposed incorrect model-generated timestamp conversion. The
  next revision preserves raw seconds and Unix milliseconds instead of asking
  the model to do date arithmetic. Prior notifications/history are preserved,
  not silently rewritten.
- Final revision `P-chat-2eeb20a5c3243329bc63`, execution
  `b-mucl5nq6lxq`: both real roles finished, one discovery call returned six
  fresh reachable nodes and no candidates. The final Chinese summary contains
  all six nodes and their exact returned seconds/millisecond timestamps.
  `verify-retirement-report-live.py` matched each row against the persisted MCP
  response and confirmed the frozen summary was sent unchanged, one attempt,
  receipt `sent`. No retirement writes occurred. Unknown/unreachable retirement
  scenarios were not fabricated or destructively live-tested in this change.
- Public-page approval, manual execution, node selection and fullscreen inspector
  passed without JavaScript errors. The standalone Execution Report view still
  only displays file artifacts and says “等待结果” for this text-only Task. The
  actual text is available in the retirer's node inspector and in WeCom. No
  unrelated UI rewrite was included. Human-readable timestamp formatting remains
  a follow-up; raw values are preserved instead of model-generated dates.
- Creator Qwen submissions encountered malformed JSON arguments before successful
  retry; these attempts and rejected plans are retained. This change does not
  claim to repair the general model tool-argument serialization path.
- A concurrent runtime overlay change briefly made taskConsole unavailable;
  no service restart or overlay replacement was performed by this task.
- The retirement schedule was found disabled with an hourly expression. This
  report change does not enable it or claim that the earlier daily schedule
  request has been fulfilled.

## Reproduction and verification

- `/usr/bin/node --import tsx --test test/task-create-preset.test.ts test/retirement-report-preset.test.mjs test/notification-dispatch.test.ts test/scheduler.test.ts`
- `scripts/test-retirement-report-live.py --plan <independently-reviewed-plan> --session <creator-session> --execute`
  is explicitly side-effecting: it approves that revision and clicks one real
  execution. Do not rerun without checking the previous receipt.
- `scripts/verify-retirement-report-live.py --db <task.db> --session-log <retirer-session.jsonl.zstd> --batch <batch>`
  is read-only and compares the no-candidate report with exact source observations
  and the durable notification outbox.
- No temporary dependencies or build output were created; existing environment
  reused. Screenshots under `/tmp/dsh-retirement-report-*.png` are retained as
  acceptance evidence. Unrelated existing `lib/*` edits are not included.
