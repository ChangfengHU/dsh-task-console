# dsh-task-console

任务台 for DeepSeek Harness (dsh).

**This release (0.1):** author agents as real dsh presets. The editor's tool / MCP / skill choices are written to `~/.dsh/.agent-presets/<id>/agent.cordis.yml` — the composition dsh mounts — so a tool that is not ticked has no schema at all. "试跑" starts a real session on the preset and reports the exact tool list dsh handed the model (`request/header`), not what the model claims.

**Next:** tasks (brief + ordered participants + once / cron trigger) → run ledger → board.

```sh
dsh plugin --profile web add github:ChangfengHU/dsh-task-console
```

Opens from the sidebar footer button 「任务台」; screens live in the URL hash (`#/tc/agents`, `#/tc/agents/<id>`, `#/tc/tasks`, `#/tc/tasks/<id>`).

**Talk to an agent from the composer:** type `@` in any composer, pick an agent, type the ask, Enter. That starts a new session on the agent's preset (a session's preset is fixed at creation in dsh, so "@agent" means "a fresh session with that agent") with your text as the first message, pins a readable title, files it under the current workspace, and switches to it. Agent cards also have 「开新会话」.

**Tasks (0.2+):** a task = a brief + ordered participants + a trigger (once / cron). The host dispatcher runs each participant as its own root session on its own preset, hands the previous participant's last reply to the next one, and writes every transition to `~/.dsh/task-console/events.jsonl`; the board is a fold of that stream.

## Known limits

- MCP servers are ticked whole (no per-tool subset yet).
- If the host composition still runs an MCP server with the same `serverName`, the preset mounts it under `<server>-<id>` — every agent can still see the host copy until that row is removed.
- CLI-backed providers (`claude-local`, `codex-local`) bring their own Bash / Edit; dsh's fence cannot remove those. Provider-side sandboxing is the next step.
