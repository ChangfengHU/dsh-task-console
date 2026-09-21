---
name: fleet-node-onboard
description: 把一台裸机接进 vyibc 机群,或修复/校验已有节点。基础流程:建 claude 账号 → 装 Clash 透明代理与控制面 → 装浏览器+VNC → 建域名并注册 Fleet。图片工作节点是显式可选扩展,不是基础装机前置条件。所有凭据与线路配置从金库自取,不依赖任何特定机器。Safely add, repair, or validate a Linux machine in the vyibc Fleet with optional image-worker provisioning.
---

# Fleet Node Onboard

Treat onboarding as a transaction. Never register a node before its public capability endpoint
passes verification.

## Provisioning profiles

- **Base Fleet node (default):** SSH/`claude` account, Mihomo/Clash, machine-local controller and
  Dashboard, browser/VNC, Cloudflare named hostnames, Fleet registration and health verification.
- **Image worker (opt-in):** everything in the base profile plus `chatgpt-image-service`,
  `imggen-*`, page-login identity checks, `/capabilities`, recycle policy and one real pinned image
  job. Enter this profile only when the owner explicitly asks the node to serve image jobs.

An MCP image service elsewhere is a control-plane interface; it does not make the target machine
an image worker. Never install `chatgpt-image-service` merely because an image MCP exists.

## 金库接入 —— 先读这段

**你只需要机主给三项首次接入信息:目标机 IPv4、SSH 用户名,以及首次登录方式(root 口令或一把引导密钥)。其余全部自取。**

不要问机主要 Cloudflare 凭据、代理源 URL、上传令牌,也不要去翻本地 `~/.ssh` 或某台机器的
`/etc/` —— 那些做法把这个能力绑死在某一台机器上,正是这个 skill 要消灭的东西。

DSH 装机者优先使用它已经获准的 `vyibc-vault` MCP。`scripts/vault.sh` 只供可信运行时
已经通过 `FLEET_VAULT_TOKEN` 注入管理员令牌时使用；它不会从公网下载管理员令牌：

```bash
scripts/vault.sh list                              # 有哪些键
scripts/vault.sh get clash:lines                   # 取值到 stdout
scripts/vault.sh getfile ssh:fleet-operator-key ~/.ssh/id_fleet   # 私钥专用:600 + 补回结尾换行
scripts/vault.sh set  ssh:host-129-146-55-188 /tmp/v.txt "说明"      # 存回去
```

不得从公开页面或接口获取、展示、复制管理员令牌。

这个流程要用到的键:

| 键 | 干什么 |
|---|---|
| `clash:lines` | **线路登记表(单一真相源)**,3 条 `{id,label,config_url,expected_ip,note}`。机器上的 `/etc/linux-clash-skill/sources.json` 是它的**缓存**,由本 skill 写下去 |
| `ssh:fleet-operator-key` / `ssh:fleet-operator-pubkey` | 机群统一 SSH 密钥对。新机器装的就是这把公钥 |
| `ssh:host-<完整IP打横线>` | 每台机器的登录方式,如 `ssh:host-84-8-217-45`。**新机器建完账号必须写回**。<br>**绝不能用 IP 的某一段命名**:按末段 `107.150.119.232`→`host-232` 会撞上已回收机器的 id;按首段 `129.146.55.188` 和 `129.213.30.236` 都变成 `host-129`,后写的覆盖先写的。两种都实测踩过 |
| `service:cloudflare` | 建隧道 / CNAME。注意 vyibc.com 的 zone 和 Worker 不在同一个 CF 账号下 |
| `service:suqu-api` | R2 上传令牌(发布 clash YAML 时用) |
| `clash-controller:host-<id>` / `dashboard:host-<id>` | 控制器与面板令牌。**装完必须写回** |

**两个取值的坑,踩过:**

