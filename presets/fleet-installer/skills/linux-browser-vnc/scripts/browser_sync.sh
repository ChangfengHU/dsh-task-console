#!/usr/bin/env bash
# Export or import a browser instance's login session.
#
# A logged-in session lives entirely on disk in a small set of profile files
# (cookies, Local Storage, the crypto Local State). This bundles just those,
# uploads the bundle to the resource host, and later restores it into any
# instance on any machine, so a fresh machine logs in without a password.
#
#   export-login  --instance N --name OBJECT --upload-token TOKEN
#                 → uploads a bundle, prints its public https URL
#   import-login  --instance N --url HTTPS_URL
#                 → downloads a bundle into instance N and restarts it
#
# SECURITY: the uploaded bundle IS the login. Anyone who can fetch its public
# URL can act as that account. Use an unguessable --name and treat the URL as a
# secret. The upload token is supplied per call and is never written to disk.
set -Eeuo pipefail

STATE_ROOT="/var/lib/linux-browser-vnc"
DESKTOP_USER="linux-browser-vnc"
UPLOAD_ENDPOINT="${UPLOAD_R2_ENDPOINT:-https://upload-r2.vyibc.com}"
RESOURCE_DOMAIN="${UPLOAD_RESOURCE_DOMAIN:-https://resource.vyibc.com}"
UPLOAD_TOKEN="${UPLOAD_R2_TOKEN:-}"

# The minimal set of profile paths that carry a login. Verified at 404 KiB for a
# ChatGPT Pro session, versus ~340 MiB for a full profile.
BUNDLE_PATHS=(
  "Local State"
  "Default/Cookies"
  "Default/Cookies-journal"
  "Default/Preferences"
  "Default/Local Storage"
  "Default/Session Storage"
  "Default/Network"
)

log() { printf '[linux-browser-vnc-sync] %s\n' "$*"; }
die() { printf '[linux-browser-vnc-sync] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  browser_sync.sh export-login --instance N --name OBJECT [--scope bundle|full]
                   [--upload-token TOKEN] [--upload-endpoint URL] [--resource-domain URL]
  browser_sync.sh import-login --instance N --url HTTPS_URL [--no-restart]

export-login bundles instance N's login and uploads it; it prints the public URL.
  --scope bundle (default) uploads only session files (~hundreds of KiB).
  --scope full uploads the whole profile minus caches (hundreds of MiB).
  The upload token may also come from the UPLOAD_R2_TOKEN environment variable.

import-login downloads a bundle from a public URL into instance N, strips the
copied singleton locks, clears the unclean-shutdown flag, and restarts the
instance so it comes up logged in.
EOF
}

require_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "This command must run as root."; }

INSTANCE=""
NAME=""
SCOPE="bundle"
URL=""
RESTART=1
DOMAINS=""
BUNDLE_FILE=""

parse() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --instance) INSTANCE="$2"; shift 2 ;;
      --name) NAME="$2"; shift 2 ;;
      --scope) SCOPE="$2"; shift 2 ;;
      --url) URL="$2"; shift 2 ;;
      --domains) DOMAINS="$2"; shift 2 ;;
      --bundle-file) BUNDLE_FILE="$2"; shift 2 ;;
      --upload-token) UPLOAD_TOKEN="$2"; shift 2 ;;
      --upload-endpoint) UPLOAD_ENDPOINT="$2"; shift 2 ;;
      --resource-domain) RESOURCE_DOMAIN="$2"; shift 2 ;;
      --no-restart) RESTART=0; shift ;;
      *) die "Unknown argument: $1" ;;
    esac
  done
  [[ "$INSTANCE" =~ ^[0-9]+$ ]] && (( INSTANCE >= 1 && INSTANCE <= 16 )) \
    || die "Provide --instance N (1-16)."
}

profile_dir() { printf '%s/profile-%s' "$STATE_ROOT" "$INSTANCE"; }

