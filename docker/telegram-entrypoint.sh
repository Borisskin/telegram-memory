#!/bin/sh
set -eu

read_secret() {
    value=$(tr -d '\r\n' < "$1")
    [ -n "$value" ] || { echo "empty secret: $1" >&2; exit 2; }
    printf '%s' "$value"
}

export TELEGRAM_API_ID="$(read_secret /run/secrets/telegram_api_id)"
export TELEGRAM_API_HASH="$(read_secret /run/secrets/telegram_api_hash)"
export TELEGRAM_SESSION_STRING="$(read_secret /run/secrets/telegram_session_string)"

# The vendor process accepts credentials through environment variables; the
# source files remain mounted as Docker secrets and never enter the image.

# NotebookLM: the secret holds the owner's initial cookies; nlm state (rotating
# cookies and CSRF) lives in the data volume. Copy the secret only when its
# content hash changes (or the state copy is gone): a recreated container must
# not overwrite the cookies nlm has rotated since the last applied secret.
nlm_state="${NOTEBOOKLM_MCP_CLI_PATH:-/app/data/nlm}"
nlm_cookies="$nlm_state/profiles/default/cookies.json"
secret_hash_file="$nlm_state/.notebooklm_cookies.sha256"
if [ -s /run/secrets/notebooklm_cookies ]; then
    secret_hash=$(sha256sum /run/secrets/notebooklm_cookies | cut -d' ' -f1)
    applied_hash=""
    [ -f "$secret_hash_file" ] && applied_hash=$(cat "$secret_hash_file")
    if [ "$secret_hash" != "$applied_hash" ] || [ ! -f "$nlm_cookies" ]; then
        mkdir -p "$nlm_state/profiles/default"
        cp /run/secrets/notebooklm_cookies "$nlm_cookies"
        printf '%s\n' "$secret_hash" > "$secret_hash_file"
    fi
fi

# Both MCP servers start here; exit of either stops the container and the
# restart policy brings it back.
python /app/main.py /exchange &
telegram_pid=$!
notebooklm-mcp &
notebook_pid=$!

# The image's sh is busybox, which has no `wait -n`: poll both processes.
trap 'kill "$telegram_pid" "$notebook_pid" 2>/dev/null' TERM INT
while kill -0 "$telegram_pid" 2>/dev/null && kill -0 "$notebook_pid" 2>/dev/null; do
    sleep 2
done
kill "$telegram_pid" "$notebook_pid" 2>/dev/null || true
wait
exit 1
