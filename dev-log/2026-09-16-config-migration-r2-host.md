# DSH configuration migration R2 host enablement

The correct operator surface is `dsh.vyibc.com` → Task Console → Agent or Task
home → “导入 / 导出”. Fleet Hub is not the configuration migration UI.

The existing configuration migration implementation already exported authored
Agent specs/Actions and non-archived Task definitions/Actions, with no sessions,
run history, artifacts or credential values. The production failure was solely a
missing host-side R2 upload credential. The DSH user service now reads that
credential from an owner-only systemd EnvironmentFile; the browser, exported
package and Git never receive it.

Before the restart, DSH reported zero running Sessions. Post-restart catalog
readiness succeeded. A real export produced a public R2 package with 17 Agents
and 2 Tasks; a read-only preview of that same package succeeded. On its source
host all 19 definitions are expected same-ID conflicts. A fresh host will import
available definitions and keep all cron Tasks disabled.

The export card now adds a scoped “新机器安装并导入” command. It asks the
server-side Fleet bridge for a time-limited capability bound to exactly the
just-exported R2 URL; the browser never receives the Fleet service credential.
The target installer owns dependency installation and proves the final MCP and
Skill catalog before importing, so a Task cannot be imported merely because its
Agent definition was written.