export_login() {
  require_root
  local profile; profile="$(profile_dir)"
  [[ -d "$profile" ]] || die "Instance ${INSTANCE} has no profile at ${profile}."
  [[ -n "$NAME" ]] || die "Provide --name for the uploaded object."
  [[ "$NAME" =~ ^[A-Za-z0-9._-]+$ ]] || die "The name must be [A-Za-z0-9._-]."
  [[ -n "$UPLOAD_TOKEN" ]] || die "Provide --upload-token or set UPLOAD_R2_TOKEN."

  local work; work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  if [[ "$SCOPE" == "full" ]]; then
    log "Bundling the full profile (minus caches) for instance ${INSTANCE}."
    rsync -a --exclude 'Default/Service Worker/CacheStorage' --exclude '*/Cache/*' \
      --exclude '*/Code Cache/*' --exclude '*/GPUCache/*' --exclude '*/ShaderCache/*' \
      --exclude 'component_crx_cache' --exclude '*.log' "$profile/" "$work/payload/" 2>/dev/null
  else
    log "Bundling the login session for instance ${INSTANCE}."
    install -d "$work/payload/Default"
    local rel
    for rel in "${BUNDLE_PATHS[@]}"; do
      [[ -e "$profile/$rel" ]] || continue
      install -d "$work/payload/$(dirname "$rel")"
      cp -a "$profile/$rel" "$work/payload/$rel"
    done
  fi
  # Never carry a source machine's singleton locks or crash flag downstream.
  rm -f "$work"/payload/Singleton* "$work"/payload/Default/Singleton* 2>/dev/null || true

  local tarball="$work/bundle.tgz"
  tar czf "$tarball" -C "$work/payload" . 2>/dev/null
  local size; size="$(du -h "$tarball" | cut -f1)"
  log "Bundle size: ${size}. Uploading as ${NAME}."

  local response
  response="$(curl --noproxy '*' -sS --max-time 120 --location "$UPLOAD_ENDPOINT" \
    --header "Authorization: Bearer ${UPLOAD_TOKEN}" \
    --form "file=@${tarball}" \
    --form "domain=${RESOURCE_DOMAIN}" \
    --form "name=${NAME}" 2>&1)" || die "Upload failed: ${response}"
  local url
  url="$(printf '%s' "$response" | python3 -c "import sys,json;print(json.load(sys.stdin).get('image_url',''))" 2>/dev/null || true)"
  [[ -n "$url" ]] || die "Upload did not return a URL. Raw response: ${response}"
  log "Uploaded. Treat this URL as a secret; it IS the login."
  printf '%s\n' "$url"
}

