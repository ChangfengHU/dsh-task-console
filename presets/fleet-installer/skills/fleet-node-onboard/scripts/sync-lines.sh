#!/usr/bin/env bash
# sync-lines.sh — 把金库 clash:lines 下发到机器的 /etc/linux-clash-skill/sources.json
#
# 真相源是金库那一份,机器上这份是缓存。这么分是因为两个现有消费者
# (node_controller.probe_lines 的线路矩阵、dashboard.py 的切换下拉)直接读本地文件,
# 让它们改去打金库既没必要又会在断网时把面板拖垮。
#
# 用法: sync-lines.sh <ip> [--ssh-user claude] [--dry-run]
set -euo pipefail

HOST=""; SSH_USER="claude"; DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssh-user) SSH_USER="$2"; shift 2;;
    --dry-run) DRY=1; shift;;
    -h|--help) echo "用法: $0 <ip> [--ssh-user claude] [--dry-run]" >&2; exit 2;;
    *) HOST="$1"; shift;;
  esac
done
[[ -n "$HOST" ]] || { echo "用法: $0 <ip> [--ssh-user claude] [--dry-run]" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o BatchMode=yes)

umask 077
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
"$here/vault.sh" get clash:lines > "$tmp"

# 下发前先验形状。sources.json 写坏会让线路矩阵和面板下拉一起哑掉,
# 而两者都不会报错,只会安静地少东西 —— 这种失败最难发现。
python3 - "$tmp" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert isinstance(d, list) and d, "clash:lines 不是非空数组"
for e in d:
    for k in ("id", "label", "config_url", "expected_ip"):
        assert e.get(k), f"线路 {e.get('id','?')} 缺字段 {k}"
    assert e["config_url"].startswith("https://"), f"{e['id']} 的 config_url 不是 https"
print("  校验通过:%d 条 —— %s" % (len(d), " / ".join(x["id"] for x in d)))
PY

if [[ $DRY -eq 1 ]]; then echo "  dry-run:未下发"; exit 0; fi

# 权限沿用既有约定:640 root:linux-clash-dashboard —— 面板要读它,别人不该读
# (config_url 本身即凭据,那些 YAML 里是明文口令)。
# 该组在装 dashboard 之前不存在,所以 chgrp 失败不算致命。
# stdin 只能有一个主人。上一版同时写了 `<"$tmp"` 和 `<<'REMOTE'`,heredoc 赢了,
# JSON 被丢弃、cat 吃掉的是脚本自己,结果安静地什么都没干还退出 0。
# 所以:**脚本走 argv(不敏感),JSON 走 stdin**。
# 反过来不行 —— config_url 本身即凭据(那些 YAML 里是明文口令),进 argv 就进了远端进程表。
remote_script=$(cat <<'REMOTE'
set -euo pipefail
install -d -m 755 /etc/linux-clash-skill
if [ -f /etc/linux-clash-skill/sources.json ]; then
  cp -a /etc/linux-clash-skill/sources.json \
     "/etc/linux-clash-skill/sources.json.bak.$(date +%Y%m%d%H%M%S)"
fi
install -m 640 -o root /tmp/.lines.new /etc/linux-clash-skill/sources.json
# 该组在装 dashboard 之前不存在,chgrp 失败不算致命
chgrp linux-clash-dashboard /etc/linux-clash-skill/sources.json 2>/dev/null || true
rm -f /tmp/.lines.new
python3 -c "import json;d=json.load(open('/etc/linux-clash-skill/sources.json'));print('  已下发 %d 条: %s' % (len(d), ' / '.join(x['id'] for x in d)))"
REMOTE
)
b64="$(printf '%s' "$remote_script" | base64 | tr -d '\n')"

ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" \
  "printf %s '$b64' | base64 -d > /tmp/.sync-lines.sh && cat > /tmp/.lines.new && sudo -n bash /tmp/.sync-lines.sh; rc=\$?; rm -f /tmp/.sync-lines.sh; exit \$rc" \
  < "$tmp"