1. **金库对 JSON 值会自动解析**——`clash:lines` 取回来是数组不是字符串,纯文本值才是字符串。
   两种都要兼容,`vault.sh` 已经处理了,自己写代码取值时别只对一种。
2. **字符串结尾的换行会被吃掉**。私钥缺尾换行时 ssh 报的是格式错,**看起来像"密钥不对"**,
   极难往这上面想。私钥一律走 `vault.sh getfile`,它无条件补回。

**凭据只在内存和 600 文件里流动**:不回显、不进日志、不进 argv、不落进仓库。

## Required inputs

- Direct IPv4, the first-login SSH username, and a first-login method (password or bootstrap key).
- Everything else comes from the vault — see 上面那段.

Never print passwords, proxy URLs, tunnel tokens, login bundle URLs, or API credentials. Do not
put passwords in command arguments when an SSH agent or protected file is available.
For password-only SSH, keep the password in `SSHPASS` only for the bootstrap preflight and account
creation; both scripts use `sshpass -e` and never place the secret in argv. Unset it immediately
after the standard account has been verified.

## One-shot execution contract

Input collection is not a provisioning transaction. Before running a Skill, stage gate, shell/SSH
command, or state-changing MCP tool, verify that the conversation contains the target IPv4, the
first-login SSH username, and either its password or a bootstrap key. If any field is missing, ask
only for the missing field and stay in intake; do not call `begin`, mark the task blocked, or touch
the target. When only an IP is supplied, a read-only vault lookup for the exact
`ssh:host-<full-IP-with-dashes>` record is allowed. If that record is absent or unusable, ask for
the missing first-login information instead of guessing a username or credential. Missing intake
data is not a failed gate; an actually attempted preflight with an invalid credential is.

Once all required inputs are present, start one transaction and run it end to end. From that point,
do not ask the user to send `/permission`, “continue”, or repeat the provisioning command. The Agent
preset must pin `danger-full-access` before the first execution turn because DSH's `workspace-write`
bubblewrap changes the apparent owner of `/etc/ssh/ssh_config.d` and OpenSSH correctly refuses that
configuration.

### Deterministic runtime contract

The Agent must not invent service names, shell fragments, component health, or an inventory. Its
model-facing onboarding tools accept only the target IP. A host-owned probe resolves the managed
credential, observes Fleet plus the target, signs the redacted inventory, and passes it directly to
`scripts/onboard-runtime.py`. Never expose an `inventory`, executor path, provenance object, command,
password, key, or token parameter in the model-facing tool schema.

`component-contract.json` is the sole source for stage IDs, required checks, systemd units and fixed
executor IDs. In particular, the controller is `linux-clash-node-controller.service`; do not use the
non-existent `linux-clash-controller.service`. The runtime reports two separate dimensions:

- health: `healthy`, `drifted`, `missing`, or `blocked`;
- disposition: `reusable`, `repairable`, `needs-user`, or `fatal`.

The host interface is JSON-only:

```bash
scripts/onboard-runtime.py start  --inventory -
scripts/onboard-runtime.py status --ip 192.0.2.10
scripts/onboard-runtime.py resume --inventory -
scripts/onboard-runtime.py report --ip 192.0.2.10
```

Inventory stdin contains no credential material. It must carry a fresh host-probe timestamp, the
contract digest, a digest of SSH host identity plus machine-id, and an HMAC attestation made with the
host-owned key in `FLEET_ONBOARD_INVENTORY_HMAC_KEY_FILE`. The runtime rejects stale, unsigned,
wrong-contract and changed-target inventories. An IP whose fingerprint changed is a different machine;
never resume its predecessor's transaction.