import_login() {
  require_root
  [[ -n "$URL" ]] || die "Provide --url with the bundle's public HTTPS URL."
  [[ "$URL" =~ ^https://[A-Za-z0-9./?=_%:-]+$ ]] || die "The URL must be a plain HTTPS URL."
  local profile; profile="$(profile_dir)"
  install -d -m 0700 -o "$DESKTOP_USER" -g "$DESKTOP_USER" "$profile"

  local work; work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  log "Downloading the login bundle."
  curl --noproxy '*' -fsS --max-time 180 "$URL" -o "$work/bundle.tgz" \
    || die "Download failed from ${URL}."
  install -d "$work/payload"
  tar xzf "$work/bundle.tgz" -C "$work/payload" 2>/dev/null \
    || die "The downloaded bundle is not a valid archive."

  local unit="linux-browser-vnc-browser@${INSTANCE}.service"
  local was_active=0
  systemctl is-active --quiet "$unit" 2>/dev/null && was_active=1
  if (( was_active )); then
    log "Stopping instance ${INSTANCE} to overlay the session cleanly."
    systemctl stop "$unit" 2>/dev/null || true
  fi
  # `systemctl stop` does not always reap orphaned Chrome helpers, and a live
  # Chrome holds the cookie DB open — overlaying underneath it is silently
  # ignored (its SQLite handle still points at the old inode, and on exit it can
  # even rewrite the file from memory). Kill everything bound to this profile and
  # wait for it to actually die before writing the bundle, or the import "works"
  # in the logs while the browser stays logged out (observed on node 206).
  local pat="user-data-dir=${profile}"
  local tries
  for tries in 1 2 3 4 5 6 7 8; do
    pkill -f "$pat" 2>/dev/null || true
    pgrep -f "$pat" >/dev/null 2>&1 || break
    sleep 1
  done
  pkill -9 -f "$pat" 2>/dev/null || true
  sleep 1
  # Overlay the bundle onto the existing profile; existing settings survive.
  cp -a "$work/payload/." "$profile/" 2>/dev/null
  rm -f "$profile"/Singleton* "$profile"/Default/Singleton* 2>/dev/null || true
  # Clear the crash flag so the restored browser starts without a Restore prompt.
  python3 - "$profile" <<'PY' 2>/dev/null || true
import json, sys
from pathlib import Path
prof = Path(sys.argv[1])
for rel in ("Default/Preferences", "Preferences"):
    p = prof / rel
    if not p.exists():
        continue
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        continue
    data.setdefault("profile", {})["exit_type"] = "Normal"
    data["profile"]["exited_cleanly"] = True
    p.write_text(json.dumps(data), encoding="utf-8")
PY
  chown -R "$DESKTOP_USER":"$DESKTOP_USER" "$profile"

  if (( RESTART )) && { (( was_active )) || systemctl is-enabled --quiet "$unit" 2>/dev/null; }; then
    log "Starting instance ${INSTANCE}."
    systemctl start "$unit" 2>/dev/null || true
  fi
  log "Instance ${INSTANCE} restored from ${URL}."
}

# ----------------------------------------------------------- domain-scoped
# A login bundle (export/import above) carries a whole profile and overwrites
# every site's session. These two do it per platform instead: they move only the
# cookie rows whose host_key matches one of --domains, so one browser can hold
# several independent logins (chatgpt + gemini + douyin) and a single platform
# can be reseeded or refreshed without disturbing the others.
#
# Portability rests on the same fact as import-login: every instance runs Chrome
# with --password-store=basic, so encrypted_value is sealed with the fixed key
# and decrypts on any machine. Schemas match across the fleet, but the merge
# still inserts by an explicit intersected column list so a version skew degrades
# to dropping an unknown column rather than corrupting the row.

# Stop the instance and make sure no Chrome still holds this profile's cookie DB
# open — the same reap-or-the-overlay-is-ignored hazard import-login documents.
kill_instance() {
  local profile="$1" unit="$2"
  local was=0
  systemctl is-active --quiet "$unit" 2>/dev/null && was=1
  (( was )) && { log "Stopping ${unit} to edit cookies cleanly."; systemctl stop "$unit" 2>/dev/null || true; }
  local pat="user-data-dir=${profile}" tries
  for tries in 1 2 3 4 5 6 7 8; do
    pkill -f "$pat" 2>/dev/null || true
    pgrep -f "$pat" >/dev/null 2>&1 || break
    sleep 1
  done
  pkill -9 -f "$pat" 2>/dev/null || true
  sleep 1
  return $was
}

extract_domains() {
  require_root
  local profile; profile="$(profile_dir)"
  [[ -d "$profile" ]] || die "Instance ${INSTANCE} has no profile at ${profile}."
  [[ -n "$DOMAINS" ]] || die "Provide --domains sub1,sub2 (host_key substrings)."
  [[ "$DOMAINS" =~ ^[A-Za-z0-9.,_-]+$ ]] || die "The domains must be [A-Za-z0-9.,_-]."
  CK_PROFILE="$profile" CK_DOMAINS="$DOMAINS" python3 - <<'PY'
import os, sqlite3, json, base64, sys
prof = os.environ["CK_PROFILE"]
subs = [s for s in os.environ["CK_DOMAINS"].split(",") if s]
con = sqlite3.connect(f"file:{prof}/Default/Cookies?mode=ro", uri=True)
cur = con.cursor()
cur.execute("PRAGMA table_info(cookies)")
cols = [r[1] for r in cur.fetchall()]
where = " OR ".join(["host_key LIKE ?"] * len(subs))
params = [f"%{s}%" for s in subs]
cur.execute(f"SELECT {','.join(cols)} FROM cookies WHERE {where}", params)
rows = []
for r in cur.fetchall():
    d = {}
    for c, v in zip(cols, r):
        d[c] = {"__b64__": base64.b64encode(bytes(v)).decode()} if isinstance(v, (bytes, bytearray)) else v
    rows.append(d)
con.close()
sys.stdout.write(base64.b64encode(json.dumps({"cols": cols, "rows": rows, "domains": subs}).encode()).decode())
PY
}

merge_domains() {
  require_root
  local profile; profile="$(profile_dir)"
  install -d -m 0700 -o "$DESKTOP_USER" -g "$DESKTOP_USER" "$profile"
  [[ -n "$DOMAINS" ]] || die "Provide --domains sub1,sub2 (host_key substrings)."
  [[ "$DOMAINS" =~ ^[A-Za-z0-9.,_-]+$ ]] || die "The domains must be [A-Za-z0-9.,_-]."
  [[ -n "$BUNDLE_FILE" && -f "$BUNDLE_FILE" ]] || die "Provide --bundle-file PATH (base64 bundle)."
  local unit="linux-browser-vnc-browser@${INSTANCE}.service"
  local was_active=0
  kill_instance "$profile" "$unit" || was_active=$?
  cp -a "$profile/Default/Cookies" "$profile/Default/Cookies.premerge.bak" 2>/dev/null || true
  CK_PROFILE="$profile" CK_DOMAINS="$DOMAINS" CK_BUNDLE="$BUNDLE_FILE" python3 - <<'PY'
import os, sqlite3, json, base64
from pathlib import Path
prof = os.environ["CK_PROFILE"]
subs = [s for s in os.environ["CK_DOMAINS"].split(",") if s]
data = json.loads(base64.b64decode(Path(os.environ["CK_BUNDLE"]).read_text()))
cols, rows = data["cols"], data["rows"]
con = sqlite3.connect(f"{prof}/Default/Cookies")
cur = con.cursor()
cur.execute("PRAGMA table_info(cookies)")
tcols = [r[1] for r in cur.fetchall()]
use = [c for c in cols if c in tcols]
where = " OR ".join(["host_key LIKE ?"] * len(subs))
params = [f"%{s}%" for s in subs]
before = cur.execute(f"SELECT count(*) FROM cookies WHERE {where}", params).fetchone()[0]
cur.execute(f"DELETE FROM cookies WHERE {where}", params)
ph = ",".join("?" * len(use))
ins = 0
for d in rows:
    vals = []
    for c in use:
        v = d.get(c)
        if isinstance(v, dict) and "__b64__" in v:
            v = base64.b64decode(v["__b64__"])
        vals.append(v)
    cur.execute(f"INSERT OR REPLACE INTO cookies ({','.join(use)}) VALUES ({ph})", vals)
    ins += 1
con.commit()
after = cur.execute(f"SELECT count(*) FROM cookies WHERE {where}", params).fetchone()[0]
con.close()
pref = Path(f"{prof}/Default/Preferences")
try:
    pd = json.loads(pref.read_text(encoding="utf-8"))
    pd.setdefault("profile", {})["exit_type"] = "Normal"
    pd["profile"]["exited_cleanly"] = True
    pref.write_text(json.dumps(pd), encoding="utf-8")
except Exception:
    pass
print(f"merged domains={subs} deleted={before} inserted={ins} now={after}")
PY
  chown -R "$DESKTOP_USER":"$DESKTOP_USER" "$profile"
  if (( was_active )) || systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    log "Starting instance ${INSTANCE}."
    systemctl start "$unit" 2>/dev/null || true
  fi
  shred -u "$BUNDLE_FILE" 2>/dev/null || rm -f "$BUNDLE_FILE" 2>/dev/null || true
  log "Instance ${INSTANCE} merged domains ${DOMAINS}."
}

COMMAND="${1:-}"; [[ $# -gt 0 ]] && shift || true
case "$COMMAND" in
  export-login) parse "$@"; export_login ;;
  import-login) parse "$@"; import_login ;;
  extract-domains) parse "$@"; extract_domains ;;
  merge-domains) parse "$@"; merge_domains ;;
  -h|--help|"") usage; [[ -z "$COMMAND" ]] && exit 1 || exit 0 ;;
  *) die "Unknown command: $COMMAND" ;;
esac
