#!/usr/bin/env bash
# Bot settings: the model proxy URL and the model of the shared Talker.
#   sudo scripts/config-setup.sh      → RESULT=configured
# Writes $TM_ROOT/config/bots.json; on an installed stack recreates bots.
source "$(dirname "$0")/lib.sh"
(($# == 0)) || usage "usage: sudo scripts/config-setup.sh"
tm_start config-setup
recover_secrets
STAGE=config

read -r current_url current_model < <(py "$BOTS_CONFIG" <<'PY'
import json, sys
try: c = json.load(open(sys.argv[1])); print(c["model"]["base_url"], c["talkers"][0]["model"])
except (OSError, ValueError, KeyError, IndexError): print("- -")
PY
)
[[ $current_url == - ]] && current_url= && current_model=

ask() { # ask <prompt> <default> → REPLY
  printf '%s%s: ' "$1" "${2:+ [$2]}" >&3
  IFS= read -r REPLY || true
  REPLY=${REPLY:-$2}
}
ask "Адрес прокси модели (OpenAI-совместимый, https://…/v1)" "$current_url"; url=$REPLY
ask "Модель Собеседника «общий»" "$current_model"; model=$REPLY
mkdir -p "$TM_ROOT/config" && chmod 0755 "$TM_ROOT/config"
new=$BOTS_CONFIG.new
py "$url" "$model" "$new" <<'PY' || fail config "invalid answers (see log)"
import json, sys
from urllib.parse import urlparse
url, model, out = sys.argv[1:]
if urlparse(url).scheme not in ("http", "https") or not urlparse(url).netloc: sys.exit("model proxy URL must be http(s)")
if urlparse(url).username or urlparse(url).password: sys.exit("model proxy URL must not contain credentials: the key goes to model_api_key")
if not model.strip() or any(c.isspace() for c in model): sys.exit("model name must be one word")
config = {
  "owner_user_id_file": "/run/secrets/owner_user_id",
  "coordinator_url": "http://coordinator:8787/mcp",
  "model": {"base_url": url, "api_key_file": "/run/secrets/model_api_key"},
  "receiver": {"bot_token_file": "/run/secrets/receiver_bot_token", "coord_token_file": "/run/secrets/receiver_coord_token"},
  "talkers": [{"name": "shared", "bot_token_file": "/run/secrets/talker_shared_bot_token",
               "coord_token_file": "/run/secrets/talker_shared_coord_token", "model": model, "owner_only": False, "digest": False}],
}
open(out, "w").write(json.dumps(config, indent=2, ensure_ascii=False) + "\n")
PY
say "model proxy: $url, model: $model"
if cmp -s "$new" "$BOTS_CONFIG"; then
  rm -f "$new"
  say "settings unchanged"
  result 0 configured
fi
chmod 0444 "$new"
mv -f "$new" "$BOTS_CONFIG"
say "settings written: $BOTS_CONFIG"
recreate bots
result 0 configured
