#!/usr/bin/env bash
# onboard-self.sh — 在**新机器自己身上**执行,把这台机器接进 vyibc 机群。
#
# 为什么是自接入而不是远程 SSH:
#   接机器需要 root 执行、建 systemd、建 TUN —— 这些只能在目标机上发生。
#   过去只能由"某个 agent 从外面 SSH 进来"完成,于是就有了"谁来当那个 agent"的问题:
#   CF Worker 不能 SSH(没有能在 workerd 里跑的 SSH 客户端);中枢机器是单点,
#   而且若在机群内,它的出站走自己的 TUN，代理全断时恰好在最需要时失明。
#   跑在机器自己身上,SSH 这一环整个消失,上面的问题一个都不用回答。
#
# 唯一不可省的人工:有 root 的人在这台机器上跑一次。和 k8s join / tailscale up 同形状。
set -Eeuo pipefail

SKILL_TS="${SKILL_TS:-}"          # 可钉住某个发布版本,默认取最新
LINE_ID="${LINE_ID:-line-100}"
INSTANCES="${INSTANCES:-2}"
DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --line) LINE_ID="${2:?}"; shift 2;;
    --instances) INSTANCES="${2:?}"; shift 2;;
    --dry-run) DRY=1; shift;;
    -h|--help) sed -n '2,12p' "$0" >&2; exit 2;;
    *) echo "未知参数 $1" >&2; exit 2;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "要 root 跑:sudo bash $0" >&2; exit 1; }

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31m失败: %s\033[0m\n' "$*" >&2; exit 1; }

# 直连 IPv4:必须是这台机器**自己**的公网地址,不是代理出口。
# 装 clash 之后 curl 会走 TUN,拿到的是出口 IP —— 那时候再问就晚了,所以第一件事就取。
say "0. 认清自己"
# 这台机器**自己**的公网地址,不是代理出口。
# 陷阱:机器上若已有 TUN(手写的 mihomo 也算),root 的 curl 会被它吞掉,
# 拿回来的是当前线路的出口 IP —— 于是同一条线路上的每台机器都算出同一个节点 id,
# 互相覆盖。2026-08-24 在 236 上真踩到:算出 host-63-124-160-54。
# 本机接口地址也靠不住:机器常在 NAT 后面(95 只有 10.7.12.87)。
# 解法:有 tunnel 账号就以它的身份跑(uid 分流,绕开本机 TUN),没有才用 root 直连。
if [[ -n "${FLEET_SELF_IP:-}" ]]; then
  SELF_IP="$FLEET_SELF_IP"
elif id -u linux-clash-tunnel >/dev/null 2>&1; then
  SELF_IP="$(runuser -u linux-clash-tunnel -- curl -fsS --max-time 20 https://api.ipify.org)" \
    || die "以 linux-clash-tunnel 身份取不到本机 IP"
else
  SELF_IP="$(curl -fsS --max-time 20 https://api.ipify.org)" || die "取不到本机公网 IP"
fi
[[ "$SELF_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "取回的不像 IPv4: $SELF_IP"
DASHED="${SELF_IP//./-}"
NODE_ID="host-${DASHED}"
echo "  直连 IP    $SELF_IP"
echo "  节点 id    $NODE_ID"
echo "  线路       $LINE_ID"
# 完整 IP 打横线,由构造保证唯一。别用 IP 的任何一段:末段会撞上已回收机器的 id,
# 首段会让同段的两台机器互相覆盖 —— 两种都实测踩过。

say "1. 装 skill(全部取自发布物,不依赖任何一台特定机器)"
q=""; [[ -n "$SKILL_TS" ]] && q="?ts=$SKILL_TS"
for s in fleet-node-onboard linux-clash-skill linux-browser-vnc; do
  if [[ -x "$HOME/.claude/skills/$s/scripts" ]] || [[ -d "$HOME/.claude/skills/$s" ]]; then
    echo "  $s 已在"
  else
    bash <(curl -fsSL "https://skill.vyibc.com/install-$s.sh$q") claude >/dev/null 2>&1 \
      || die "装不上 $s"
    echo "  $s 已装"
  fi
done
SK="$HOME/.claude/skills"
V="$SK/fleet-node-onboard/scripts/vault.sh"
[[ -x "$V" ]] || die "vault.sh 不在"

say "2. 金库连通性(取不到就别往下走,免得装到一半卡住)"
"$V" get clash:lines >/dev/null || die "够不到金库 clash:lines"
CONFIG_URL="$("$V" get clash:lines | python3 -c '
import sys, json
for e in json.load(sys.stdin):
    if e.get("id") == sys.argv[1]: print(e["config_url"]); break
else: sys.exit(3)' "$LINE_ID")" || die "金库里没有线路 $LINE_ID"
EXPECTED_IP="$("$V" get clash:lines | python3 -c '
import sys, json
for e in json.load(sys.stdin):
    if e.get("id") == sys.argv[1]: print(e["expected_ip"]); break' "$LINE_ID")"
echo "  线路 $LINE_ID 期望出口 $EXPECTED_IP"

# 兜底:自 IP 若等于任何一条线路的出口,那它必然是被 TUN 吞掉的结果,不是这台机器。
# 宁可停下让人显式指定,也不要拿一个会和别台机器相撞的 id 往金库和 D1 里写。
if "$V" get clash:lines | python3 -c '
import sys, json
ips = {e.get("expected_ip") for e in json.load(sys.stdin)}
sys.exit(0 if sys.argv[1] in ips else 1)' "$SELF_IP"; then
  die "本机 IP 被判定为 $SELF_IP,而这是线路出口地址,不是这台机器。
     说明取 IP 时被本机 TUN 吞了。用 FLEET_SELF_IP=<真实直连IP> 重跑。"
fi
echo "  config_url 不回显 —— 它指向的 YAML 里是明文口令"

if [[ $DRY -eq 1 ]]; then say "dry-run:未改动本机"; exit 0; fi

say "3. 建 claude 账号(本地,不需要 SSH)"
# init-node-user.sh 是远程用的(它 SSH 进目标机)。本地这一段直接做,逻辑相同。
# 不去调它再靠失败回落 —— 那样正常路径要先制造一次错误,读日志的人会以为出事了。
{
    id -u claude >/dev/null 2>&1 || useradd --create-home --shell /bin/bash claude
    install -d -m 700 -o claude -g claude /home/claude/.ssh
    PUB="$("$V" get ssh:fleet-operator-pubkey)"
    [[ "$PUB" == ssh-* ]] || die "金库取回的不像公钥"
    touch /home/claude/.ssh/authorized_keys
    grep -qxF "$PUB" /home/claude/.ssh/authorized_keys || printf '%s\n' "$PUB" >> /home/claude/.ssh/authorized_keys
    chown claude:claude /home/claude/.ssh/authorized_keys; chmod 600 /home/claude/.ssh/authorized_keys
    tmp="$(mktemp)"; printf 'claude ALL=(ALL) NOPASSWD:ALL\n' > "$tmp"
    # 写坏 sudoers 会把机器锁死,必须先校验再安装
    visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; die "sudoers 校验失败"; }
    install -m 0440 "$tmp" /etc/sudoers.d/90-claude; rm -f "$tmp"
    printf 'claude:%s' "$("$V" get fleet:default-user-password)" | chpasswd
    echo "  claude 账号就绪(公钥 + 默认口令 + 免密 sudo)"
}

# 账号信息写回金库:一台没登记在金库里的机器,等于只有此刻这个人能登的机器。
printf '# claude@%s · 密钥或口令均可 · 私钥见 ssh:fleet-operator-key,口令见 fleet:default-user-password
user=claude
host=%s
auth=ssh-key,password
password_key=fleet:default-user-password
sudo=nopasswd
' \
  "$SELF_IP" "$SELF_IP" > /tmp/.selfssh
"$V" set "ssh:$NODE_ID" /tmp/.selfssh "机群节点登录方式(claude 账号,自接入写入)" >/dev/null \
  && echo "  已写回金库 ssh:$NODE_ID" || echo "  金库写回失败(不阻断,但要补)" >&2
rm -f /tmp/.selfssh

say "4. 线路表下发(金库是真相源,本机这份是缓存)"
install -d -m 755 /etc/linux-clash-skill
"$V" get clash:lines > /etc/linux-clash-skill/sources.json
chmod 640 /etc/linux-clash-skill/sources.json
python3 -c "import json;d=json.load(open('/etc/linux-clash-skill/sources.json'));print('  %d 条: %s'%(len(d),' / '.join(x['id'] for x in d)))"

say "5. Clash 透明代理 + 控制面"
# config_url 走保护文件,不进 argv —— argv 会进进程表,任何本地用户 ps 一下就看见
umask 077; printf '%s\n' "$CONFIG_URL" > /etc/.clash-config-url; chmod 600 /etc/.clash-config-url
# 已有手写 mihomo 会占着 TUN 让 plan 失败
if systemctl list-unit-files 2>/dev/null | grep -q '^mihomo.service' && [[ ! -f /etc/linux-clash-skill/controller.json ]]; then
  systemctl disable --now mihomo.service 2>/dev/null && echo "  已停用手写 mihomo"
fi
bash "$SK/linux-clash-skill/scripts/linux-clash-skill.sh" install \
  --config-url-file /etc/.clash-config-url --expected-ip "$EXPECTED_IP" || die "clash 装不上"
bash "$SK/linux-clash-skill/scripts/control_plane.sh" install-node \
  --config-url-file /etc/.clash-config-url --expected-ip "$EXPECTED_IP" || die "控制器装不上"
bash "$SK/linux-clash-skill/scripts/control_plane.sh" install-dashboard --dashboard-port 8789 \
  || die "面板装不上"
shred -u /etc/.clash-config-url 2>/dev/null || rm -f /etc/.clash-config-url

say "6. 收工自检"
echo -n "  出口       "; curl -fsS --max-time 20 https://api.ipify.org; echo
id -u linux-clash-tunnel >/dev/null 2>&1 && echo "  tunnel 账号 有" || die "linux-clash-tunnel 缺失"
ss -lntp | grep -q ':8788' && echo "  控制器 8788 在听" || die "控制器没起来"
ss -lntp | grep -q ':8789' && echo "  面板 8789   在听" || die "面板没起来"

cat <<TIP

下一步(还没做,需要 CF 凭据与隧道):
  浏览器+VNC   sudo bash $SK/linux-browser-vnc/scripts/linux-browser-vnc.sh install \\
                  --instances $INSTANCES --novnc-port 6090 --no-public
  域名与注册   见 SKILL.md—— 建隧道 + clash-/vnc- CNAME 与 ingress,
               验证后调 Fleet register。只有明确作为图片工作节点时才追加 imggen 与图片服务。
  本机节点 id  $NODE_ID
TIP
