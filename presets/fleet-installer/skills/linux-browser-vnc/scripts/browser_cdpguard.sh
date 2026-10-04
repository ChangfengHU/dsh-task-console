#!/usr/bin/env bash
# Restart any browser instance whose DevTools endpoint is dead or hung.
#
# systemd Restart=always only catches a browser whose PROCESS exited. It cannot
# see a browser that is still running but frozen — DevTools listening yet not
# answering — which surfaces as locator/page timeouts during image generation
# and, when a fast crash-loop trips the start limiter, as an instance that stays
# down for hours. This probe closes both gaps: it asks each instance's
# /json/version and, on two consecutive failures, clears any wedged unit state
# and restarts that instance. Instances are read from desktop.env so the guard
# scales with --instances without editing this file.
set -u

ENV_FILE=/etc/linux-browser-vnc/desktop.env
[[ -r "$ENV_FILE" ]] && . "$ENV_FILE"
base="${BROWSER_DEBUG_PORT:-9222}"
count="${VNC_INSTANCES:-1}"

probe() { curl -fsS --max-time 5 "http://127.0.0.1:$1/json/version" >/dev/null 2>&1; }

for i in $(seq 1 "$count"); do
  port=$(( base + i - 1 ))
  probe "$port" && continue
  sleep 3                       # one retry, so a momentary hiccup is not a restart
  probe "$port" && continue
  logger -t cdpguard "instance ${i} DevTools ${port} unreachable; restarting browser@${i}"
  systemctl reset-failed "linux-browser-vnc-browser@${i}.service" 2>/dev/null || true
  systemctl restart "linux-browser-vnc-browser@${i}.service"
done
