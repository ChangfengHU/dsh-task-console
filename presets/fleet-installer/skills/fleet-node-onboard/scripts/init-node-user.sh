#!/usr/bin/env bash
# Provision the fleet's standard login account on a machine.
#
# Why this exists: three of the fleet's machines were reached as root over a
# password, which means every routine command runs with no blast radius limit
# and the credential lives in whatever shell history touched it. The standard
# shape is a normal user with passwordless sudo and key-only login, which is
# what host-84 already had; this makes that shape reproducible instead of
# something one machine happens to have.
#
# Idempotent on purpose: it is run against machines that already have the user
# (95 had the account but no key), so every step checks before it writes.
set -euo pipefail

user=claude
pubkey="${HOME}/.ssh/id_ed25519.pub"
vault=true
set_password=true
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --user) user="${2:?}"; shift 2 ;;
    --pubkey) pubkey="${2:?}"; shift 2 ;;
    --no-vault) vault=false; shift ;;
    --no-password) set_password=false; shift ;;
    *) echo "unknown flag: $1" >&2; exit 64 ;;
  esac
done
target="${1:?usage: init-node-user.sh [--user NAME] [--pubkey FILE] [--no-vault] [--no-password] USER@IP}"
host="${target#*@}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 密钥对以金库为准,本地文件只是缓存。
# 换一台操作机、或换一个 agent 来跑,本地 ~/.ssh 里多半什么都没有 —— 要是在这里硬性
# 依赖本地文件,这个能力就又被绑死在某一台机器上了,正是这个 skill 要消灭的东西。
if [[ ! -r "$pubkey" ]] && [[ -x "$here/vault.sh" ]]; then
  echo "本地没有 $pubkey,从金库取 ssh:fleet-operator-pubkey" >&2
  umask 077
  # 名字必须以 .pub 结尾:下面按 ${pubkey%.pub} 推私钥路径,不带后缀会推成同一个文件,
  # 私钥直接把公钥覆盖掉(写这段时真踩了,靠下面那行 ssh-* 校验才抓出来)。
  tmpd="$(mktemp -d)"; pubkey="$tmpd/operator.pub"
  trap 'rm -rf "$tmpd"' EXIT
  "$here/vault.sh" get ssh:fleet-operator-pubkey > "$pubkey" || {
    echo "pubkey-unreadable: 金库里也没有 ssh:fleet-operator-pubkey" >&2; exit 66; }
  # 私钥同取一份:后面要用它从操作机这边回登一次做验收,没有它就只能盲信远端。
  "$here/vault.sh" getfile ssh:fleet-operator-key "${pubkey%.pub}" 2>/dev/null || true
fi
[[ -r "$pubkey" ]] || { echo "pubkey-unreadable: $pubkey" >&2; exit 66; }
key_line="$(cat "$pubkey")"
[[ "$key_line" == ssh-* ]] || { echo "pubkey 内容不像公钥,拒绝写入 authorized_keys" >&2; exit 66; }

ssh_command=(ssh)
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
# Bootstrap credential: how we get in *before* the standard account exists.
# Some machines are already key-only (206), so password is not the only case.
if [[ -n "${SSH_BOOTSTRAP_KEY:-}" ]]; then
  ssh_opts+=(-i "$SSH_BOOTSTRAP_KEY" -o IdentitiesOnly=yes)