`apply` is host/operator-only. It invokes one absolute executable directly, never through a shell, and
sends a fixed `executor_id` plus deterministic `operation_id` over JSON stdin. The adapter must be
idempotent for that operation ID and return a newly probed, signed inventory. A claimed success does
not pass a stage unless the fresh inventory now satisfies every required unit and check. This repository
contains the runtime protocol and offline mock coverage. `scripts/host-adapter.py` is the host-owned
boundary: it accepts the runtime request only with an HMAC action attestation, resolves credentials from
a 0600 intake file or fixed provider, passes the credential to children by inherited FD, serializes work
per IP, and persists only secret-free job metadata. Every invocation probes before acting, so recovery
after an interrupted write converges to `noop` when the target is healthy and otherwise fails closed
instead of blindly replaying the mutation. `operation=poll` exposes only the durable job status.

Install the production host boundary with `sudo scripts/install-host-adapter.sh --service-user <dsh-user>`. It installs
the probe, credential provider, Stage 2 account reconciler and Stage 4 pinned machined reconciler, then creates
the service-private HMAC key/config. The provider keeps Vault Authorization and response values out
of argv/stdout; the SSH probe passes passwords/private keys through inherited FDs and hashes the SSH
host key plus machine-id before returning. See `host-adapter-capabilities.json` before enabling an
executor. Stages 5–8 and 10 are executed through the scoped Workflow/machined control path; Stage 9 is
a fresh probe gate. DSH must advertise one-shot execution only when both fixed host executors and the
scoped ledger/Workflow transports are configured.
Adding a generic shell, `ssh-fleet.sh`, or the cross-stage `install-clash.sh` as an executor is forbidden.
For the current `dsh-task-console` subprocess adapter, set the fixed probe executable to
`/usr/local/lib/dsh-fleet-onboard/scripts/host-adapter.py`, runtime to
`/usr/local/lib/dsh-fleet-onboard/scripts/onboard-runtime.py`, and set both host environment values:
`FLEET_ONBOARD_HOST_CONFIG_FILE=/etc/dsh-fleet-onboard/host-adapter.json` and
`FLEET_ONBOARD_INVENTORY_HMAC_KEY_FILE=/etc/dsh-fleet-onboard/inventory-hmac.key`.
The key is exactly 64 lowercase hexadecimal characters. Provision that same value, through stdin, as the
`FLEET_ONBOARD_INVENTORY_HMAC_KEY` secret of the **fleet-console Worker**; never put it in Wrangler source,
argv, logs, or DSH configuration. Reinstallation preserves an existing valid key and refuses to replace an
invalid/legacy key silently. Program and contract files stay root-owned; key/config are root-owned and
read-only to the dedicated `dsh-onboard` group, while runtime state is owned by the DSH service user.

When no local transaction exists but Fleet or managed components prove that the machine already exists,
the runtime selects `adopt`; it does not silently select `new`. A retry records `resume` and keeps prior
satisfied stages. A completed node with fresh drift enters bounded `repair`. A healthy repeat is
`verify-only` with zero target changes.

The runtime owns `scripts/stage-gate.sh`; use it directly only for operator diagnostics. A stage is
`passed` only after the command or the
explicit verification behind it succeeds; prose is not evidence. The gate rejects skipped stages
and `complete` unless all ten stages passed. A rerun for the same IP resumes the last blocked stage.
Use `reset` only when intentionally starting a new transaction after inspecting the old status.
For MCP evidence, use the raw returned `ok` and structured fields. Compute counts from returned
arrays and compare read-back fields directly; never replace tool evidence with a prose guess.

```bash
scripts/stage-gate.sh begin IP
scripts/stage-gate.sh run IP 1 ssh-preflight -- scripts/preflight.sh root@IP
scripts/stage-gate.sh run IP 2 standard-account -- scripts/init-node-user.sh root@IP
scripts/stage-gate.sh status IP
```

Recover local, non-destructive prerequisites automatically and retry the same stage. Stop without
registering the node when credentials are invalid, a target-side conflict would require a policy
decision, or a rollback gate fails. A blocked transaction is a final report, not a request for the
user to send another chat message.

