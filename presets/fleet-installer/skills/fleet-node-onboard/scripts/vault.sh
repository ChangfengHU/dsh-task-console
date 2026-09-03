#!/usr/bin/env bash
# vault.sh — vyibc 金库的取与存。只在可信运行时注入管理员令牌后使用。
set -euo pipefail

VAULT_URL="${VAULT_URL:-https://fleet.vyibc.com/mcp/vault}"

usage() {
  cat >&2 <<'USAGE'
用法:
  vault.sh get <key>                    取值,原样打到 stdout(JSON 值会被格式化成紧凑 JSON)
  vault.sh getfile <key> <出口路径>      取值写成文件,600 权限,并补回结尾换行(私钥必须走这个)
  vault.sh set <key> <值文件> [说明]     把文件内容存进去
  vault.sh list                          列出所有键名(不含值)

令牌:必须由可信运行时通过 FLEET_VAULT_TOKEN 注入，不从公开接口下载。
USAGE
  exit 2
}

vault_token() {
  [[ -n "${FLEET_VAULT_TOKEN:-}" ]] || {
    echo "FLEET_VAULT_TOKEN is required; use the vyibc-vault MCP in DSH" >&2
    return 77
  }
  printf '%s' "$FLEET_VAULT_TOKEN"
}

# curl,不是 python3 urllib:在挂了全局 TUN 的机器上 urllib 打这些端点会吃 403,
# curl 不会。今天实测过(写 clash:lines 时踩到)。
call() {
  local payload="$1" tok
  tok="$(vault_token)"
  curl -fsS -m 60 -X POST "$VAULT_URL" \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $tok" \
    --data "$payload"
}

# 金库对 JSON 值会自动解析,value 取回来可能是 dict/list 而不是 str;
# 纯文本值则原样是 str。两种都要兼容,否则私钥和线路表只能对一个。
extract() {
  python3 -c '
import sys, json
d = json.load(sys.stdin)
if "error" in d:
    sys.stderr.write("金库返回错误: %s\n" % json.dumps(d["error"], ensure_ascii=False)); sys.exit(1)
t = d["result"]["content"][0]["text"]
try: outer = json.loads(t)
except Exception: print(t, end=""); sys.exit()
if not outer.get("ok", True):
    sys.stderr.write("金库返回 not ok: %s\n" % t[:200]); sys.exit(1)
v = outer.get("value", "")
print(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False), end="")
'
}

cmd="${1:-}"; shift || usage
case "$cmd" in
  get)
    [[ $# -eq 1 ]] || usage
    call "$(python3 -c 'import json,sys;print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_config","arguments":{"key":sys.argv[1]}}}))' "$1")" | extract
    ;;
  getfile)
    [[ $# -eq 2 ]] || usage
    out="$2"
    umask 077
    "$0" get "$1" > "$out"
    # 金库会吃掉字符串结尾的换行。ssh/openssl 等工具对私钥缺尾换行会直接报格式错,
    # 而报错信息看起来像"密钥不对",极难往这上面想。这里无条件补回。
    [[ -s "$out" ]] || { echo "金库键 $1 取回来是空的" >&2; exit 1; }
    [[ "$(tail -c1 "$out" | od -An -tx1 | tr -d ' \n')" == "0a" ]] || printf '\n' >> "$out"
    chmod 600 "$out"
    ;;
  set)
    [[ $# -ge 2 ]] || usage
    call "$(python3 -c '
import json,sys
key, path = sys.argv[1], sys.argv[2]
desc = sys.argv[3] if len(sys.argv) > 3 else ""
print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"set_config",
  "arguments":{"key":key,"value":open(path).read(),"description":desc}}}))' "$1" "$2" "${3:-}")" | extract
    ;;
  list)
    call '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_configs","arguments":{}}}' \
      | python3 -c 'import sys,json,re;print("\n".join(sorted(set(re.findall(r"[a-z0-9-]+:[A-Za-z0-9_.-]+", sys.stdin.read())))))'
    ;;
  *) usage;;
esac