fi
if [[ -n "${SSHPASS:-}" ]]; then
  command -v sshpass >/dev/null 2>&1 || { echo "sshpass-required" >&2; exit 5; }
  ssh_command=(sshpass -e ssh)
  ssh_opts=(-o BatchMode=no -o PreferredAuthentications=password,keyboard-interactive -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
fi

# The public key goes in the command line on purpose: it is public, and the
# obvious alternative (piping it in) does not work here — the heredoc that
# carries the script already owns stdin, so a pipe would be silently discarded
# and the remote read would eat the first line of its own script.
"${ssh_command[@]}" "${ssh_opts[@]}" "$target" \
  "FLEET_USER=$user FLEET_KEY=$(printf %q "$key_line") bash -s" <<'REMOTE'
set -euo pipefail
sudo() { if [ "$(id -u)" -eq 0 ]; then "$@"; else command sudo -n "$@"; fi; }
if [ "$(id -u)" -ne 0 ] && ! command sudo -n true 2>/dev/null; then
  echo "admin-access-required: need root or passwordless sudo to provision" >&2
  exit 3
fi
[ -n "${FLEET_KEY:-}" ] || { echo "empty-pubkey" >&2; exit 66; }

if id "$FLEET_USER" >/dev/null 2>&1; then
  echo "user-exists: $FLEET_USER"
else
  sudo useradd --create-home --shell /bin/bash "$FLEET_USER"
  echo "user-created: $FLEET_USER"
fi
home="$(getent passwd "$FLEET_USER" | cut -d: -f6)"
[ -n "$home" ] || { echo "no-home-for-$FLEET_USER" >&2; exit 70; }

sudo install -d -m 0700 -o "$FLEET_USER" -g "$FLEET_USER" "$home/.ssh"
auth="$home/.ssh/authorized_keys"
sudo touch "$auth"
if sudo grep -qxF "$FLEET_KEY" "$auth"; then
  echo "key-already-present"
else
  printf '%s\n' "$FLEET_KEY" | sudo tee -a "$auth" >/dev/null
  echo "key-installed"
fi
sudo chown "$FLEET_USER:$FLEET_USER" "$auth"
sudo chmod 0600 "$auth"

# Written to a temp file and validated before it is put in place: a malformed
# sudoers drop-in locks everyone out of sudo, including the session that would
# have to fix it.
tmp="$(mktemp)"
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$FLEET_USER" > "$tmp"
if visudo -cf "$tmp" >/dev/null; then
  sudo install -m 0440 -o root -g root "$tmp" "/etc/sudoers.d/90-$FLEET_USER"
  echo "sudoers-installed"
else
  rm -f "$tmp"; echo "sudoers-invalid" >&2; exit 71
fi
rm -f "$tmp"
echo "done: $FLEET_USER@$(hostname -I | awk '{print $1}') home=$home"
REMOTE

# 设默认口令。密钥登录是常态,但人要从 VNC / 控制台 / 别的工具进来时需要口令,
# 纯密钥的账号那时候就把人挡在外面了(188/236 上真发生过)。
# 口令走 stdin,不进 argv —— argv 会进远端进程表,任何本地用户 ps 一下就看见。
# 真相源是金库键 fleet:default-user-password,脚本里不写明文:改口令改金库一处,
# 而不是改脚本再重发一遍给所有人。
if [[ "$set_password" == true ]] && [[ -x "$here/vault.sh" ]]; then
  if default_pw="$("$here/vault.sh" get fleet:default-user-password 2>/dev/null)" && [[ -n "$default_pw" ]]; then
    if printf '%s:%s' "$user" "$default_pw" \
       | "${ssh_command[@]}" "${ssh_opts[@]}" "$target" 'sudo -n chpasswd' 2>/dev/null; then
      echo "password-set: $user (值来自金库 fleet:default-user-password)"
    else
      echo "password-set-failed: $user" >&2
    fi
    unset default_pw
  else
    echo "password-skipped: 金库里没有 fleet:default-user-password"
  fi
fi

# Prove it from the outside before claiming success: provisioning that only
# "looked right" on the remote side is exactly the class of failure that shows
# up later as "I can't get in".
key_file="${pubkey%.pub}"
if [[ -r "$key_file" ]]; then
  if ssh -i "$key_file" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new \
       "$user@$host" 'test "$(whoami)" = '"$user"' && sudo -n true' 2>/dev/null; then
    echo "verified: key login + passwordless sudo works as $user@$host"
  else
    echo "verify-failed: could not log in as $user@$host with $key_file" >&2
    exit 75
  fi
else
  echo "verify-skipped: no private key at $key_file"
fi

# Vault sync is part of this capability, not a follow-up someone has to
# remember. A machine whose access is not in the vault is a machine only this
# laptop can reach — which is the same as a machine nobody can reach once the
# laptop is gone.
if [[ "$vault" == true ]]; then
  # 节点 id = 完整 IP 打横线,由构造保证唯一。
  #
  # 别用 IP 的任何一段:末段和首段都会撞。实测踩过两次 ——
  # 按末段:84.8.217.45→host-45、206.189.196.65→host-65,而 107.150.119.232→**host-232**,
  #         那是已被云厂商回收的另一台机器的 id,金库里立刻多出一条指错机器的记录;
  # 按首段:129.146.55.188 和 129.213.30.236 都会变成 host-129,后写的覆盖先写的。
  # 只有完整 IP 才唯一,而且这也正是机群其他地方一直在用的命名:
  # clash-129-146-55-188.vyibc.com / vnc-129-146-55-188 / 注册用的 host-129-146-55-188。
  node_id="${FLEET_NODE_ID:-host-${host//./-}}"
fi

# 认不出 id 就别写 —— 宁可不写,也不要在金库里凭空造一个指错机器的键。
if [[ "$vault" == true && -n "${node_id:-}" ]]; then
  # Never download an admin credential from a public endpoint. In DSH, stage 3
  # writes and reads this record through the permission-scoped vault MCP.
  token="${FLEET_VAULT_TOKEN:-}"
  if [[ -z "$token" ]]; then
    echo "vault-skipped: no admin token available" >&2
  else
    # 记录必须跟着实际能力走。设了口令却记 auth=ssh-key,金库就开始说假话 ——
    # 下一个人照着记录只带密钥来,发现进不去 VNC 控制台,又得重新摸一遍。
    if [[ "$set_password" == true ]]; then
      auth_line="auth=ssh-key,password
password_key=fleet:default-user-password"
      auth_note="密钥或口令均可 · 私钥见 ssh:fleet-operator-key,口令见 fleet:default-user-password"
    else
      auth_line="auth=ssh-key"
      auth_note="key auth · 私钥见金库键 ssh:fleet-operator-key"
    fi
    body=$(printf '%s' "# $user@$host · $auth_note
user=$user
host=$host
$auth_line
sudo=nopasswd")
    payload=$(python3 - "$node_id" "$body" <<'PY'
import json, sys
print(json.dumps({"key": "ssh:" + sys.argv[1], "value": sys.argv[2],
                  "description": "机群节点登录方式(由 init-node-user.sh 写入)"}))
PY
)
    if curl -fsS -X POST https://fleet.vyibc.com/api/config/set \
         -H "Authorization: Bearer $token" -H 'content-type: application/json' \
         -d "$payload" >/dev/null; then
      # Read back: set_config returning ok is not proof the value is retrievable.
      if curl -fsS -X POST https://fleet.vyibc.com/api/config/get \
           -H "Authorization: Bearer $token" -H 'content-type: application/json' \
           -d "{\"key\":\"ssh:$node_id\"}" | grep -q "auth=ssh-key"; then
        echo "vault-synced: ssh:$node_id (读回已验证)"
      else
        echo "vault-readback-failed: ssh:$node_id" >&2; exit 76
      fi
    else
      echo "vault-write-failed: ssh:$node_id" >&2; exit 76
    fi
  fi
fi