On every retry, read `stage-gate.sh status IP` first. State lives under
`~/.local/state/dsh-fleet-onboard`, so it survives logout and reboot. Keep all passed stages and rerun only the
blocked stage; never recreate the account, rotate working credentials, create a second tunnel, or
insert a duplicate Fleet row. If the transaction is already complete, perform read-only
verification with `stage-gate.sh verify IP NOTE -- COMMAND`. If it passes, set `run_kind=verify-only`
and report the existing node without any target or Fleet writes. If it fails, use
`stage-gate.sh reconcile IP STAGE NOTE` to invalidate only the earliest drifted stage and its
downstream stages; arbitrary reset of a completed transaction is forbidden. Installers and repairs must
preserve existing browser profiles and deterministic full-IP names.

If a later check blocks because a stage already marked `pass` was incomplete, use
`stage-gate.sh reopen IP STAGE NOTE` on the current passed stage. `reopen` is allowed only on a
blocked transaction and atomically removes that stage plus downstream records; earlier passed
stages remain immutable. Repair, rerun that stage, and continue. Do not use `reset` for this case.

## Workflow

**十阶段基础流程如下。阶段号同时是 `stage-gate.sh` 的顺序约束。**

1. **首次 SSH 只读预检。** 先用用户给的首登账号运行
   `scripts/stage-gate.sh run IP 1 ssh-preflight -- scripts/preflight.sh USER@IP`。首登口令放
   `SSHPASS`，或用 `SSH_BOOTSTRAP_KEY` 指一把引导密钥。它必须真实验证 SSH、管理员权限、
   systemd、TUN、架构、内存、磁盘和已占端口；未运行或退出非 0 时不得进入账号创建。
2. **建 claude 账号。** 运行
   `scripts/stage-gate.sh run IP 2 standard-account -- scripts/init-node-user.sh USER@IP`。
   它做:建用户 → 装 `ssh:fleet-operator-pubkey` 进 `authorized_keys`(`grep -qxF` 去重)→
   写 `/etc/sudoers.d/90-claude` 并**先 `visudo -cf` 校验再 `install -m 0440`**(写坏 sudoers 会锁死机器)→
   从操作机用私钥重新登一次、断言 `whoami` 与 `sudo -n true` → **写回金库 `ssh:host-<完整IP打横线>` 并读回验证**。
   此后所有步骤都用 `claude@` + 密钥,不再碰 root 口令。
3. **正式登录与金库回读。** 独立使用金库里的新记录回登 `claude@IP`，验证 `sudo -n true`，
   再把阶段 3 标为通过。不得仅凭阶段 2 的输出推定金库可用。
4. **安装前资源快照。** 再次读取系统、路由、监听端口、现有服务与 TUN 状态并保留脱敏摘要。
   A machine below 4 GiB may use `scripts/preflight.sh --single-browser claude@IP` only after the
   owner explicitly accepts one browser, the host has at least 3.5 GiB RAM plus 2 GiB swap, and the
   browser is installed with a hard memory ceiling no higher than 1.4 GiB. Register only the one
   real CDP port; never fabricate a second slot.
5. **Mihomo/Clash。** Read and follow `$linux-clash-skill`, including both safety references. Run its `plan` remotely
   before `install`; keep timed rollback and exclude SSH plus tunnel UIDs. For a shared Fleet,
   use `line-100` as the default desired source and its registered `expected_ip` as a fail-closed
   requirement. A metadata label such as “主用” does not override this default. An alternate source
   is recovery-only and requires the owner to explicitly authorize the divergence.
6. **控制器与 Dashboard。** Install the machine-local Clash control plane. Use the direct IPv4-derived name
   `clash-<dashed-ip>`; never derive names from the proxy exit. For production named tunnels, pass
   `--no-public-preview` so onboarding does not also create an anonymous auto-domain endpoint.
