#!/usr/bin/env bash
# Secrets from config/secrets.json into $TM_ROOT/secrets/<service>/<name>.
#   sudo scripts/secrets-setup.sh                   → RESULT=secrets-ready | secrets-missing <names>
#   sudo scripts/secrets-setup.sh --cookies <file>  → RESULT=cookies-updated
# External values are asked one per hidden line; internal tokens, bot_principals
# and the OpenViking configuration are computed. Any change is applied as one
# consistent set; on an installed stack the affected services are recreated.
source "$(dirname "$0")/lib.sh"
cookies=
if (($# == 2)) && [[ $1 == --cookies ]]; then cookies=$2
elif (($# != 0)); then usage "usage: sudo scripts/secrets-setup.sh [--cookies <file>]"
fi
tm_start secrets-setup
recover_secrets
STAGE=secrets

# name source services hint, one secret per line
catalog=$(py "$REPO/config/secrets.json" <<'PY'
import json, sys
for s in json.load(open(sys.argv[1])): print(s["name"], s["source"], ",".join(s["services"]), s["hint"])
PY
)
services_of() { awk -v n="$1" '$1 == n { print $3 }' <<<"$catalog" | tr , ' '; }
exists() { local svc; for svc in $(services_of "$1"); do [[ -f $SECRETS/$svc/$1 ]] || return 1; done; }
put() { # put <name> <value>: into every service of the secret, never logged
  local svc
  for svc in $(services_of "$1"); do
    mkdir -p "$SECRETS.new/$svc" && chmod 0700 "$SECRETS.new/$svc"
    printf '%s' "$2" >"$SECRETS.new/$svc/$1"
    chmod 0444 "$SECRETS.new/$svc/$1"
  done
}
token() { python3 -c 'import secrets; print(secrets.token_hex(32))'; }
prepare() {
  rm -rf "$SECRETS.new"
  mkdir -m 0700 "$SECRETS.new"
  if [[ -d $SECRETS ]]; then cp -a "$SECRETS/." "$SECRETS.new/"; fi
}
drop() { rm -rf "$SECRETS.new"; fail secrets "$1"; }

if [[ -n $cookies ]]; then
  [[ -f $cookies ]] || fail secrets "no cookies file: $cookies"
  python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$cookies" 2>/dev/null || fail secrets "cookies file is not valid JSON"
  prepare
  mkdir -p "$SECRETS.new/telegram-mcp" && chmod 0700 "$SECRETS.new/telegram-mcp"
  cp "$cookies" "$SECRETS.new/telegram-mcp/notebooklm_cookies"
  chmod 0444 "$SECRETS.new/telegram-mcp/notebooklm_cookies"
  apply_set
  rm -f -- "$cookies"
  say "cookies written, source file removed"
  result 0 cookies-updated
fi

keep() { # keep <name>: an existing secret stays unless the owner asks to replace it
  exists "$1" && keep_answer "$1"
}
keep_answer() {
  printf '%s: есть. Оставить [Enter] или заменить (з)? ' "$1" >&3
  local answer
  IFS= read -r answer || true
  case $answer in з*|З*|r*|R*) return 1 ;; esac
  say "$1: kept"
}
secret_input() { # secret_input <name> <hint> → REPLY, hidden, one line
  printf '%s — %s: ' "$1" "$2" >&3
  IFS= read -rs REPLY || true
  printf '\n' >&3
}
valid() {
  case $1 in
    owner_user_id | telegram_api_id) [[ $2 =~ ^[0-9]+$ ]] ;;
    telegram_api_hash) [[ $2 =~ ^[0-9a-fA-F]{32}$ ]] ;;
    *_bot_token) [[ $2 =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] ;;
    *) [[ -n $2 && $2 != *[[:space:]]* ]] ;;
  esac
}

prepare
missing=() invalid=() openviking_done=
while read -r name source _ hint <&4; do
  case $source in
    ask)
      keep "$name" && continue
      secret_input "$name" "$hint"
      if [[ -z $REPLY ]]; then exists "$name" && say "$name: kept" || missing+=("$name")
      else valid "$name" "$REPLY" || invalid+=("$name"); put "$name" "$REPLY"; say "$name: written"; fi ;;
    generate)
      keep "$name" && continue
      put "$name" "$(token)"
      say "$name: generated" ;;
    openviking)
      [[ -n $openviking_done ]] && continue
      openviking_done=1
      if exists ov.conf && exists openviking_api_key && keep_answer "OpenViking (ov.conf, openviking_api_key)"; then continue; fi
      secret_input "ключ embedding OpenViking" "ключ API модели эмбеддингов"; embedding=$REPLY
      secret_input "ключ vlm OpenViking" "ключ API модели vlm"; vlm=$REPLY
      if [[ -z $embedding || -z $vlm ]]; then
        if exists ov.conf && exists openviking_api_key; then say "OpenViking: kept"; else missing+=(ov.conf openviking_api_key); fi
        continue
      fi
      valid ov.conf "$embedding" && valid ov.conf "$vlm" || invalid+=(ov.conf)
      root_key=$(token)
      conf=$(python3 -c '
import json, sys
root, embedding, vlm = sys.stdin.read().split("\n")[:3]
c = json.load(open(sys.argv[1]))
c["server"]["root_api_key"] = root
c["embedding"]["dense"]["api_key"] = embedding
c["vlm"]["api_key"] = vlm
print(json.dumps(c, indent=2))' "$REPO/config/openviking.conf.json" <<<"$root_key"$'\n'"$embedding"$'\n'"$vlm")
      put ov.conf "$conf"
      put openviking_api_key "$root_key"
      say "OpenViking: root key generated, ov.conf assembled" ;;
    file)
      [[ -f $SECRETS.new/telegram-mcp/$name ]] || missing+=("$name") ;;
  esac
done 4<<<"$catalog"

((${#invalid[@]} == 0)) || drop "invalid input: ${invalid[*]}"

# bot_principals: SHA-256 of each bot token with the fixed role from the catalog.
principals=$(py "$SECRETS.new" "$REPO/config/secrets.json" <<'PY'
import hashlib, json, os, sys
root, catalog = sys.argv[1], json.load(open(sys.argv[2]))
out = []
for s in catalog:
    if not s.get("principal"): continue
    path = os.path.join(root, "bots", s["name"])
    if not os.path.isfile(path): sys.exit(0)
    out.append({**s["principal"], "token_sha256": hashlib.sha256(open(path, "rb").read()).hexdigest()})
print(json.dumps(out))
PY
)
if [[ -n $principals ]]; then put bot_principals "$principals"; else missing+=(bot_principals); fi

apply_set
((${#missing[@]} == 0)) || result 1 "secrets-missing ${missing[*]}"
result 0 secrets-ready
