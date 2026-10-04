#!/usr/bin/env bash
# install-clash.sh — 在目标机上装 linux-clash-skill 的透明代理,线路从金库取。
#
# 为什么不是"机器上已经有 mihomo 就算装好了":机群要的不只是代理能通,还要
# linux-clash-tunnel 账号(linux-browser-vnc 硬依赖它,没有就装不下去)、
# /etc/linux-clash-skill/ 布局、8788 控制器、8789 面板。手写配置的 mihomo 一样都没有。
# 188/236 就处于这个状态:代理通,但机群看不见它们。
#
# 用法: install-clash.sh <ip> --line line-100 [--ssh-user claude] [--dry-run]
set -euo pipefail

HOST=""; LINE_ID=""; SSH_USER="claude"; DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --line) LINE_ID="${2:?}"; shift 2;;
    --ssh-user) SSH_USER="${2:?}"; shift 2;;
    --dry-run) DRY=1; shift;;
    -h|--help) echo "用法: $0 <ip> --line <id> [--ssh-user claude] [--dry-run]" >&2; exit 2;;
    *) HOST="$1"; shift;;
  esac
done
[[ -n "$HOST" && -n "$LINE_ID" ]] || { echo "用法: $0 <ip> --line <id>" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o BatchMode=yes)
sh_() { ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" "$@"; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31m失败: %s\033[0m\n' "$*" >&2; exit 1; }

# 自打自拦截:装 clash 要重建 TUN,在目标机上跑等于把自己的网络断在半路。
# 用 machine-id 比,不用 IP —— 机群的机器多在 NAT 后面,hostname -I 看不到自己的公网地址。
if [[ -r /etc/machine-id ]]; then
  rmid="$(sh_ 'cat /etc/machine-id 2>/dev/null' | tr -d '\r\n ')"
  [[ -n "$rmid" && "$rmid" == "$(cat /etc/machine-id)" ]] && \
    die "$HOST 就是你自己这台机器。换一台机器起 agent,SSH 过去操作。"
fi

say "1. 从金库解析线路 $LINE_ID"
read -r CONFIG_URL EXPECTED_IP < <(
  "$here/vault.sh" get clash:lines | python3 -c '
import sys, json
for e in json.load(sys.stdin):
    if e.get("id") == sys.argv[1]:
        print(e["config_url"], e["expected_ip"]); break
else:
    sys.exit(3)
' "$LINE_ID") || die "金库 clash:lines 里没有 $LINE_ID"
echo "  expected_ip  $EXPECTED_IP"
echo "  config_url   (不回显 —— 那个 URL 指向的 YAML 里是明文口令)"

if [[ $DRY -eq 1 ]]; then say "dry-run:未改动目标机"; exit 0; fi

say "2. 确保目标机上有 linux-clash-skill"
# 装的是**发布物**,不是操作机上的副本 —— 这样换任何一台机器起 agent,结果都一样。
# (2026-08-24 教训:发布物曾比仓库落后近一个月,仓库修了的 bug 发布物还在,
#  外部 agent 照着装必然失败。所以这里刻意走公开安装命令,顺带持续检验发布物是活的。)
sh_ 'if [ -x ~/.claude/skills/linux-clash-skill/scripts/linux-clash-skill.sh ]; then
       echo "  已存在,跳过"
     else
       bash <(curl -fsSL https://skill.vyibc.com/install-linux-clash-skill.sh) claude >/dev/null 2>&1
       [ -x ~/.claude/skills/linux-clash-skill/scripts/linux-clash-skill.sh ] \
         && echo "  已安装" || { echo "  安装失败" >&2; exit 1; }
     fi' || die "目标机上装不了 linux-clash-skill"

say "3. 停掉手写的 mihomo(它占着 TUN,plan 会因为路由被捕获而失败)"
# 只停"不是 linux-clash-skill 装的"那一个。skill 自己的单元叫别的名字,不会误伤。
sh_ 'if systemctl list-unit-files 2>/dev/null | grep -q "^mihomo.service"; then
       if [ ! -d /etc/linux-clash-skill ]; then
         sudo -n systemctl disable --now mihomo.service && echo "  已停用手写 mihomo.service"
       else
         echo "  /etc/linux-clash-skill 已存在,不动现有单元"
       fi
     else echo "  没有 mihomo.service,跳过"; fi'

say "4. 把 config_url 写进目标机的保护文件(不走 argv —— argv 会进远端进程表)"
printf '%s\n' "$CONFIG_URL" | sh_ 'umask 077; cat > /tmp/.cfgurl && sudo -n install -m 600 -o root /tmp/.cfgurl /etc/.clash-config-url && rm -f /tmp/.cfgurl && echo "  已写入"'

say "5. plan(只读预检)"
sh_ "sudo -n bash ~/.claude/skills/linux-clash-skill/scripts/linux-clash-skill.sh plan \
     --config-url-file /etc/.clash-config-url --expected-ip '$EXPECTED_IP' 2>&1 | tail -15; exit \${PIPESTATUS[0]}" \
  || die "plan 未通过,不装"

say "6. install"
sh_ "sudo -n bash ~/.claude/skills/linux-clash-skill/scripts/linux-clash-skill.sh install \
     --config-url-file /etc/.clash-config-url --expected-ip '$EXPECTED_IP' 2>&1 | tail -20; exit \${PIPESTATUS[0]}" \
  || die "install 未通过"

say "7. 控制面(8788 控制器 + 8789 面板)"
# 这一步不是可选的:linux-clash-tunnel 账号、8788 控制器、8789 面板都由它建,
# 而 linux-browser-vnc 硬依赖那个账号,机群页面则依赖 8789。
# 只装 install 就宣布"clash 装好了"是半成品 —— 代理通,但机群看不见这台机器。
sh_ "sudo -n bash ~/.claude/skills/linux-clash-skill/scripts/control_plane.sh install-node \
     --config-url-file /etc/.clash-config-url --expected-ip '$EXPECTED_IP' 2>&1 | tail -8; exit \${PIPESTATUS[0]}" \
  || die "control_plane install-node 未通过"
sh_ "sudo -n bash ~/.claude/skills/linux-clash-skill/scripts/control_plane.sh install-dashboard \
     --dashboard-port 8789 2>&1 | tail -8; exit \${PIPESTATUS[0]}" \
  || die "control_plane install-dashboard 未通过"

sh_ 'sudo -n shred -u /etc/.clash-config-url 2>/dev/null || sudo -n rm -f /etc/.clash-config-url'

say "8. 验收"
sh_ 'echo -n "  出口       "; curl -s --max-time 20 https://api.ipify.org; echo
     echo -n "  tunnel 账号 "; id -u linux-clash-tunnel >/dev/null 2>&1 && echo 存在 || echo "缺失(linux-browser-vnc 会装不下去)"
     echo -n "  控制器 8788 "; sudo -n ss -lntp | grep -q ":8788" && echo 在听 || echo 未监听'
printf '\n\033[32m完成。出口必须等于 %s,tunnel 账号必须存在,否则下一步装不下去。\033[0m\n' "$EXPECTED_IP"