7. **浏览器与 VNC。** Install `linux-browser-vnc` with two browsers by default. Preserve/import login bundles only
   when authorized. Use a persistent named hostname `vnc-<dashed-ip>.vyibc.com`. Before any
   Cloudflare mutation, run the provisioner's read-only `check --zone ... --name ...`; credentials
   must own the DNS zone and use the intended tunnel account. Do not assume the Fleet account owns
   the public zone.
   本阶段只创建本地服务；公网 ingress 与域名在阶段 8 统一处理。
   Before passing stage 7, run the browser Skill's idempotent `harden-egress --expected-ip` gate.
   Every configured CDP instance
   must report HTTPS and WebRTC on the verified proxy IPv4. Do not postpone this check until the
   final acceptance stage. If IPv6 is observed, restrict only the managed browser unit; do not
   globally disable host IPv6 or change the tunnel's address families.
8. **Cloudflare 命名隧道与域名。** `clash-*` 与 `vnc-*` 共用该机器的一条命名隧道；添加
   ingress 和 CNAME 后分别验证 HTTP/WebSocket 路径。
9. **基础节点综合验收。** Verify SSH after the TUN change, the controller and Dashboard health,
   the public Clash route, the VNC HTTP/WebSocket path, browser egress, disk and proxy latency telemetry.
   If the only failure is a browser IPv6/egress mismatch, treat it as an automatic, bounded repair:
   run `linux-browser-vnc.sh harden-egress --expected-ip`, then rerun stage 9 through the same
   `stage-gate.sh run` transaction. Register nothing until the repeated full acceptance passes.
10. **Fleet 注册与读回。** Register the unique full-IP node id, direct-IP name, Clash URL, and VNC URL,
   with a non-empty audit `reason`,
   only after stage 9 passes. Read the row back from Fleet and verify it is reachable, then run
   `stage-gate.sh fact` for the node id, desired/actual line, browser count, public URLs, profile and
   Fleet reachability. Run `scripts/stage-gate.sh complete IP`; it atomically creates the redacted
   `~/.local/state/dsh-fleet-onboard/<dashed-ip>.report.md`. Finally run `stage-gate.sh report IP`
   and include that report in the same DSH session. A transaction without this report is incomplete.
   A base node advertises zero image dispatch slots, while its real browser/VNC instances remain visible.

### Image-worker profile extension (opt-in only)

1. Install `chatgpt-image-service` from the current repository commit. Its environment must
   include `UPLOAD_R2_TOKEN`, node auth token, CDP ports, engine map, and root-owned mode 0600.
   Do not set `CHATGPT_IMAGE_RECYCLE_ENABLED=false`: active browser recycling is part of the
   baseline, including on low-memory hosts. Use finite per-browser cgroup limits and the standard
   80% recycle / 92% restart thresholds unless a reviewed repository change replaces them.
   Publish it as `imggen-<dashed-ip>.vyibc.com`. Copy the complete package, including both
   `run-chatgpt-image-create.mjs` and `run-gemini-image-create.mjs`; service startup must fail if
   an engine declared in the map has no Worker script.
   Use `skills/chatgpt-image-service/install.sh install ENV_FILE`; do not hand-copy a working
   machine's `/root` checkout. The installer stages dependencies, validates both Workers, keeps a
   dated code rollback, installs the bounded unit, and proves local health before returning.
2. Verify `/capabilities` before registration: disk exists; five proxy targets return structured
   latency; browser identities match actual pages; missing upload credentials prevent startup.
   Every node must run the same checked-in identity implementation. Gemini is page-authoritative:
   a visible usable composer means `in`, a visible sign-in surface means `out`, and missing,
   loading, or unreadable page evidence means `unknown`. Never collapse `unknown` into `out`.
3. Read
   [references/golden-node.md](references/golden-node.md), then run
   `scripts/verify-golden-node.sh USER@IP` and `scripts/verify-node.sh --profile image-worker IP`. The golden verifier
   checks the remote image service/cgroup/recycle contract; the public verifier checks Fleet-facing
   capabilities. Then add `imggen_url` and dispatch capacity, and dispatch one pinned Gemini or ChatGPT reference-image job
   and require a reachable result URL. Login detection alone is not proof of generation.

