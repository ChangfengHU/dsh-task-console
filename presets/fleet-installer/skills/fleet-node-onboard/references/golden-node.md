# Golden Fleet node contract

Use this contract instead of cloning a live machine. It was derived from the working
`161.35.60.232` node on 2026-08-17, but no machine is the source of truth.

## Required capabilities

| Layer | Required result |
| --- | --- |
| Proxy | Mihomo TUN active; Controller and Dashboard healthy; browser traffic uses the approved shared TCP/UDP exit; tunnel UID stays direct. |
| Desktop | Two visible, persistent browser instances by default on CDP 9222 and 9223; one shared X/Openbox/x11vnc/noVNC desktop; all listeners loopback-only. |
| Resource protection | Each browser runs in its own systemd cgroup with `Restart=always`, `KillMode=control-group`, finite `MemoryHigh`, `MemoryMax`, and `TasksMax`. |
| Active recycle | The image service reports `recyclePolicy.enabled=true`; idle browsers are checked every minute, soft-recycled from 80% of `MemoryHigh`, and restarted from 92%. |
| Image service | Both ChatGPT and Gemini Workers exist for every declared CDP port; `/health` and `/capabilities` answer; missing Worker files or upload credentials fail startup. |
| Identity | Every browser is checked independently. Gemini, ChatGPT, Douyin, Xiaohongshu, and Weixin return `in`, `out`, or `unknown`. Gemini uses its live page as authority; Cookie presence or absence is never final proof. |
| Telemetry | `/capabilities` contains host memory, root disk, load/cores, browser cgroup memory, and structured latency for Gemini, Claude, ChatGPT, YouTube, and GitHub. |
| Publication | Canonical public names are `clash-<dashed-ip>.vyibc.com`, `vnc-<dashed-ip>.vyibc.com`, and `imggen-<dashed-ip>.vyibc.com`; all route through a named Cloudflare tunnel. |
| Fleet | The D1 row is added only after the public contract passes. Dispatch advertises only browser/engine pairs whose page-level identity is really logged in. |
| Proof | Run the golden verifier and one pinned end-to-end image task; require a reachable uploaded image URL. |

The historical `*.chxyka.ccwu.cc` names are not the canonical completion gate. On the capture
date, the 232 Clash endpoint returned 502 and its VNC endpoint returned 522 there while all three
`*.vyibc.com` endpoints returned 200.

## Resource profile

Size resources from the target host; do not copy DigitalOcean identifiers or absolute memory
numbers blindly. The reference node has 4 CPU, about 8 GiB RAM, no swap, two browsers, and these
per-browser limits:

- `MemoryHigh` about 1985 MiB;
- `MemoryMax` about 2497 MiB;
- `TasksMax=400`;
- process budget 60 across the desktop.

For another machine, preserve the policy and safety margin even if the numbers change. A host
below the normal two-browser capacity must use the documented single-browser exception. Never
disable active recycle to make an undersized host pass.

## Browser variants

Treat a behavior-collection browser as an augmentation of this baseline, not a replacement:

```text
standard browser = visible desktop + login detection + image generation + dispatch + cgroup guard + active recycle
behavior browser = standard browser + behavior-collection capability
```

Register every standard-capability browser in `CHATGPT_IMAGE_CDP_PORTS`. An intentionally
non-dispatch collection-only browser is a different product and must not be labelled a standard
browser in Fleet.

## Secrets and mutable state

Do not snapshot browser profiles, cookies, node tokens, upload tokens, tunnel tokens, proxy URLs,
machine IDs, or Cloudflare credentials into Git. Recreate services and configuration from the
repository, then establish user login interactively or import an explicitly authorized encrypted
profile bundle. Store runtime secrets only in the documented root-owned files.

## Drift rule

Run `scripts/verify-golden-node.sh USER@IP` after install, repair, configuration changes, and
before retiring a reference host. A green systemd state alone is insufficient. Any explicit
`CHATGPT_IMAGE_RECYCLE_ENABLED=false`, missing browser Worker, non-loopback listener, absent
latency target, or browser-count mismatch fails the node.

All enabled Fleet nodes must use the same commit-level identity and watchdog semantics. Different
browser counts are allowed only for documented capacity exceptions; different meanings of
`in`/`out`/`unknown`, omitted standard-capability ports, or disabled recycle are not allowed.

Install or refresh the image layer with
`skills/chatgpt-image-service/install.sh install /path/to/root-owned.env`. Its `uninstall` action
removes only the unit and deliberately preserves configuration, runtime data, and browser profiles
for recovery.
