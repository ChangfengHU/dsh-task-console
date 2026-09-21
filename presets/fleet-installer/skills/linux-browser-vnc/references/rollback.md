# Rollback And Adoption

## What this skill owns

Exactly these seven units:

```text
linux-browser-vnc-xvfb.service
linux-browser-vnc-openbox.service
linux-browser-vnc-browser.service
linux-browser-vnc-x11vnc.service
linux-browser-vnc-novnc.service
linux-browser-vnc-health.service
linux-browser-vnc-tunnel.service
```

and exactly these paths:

```text
/etc/linux-browser-vnc/
/usr/local/lib/linux-browser-vnc/          # includes the staged browser on arm64
/var/lib/linux-browser-vnc/
/etc/apparmor.d/linux-browser-vnc-browser  # only where userns is restricted
```

plus the `linux-browser-vnc` system account. `uninstall` unloads and removes the
AppArmor profile as well.

## What this skill must never modify

- `/etc/mihomo/config.yaml`, including its `tun.exclude-uid` list
- `mihomo.service`
- any `linux-clash-*` unit, `/etc/linux-clash-skill/`, or `/var/lib/linux-clash-skill/`
- the `linux-clash-tunnel` account, which is shared with the Clash dashboard
- any pre-existing `vnc-*`, `vnc98-*`, `adspower`, `nonads-browser` or
  `cloudflared-*` unit

`uninstall` removes only the list in the first section. A machine that loses its
desktop keeps its proxy exit, its Clash dashboard and its public Clash hostname.

## Removing the desktop

```bash
sudo bash scripts/linux-browser-vnc.sh uninstall
```

The browser profile in `/var/lib/linux-browser-vnc/profile` survives so a
reinstall keeps its logged-in sessions. Add `--purge-profile` to delete the
profile and the desktop account as well.

After uninstalling, confirm that the proxy was untouched:

```bash
curl --noproxy '*' -fsS http://127.0.0.1:8788/healthz
systemctl is-active mihomo linux-clash-node-controller linux-clash-dashboard
```

## Rolling back the public hostname

The hostname is released when `linux-browser-vnc-tunnel.service` stops. To keep
the local desktop but drop public reach:

```bash
sudo systemctl disable --now linux-browser-vnc-tunnel.service
```

Three Cloudflare objects belong to each desktop hostname, and they are removed
separately from the node services and separately again from the fleet registry
row: the named tunnel, the proxied CNAME, and the empty Worker route that stops
the zone's `*.chxyka.ccwu.cc` auto-domain Worker from intercepting the hostname.
Never roll all of them back at once; each has its own blast radius.

Deleting only that empty Worker route silently breaks the desktop while DNS and
the tunnel still look healthy — the auto-domain Worker answers first and returns
404 to the WebSocket upgrade. Check that route first when a working desktop
suddenly stops connecting.

## Adopting a machine that already has a VNC stack

Nodes `168.110.217.45` and `152.32.214.95` had their own stacks before this
skill existed. Both had real problems worth recording before any change:

- `websockify` bound `0.0.0.0:1006` (and `0.0.0.0:1018` on 95), so an
  unauthenticated desktop was reachable directly from the internet;
- `x11vnc` ran with `-nopw` and additionally held the `[::]:5900` IPv6 wildcard
  even though a loopback listen address was requested;
- no unit had any memory, task or restart bound;
- on 45 the `cloudflared-vnc-auto` connector ran as `root`, so it was not
  covered by the `linux-clash-tunnel` TUN exclusion.

Adoption procedure:

1. Run `inspect` and save the output as the pre-change record.
2. Save the existing unit files before touching them:
   ```bash
   sudo mkdir -p /var/backups/linux-browser-vnc-preexisting
   sudo cp /etc/systemd/system/vnc-*.service \
           /etc/systemd/system/vnc98-*.service \
           /etc/systemd/system/cloudflared-vnc-auto.service \
           /var/backups/linux-browser-vnc-preexisting/ 2>/dev/null || true
   ```
3. Install this skill on a **different** display and different ports, so both
   stacks can run side by side while the new one is validated.
4. Only after `verify` passes, stop the old stack — one unit at a time, checking
   that nothing else on the machine depended on it:
   ```bash
   sudo systemctl disable --now vnc-websockify.service
   ```
   Stopping `vnc-websockify` first is what closes the public unauthenticated
   port, so it is the highest-value single step.
5. Keep the backups until the owner confirms the old stack is not needed.

Do not delete AdsPower, `nonads-browser`, or the `:98` session on 95 without an
explicit decision from the owner. They serve a different workload from this
skill and are not interchangeable with it.

## Reboot and tunnel recovery

All units are `WantedBy=multi-user.target`, so a reboot restores the desktop and
requests the hostname again. The public unit uses a systemd watchdog fed only by
a successful local-plus-public probe, which restarts a connector whose process is
alive but whose connection is dead. Verify both explicitly:

```bash
sudo reboot
# after it returns
sudo bash scripts/linux-browser-vnc.sh verify
sudo systemctl show linux-browser-vnc-tunnel.service \
  -p WatchdogUSec -p WatchdogTimestamp -p NRestarts
```