Read [references/rollout.md](references/rollout.md) for exact gates, naming, rollback, and failure
handling.

Do not treat `161.35.60.232` as permanent infrastructure or copy its filesystem ad hoc. It was
the observation source for the checked-in golden contract, not the source of truth. A replacement
must be buildable from the repository without that host.

Installers must download cloudflared only from an official release whose published SHA-256 digest
verifies. A direct download failure may retry through the configured proxy, but never bypass the
digest check. On systemd older than 244, remove only unsupported `ProtectClock` and
`ProtectHostname` directives from rendered units; retain all other sandboxing.

## 坑

**① ARM64 没有 Google Chrome。** `linux-browser-vnc` 在 aarch64 上会报 "No usable browser was found"
(系统 chromium 是个 snap 包装器,不能用)。装 Playwright 的 chromium 兜底:
`npx --yes playwright@1.49.1 install --with-deps chromium` → `/root/.cache/ms-playwright/chromium-*/chrome-linux/chrome`。
**下载约 103MB、会跑很久**,前台跑必被超时杀掉(实测 exit 143),用 `nohup ... &` 后台跑再轮询。

**② 一台机器只有一条命名隧道,`vnc-*` 和 `clash-*` 共用它。** 不要为面板新建隧道 ——
给现有隧道加一条 ingress + 一条 CNAME 就通了。新建会得到一条没有 connector 的死隧道(521)。

**③ 三个令牌是三个东西,401 先怀疑打错了端点,再怀疑凭据。**

| 端口 | 是什么 | 鉴权 | 公开域名 |
|---|---|---|---|
| 8788 | 节点控制器 | `Authorization: Bearer` | 无(仅 loopback) |
| 8789 | 单机面板 | **会话 cookie + CSRF,不吃 Bearer** | `clash-<横线ip>.vyibc.com` |
| — | 金库管理令牌 | Bearer | 只由可信运行时注入，不通过公开接口分发 |

拿 Bearer 去打 `clash-*.vyibc.com` 必得 `unauthorized`——那后面是面板不是控制器。我据此误判过一次"令牌过期"。

**④ 端口可能被别的东西占着。** 206 的 8787 被一个跑了 55 天的 node 应用占用,所以它的面板在 8789。
装之前先 `ss -lntp` 看清楚,**不要杀不认识的进程**。

**⑤ `pkill -f <模式>` 会杀掉你自己的 SSH 会话**,如果那段文字出现在你自己的远端命令行里。用 pid,
或者用自身不匹配的正则(`/root/[.]codex`)。

## Completion gate

For the default base profile, report complete only when SSH survives the TUN change, Mihomo and
tunnel services are active, Clash/VNC public endpoints respond, Fleet shows the node with disk and
proxy latency telemetry, and the verified TCP/UDP exit and timezone match the Fleet standard.
The final report must distinguish resources that were checked, reused, changed or blocked, and
must never contain passwords, tokens, proxy subscription URLs, cookies or private keys.

For the opt-in image-worker profile, additionally require the `imggen` endpoint, truthful page
identity state, complete Worker coverage, active recycle policy and one pinned image job. Otherwise
advertise zero image dispatch slots and state the blocking gate; do not fail an otherwise healthy
base-node registration merely because image service was not requested.

## Fleet-wide consistency is mandatory

This section applies only when provisioning or changing an image worker. Before enabling image
dispatch, enumerate every enabled image node and prove all reachable image workers run the same
checked-in identity logic and active recycle policy. Browser count may differ only through the
documented capacity exception; identity semantics, Worker coverage, status vocabulary, and
watchdog behavior may not differ. A node that cannot be upgraded or verified must be shown as
non-compliant and removed from image dispatch until it passes. Base Fleet nodes with zero image
slots are outside this image-worker consistency gate.
