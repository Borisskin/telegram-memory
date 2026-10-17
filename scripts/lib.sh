# Shared internals of the deployment scripts; sourced, never run directly.
# Contract for every script: run under sudo (otherwise exit 2), one script at a
# time (flock on $TM_ROOT/lock), full log in /var/log/telegram-memory, secret
# values never printed or logged, last line `RESULT=<word> [details] LOG=<path>`,
# exit codes 0 success, 1 failure, 2 wrong invocation.

set -Eeuo pipefail
umask 077

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TM_ROOT=${TM_ROOT:-/etc/telegram-memory}
LOG_DIR=/var/log/telegram-memory
SECRETS=$TM_ROOT/secrets
STATE=$TM_ROOT/state/applied
BOTS_CONFIG=$TM_ROOT/config/bots.json
LOG=none
STAGE=start
export TM_ROOT

# Screen gets short steps (fd 3), the log gets everything.
say() { printf '%s\n' "$*" >&3; printf '[%(%F %T)T] %s\n' -1 "$*"; }

result() {
  local code=$1; shift
  # Inside a command substitution only the parent reports the result.
  [[ $BASHPID == "$$" ]] || exit "$code"
  printf 'RESULT=%s LOG=%s\n' "$*" "$LOG" >&3
  printf 'RESULT=%s LOG=%s\n' "$*" "$LOG"
  exit "$code"
}

fail() { result 1 "failed $*"; }

usage() {
  printf '%s\n' "$1" >&2
  printf 'RESULT=failed usage LOG=%s\n' "$LOG" >&2
  exit 2
}

# tm_start <script-name>: root check, log with rotation, lock.
tm_start() {
  local name=$1
  exec 3>&1
  trap 'fail "$STAGE" "unexpected error at line $LINENO (see log)"' ERR
  [[ $(id -u) == 0 ]] || usage "run with sudo: sudo scripts/$name.sh"
  mkdir -p "$LOG_DIR" && chmod 0750 "$LOG_DIR"
  LOG=$LOG_DIR/$name-$(date +%Y%m%d-%H%M%S).log
  [[ -e $LOG ]] && LOG=$LOG_DIR/$name-$(date +%Y%m%d-%H%M%S)-$$.log
  exec >>"$LOG" 2>&1
  mkdir -p "$TM_ROOT" && chmod 0755 "$TM_ROOT"
  # update.sh restarting itself keeps the lock it already holds on fd 9.
  [[ -n ${TM_REEXEC:-} ]] || exec 9>"$TM_ROOT/lock"
  flock -n 9 || result 1 "failed busy"
  # Rotate only under the lock: a busy run must not delete anything.
  # Keep the last 30 logs of this script including the one started now.
  { ls -1t "$LOG_DIR/$name"-*.log 2>/dev/null || true; } | tail -n +31 | xargs -r rm -f --
  say "$name: TM_ROOT=$TM_ROOT"
}

# JSON and other parsing is done by python3 (present on Ubuntu; jq is not).
py() { python3 - "$@"; }

tm_env() {
  TM_VERSION=$(tr -d '[:space:]' <"$REPO/VERSION")
  [[ $TM_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail version "VERSION is not three numbers: $TM_VERSION"
  OPENVIKING_IMAGE=$(vendor openviking image)
  export TM_VERSION OPENVIKING_IMAGE
}

vendor() { py "$REPO/config/vendors.json" "$1" "$2" <<'EOF'
import json, sys
print(json.load(open(sys.argv[1]))[sys.argv[2]][sys.argv[3]])
EOF
}

dc() { docker compose --project-directory "$REPO" -f "$REPO/compose.yaml" "$@"; }

applied() { [[ -f $STATE ]]; }

# Interrupted replacement: secrets.new without secrets means the swap stopped
# between the two renames, so the prepared set is complete and is finished;
# both present means preparation stopped, so the partial set is dropped.
recover_secrets() {
  if [[ -d $SECRETS.new && ! -d $SECRETS ]]; then
    say "finishing an interrupted secrets replacement"
    validate_set "$SECRETS.new" || fail secrets "interrupted set is inconsistent: $SECRETS.new"
    mv "$SECRETS.new" "$SECRETS"
  elif [[ -d $SECRETS.new ]]; then
    say "dropping an interrupted secrets preparation"
    rm -rf "$SECRETS.new"
  fi
}

# validate_set <dir>: consistency of the files present in a secrets set.
validate_set() { py "$1" "$REPO/config/secrets.json" <<'EOF'
import hashlib, json, os, sys
root, catalog = sys.argv[1], json.load(open(sys.argv[2]))
def read(service, name):
    try: return open(os.path.join(root, service, name)).read()
    except FileNotFoundError: return None
errors = []
tokens = {s["name"]: s for s in catalog if s.get("principal")}
principals = read("coordinator", "bot_principals")
if principals is not None:
    expected = []
    for name, s in tokens.items():
        token = read("bots", name)
        if token is None: errors.append(f"bot_principals without {name}"); continue
        expected.append({**s["principal"], "token_sha256": hashlib.sha256(token.encode()).hexdigest()})
    if json.loads(principals) != expected: errors.append("bot_principals does not match the bot tokens")
conf, key = read("openviking", "ov.conf"), read("coordinator", "openviking_api_key")
if (conf is None) != (key is None): errors.append("ov.conf and openviking_api_key must be present together")
elif conf is not None and json.loads(conf)["server"]["root_api_key"] != key: errors.append("OpenViking root key differs in ov.conf and openviking_api_key")
owners = {read(s, "owner_user_id") for s in ("coordinator", "bots")}
if len(owners) > 1: errors.append("owner_user_id differs between coordinator and bots")
cookies = read("telegram-mcp", "notebooklm_cookies")
if cookies is not None:
    try: json.loads(cookies)
    except ValueError: errors.append("notebooklm_cookies is not JSON")
for e in errors: print("invalid set:", e)
sys.exit(1 if errors else 0)
EOF
}

# apply_set: $SECRETS.new is fully prepared. Swap it in unless nothing changed,
# then recreate the services whose files changed. Sets CHANGED_SERVICES.
apply_set() {
  CHANGED_SERVICES=$(py "$SECRETS.new" "$SECRETS" <<'EOF'
import filecmp, os, sys
new, old = sys.argv[1:]
changed = set()
for base in (new, old):
    for service in (os.listdir(base) if os.path.isdir(base) else []):
        for name in os.listdir(os.path.join(base, service)):
            a, b = os.path.join(new, service, name), os.path.join(old, service, name)
            if not (os.path.isfile(a) and os.path.isfile(b) and filecmp.cmp(a, b, shallow=False)): changed.add(service)
print(" ".join(sorted(changed)))
EOF
)
  if [[ -z $CHANGED_SERVICES ]]; then
    rm -rf "$SECRETS.new"
    say "secrets unchanged"
    return
  fi
  validate_set "$SECRETS.new" || { rm -rf "$SECRETS.new"; fail secrets "the new set is inconsistent (see log)"; }
  rm -rf "$SECRETS.prev"
  [[ -d $SECRETS ]] && mv "$SECRETS" "$SECRETS.prev"
  mv "$SECRETS.new" "$SECRETS"
  say "secrets replaced for: $CHANGED_SERVICES"
  recreate $CHANGED_SERVICES
}

# recreate <services...>: processes read secrets and settings only at start and
# a mount keeps the old files, so changed services are recreated, not restarted.
recreate() {
  applied || { say "stack not installed yet: files written only"; return; }
  tm_env
  # The running stack is the applied version, not a VERSION pulled by a failed update.
  TM_VERSION=$(cut -d' ' -f1 "$STATE")
  STAGE=start
  say "recreating: $*"
  dc up -d --force-recreate --no-deps --wait --wait-timeout 180 "$@" || fail start "$(first_unready)"
  wait_ready
}

# service_status <service>: "<state> <health> <restarts>" of its container.
service_status() {
  local id
  id=$(dc ps -aq "$1" 2>/dev/null | head -n1)
  [[ -n $id ]] || { echo "missing - 0"; return; }
  docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}} {{.RestartCount}}' "$id"
}

SERVICES=(coordinator bots telegram-mcp openviking)
first_unready() {
  local s state health restarts
  for s in "${SERVICES[@]}"; do
    read -r state health restarts < <(service_status "$s")
    [[ $state == running && $health != unhealthy && $health != starting ]] || { echo "$s"; return; }
  done
  echo "compose"
}

# wait_ready: 30 s after start all four run, coordinator and OpenViking are
# healthy and no container restarted meanwhile.
wait_ready() {
  STAGE=ready
  local -A before
  local s state health restarts
  for s in "${SERVICES[@]}"; do read -r state health before[$s] < <(service_status "$s"); done
  say "checking readiness in 30 s"
  sleep "${TM_READY_DELAY:-30}"
  for s in "${SERVICES[@]}"; do
    read -r state health restarts < <(service_status "$s")
    say "  $s: $state $health restarts=$restarts"
    [[ $state == running ]] || fail ready "$s"
    [[ $restarts == "${before[$s]}" ]] || fail ready "$s"
    if [[ $s == coordinator || $s == openviking ]]; then [[ $health == healthy ]] || fail ready "$s"; fi
  done
}

# check_stack: the static composition check without starting containers.
check_stack() {
  STAGE=check
  tm_env
  local out
  if ! out=$(dc config --format json 2>&1); then say "$out"; fail check "compose config: ${out##*$'\n'}"; fi
  local reasons config
  config=$(mktemp)
  printf '%s' "$out" >"$config"
  reasons=$(py "$REPO" "$TM_ROOT" "$TM_VERSION" "$config" <<'EOF'
import json, os, stat, subprocess, sys
repo, root, version, config = sys.argv[1:]
cfg = json.load(open(config))
catalog = json.load(open(os.path.join(repo, "config/secrets.json")))
vendors = json.load(open(os.path.join(repo, "config/vendors.json")))
errors = []
services = cfg.get("services", {})
if sorted(services) != ["bots", "coordinator", "openviking", "telegram-mcp"]: errors.append("services must be exactly coordinator, bots, telegram-mcp, openviking")
networks = {"coordinator": {"bots_coord", "coordinator_telegram", "coordinator_openviking"}, "bots": {"bots_coord"}, "telegram-mcp": {"coordinator_telegram"}, "openviking": {"coordinator_openviking"}}
expected = {}
for s in catalog:
    for name in s["services"]: expected.setdefault(name, set()).add(s["name"])
for name, svc in services.items():
    if svc.get("ports"): errors.append(f"{name} publishes ports")
    if svc.get("build"): errors.append(f"{name} has build")
    image = svc.get("image", "")
    if image.endswith(":latest") or ("@" not in image and ":" not in image.rsplit("/", 1)[-1]): errors.append(f"{name} image is latest or untagged")
    if not svc.get("read_only"): errors.append(f"{name} is not read_only")
    if not any("no-new-privileges" in o for o in svc.get("security_opt", [])): errors.append(f"{name} lacks no-new-privileges")
    if "ALL" not in svc.get("cap_drop", []): errors.append(f"{name} does not drop capabilities")
    if not svc.get("mem_limit"): errors.append(f"{name} has no memory limit")
    if set(svc.get("networks", {})) != networks.get(name, set()): errors.append(f"{name} network isolation is broken")
    exchange = any(v.get("target") == "/exchange" for v in svc.get("volumes", []))
    if exchange != (name in ("coordinator", "telegram-mcp")): errors.append(f"{name} /exchange mount is wrong")
    mounted = set()
    for ref in svc.get("secrets", []):
        path = cfg.get("secrets", {}).get(ref["source"], {}).get("file", "")
        folder, file = os.path.split(path)
        if folder != os.path.join(root, "secrets", name): errors.append(f"{name} gets a foreign secret {ref['source']}")
        mounted.add(file)
    if mounted != expected.get(name, set()): errors.append(f"{name} secrets differ from config/secrets.json")
if services.get("openviking", {}).get("image") != vendors["openviking"]["image"]: errors.append("openviking image is not the digest from config/vendors.json")
labels = {"coordinator": {"obsidian-clipper": vendors["obsidian-clipper"]["commit"], "node": None},
          "telegram-mcp": {"telegram-mcp": vendors["telegram-mcp"]["commit"], "notebooklm-mcp-cli": vendors["notebooklm-mcp-cli"]["commit"]}}
for image, want in labels.items():
    ref = f"telegram-memory/{image}:{version}"
    got = subprocess.run(["docker", "image", "inspect", "-f", "{{json .Config.Labels}}", ref], capture_output=True, text=True)
    if got.returncode: errors.append(f"image {ref} is missing"); continue
    have = json.loads(got.stdout) or {}
    for vendor, commit in want.items():
        key, value = (f"com.telegram-memory.vendor.{vendor}.commit", commit) if commit else ("com.telegram-memory.vendor.node.image", vendors["node"]["image"])
        if have.get(key) != value: errors.append(f"image {ref} label {key} differs from config/vendors.json")
secrets = os.path.join(root, "secrets")
if os.path.isdir(secrets + ".new"): errors.append("an interrupted secrets replacement: run secrets-setup.sh")
if not os.path.isdir(secrets): errors.append("no secrets: run secrets-setup.sh")
else:
    st = os.stat(secrets)
    if stat.S_IMODE(st.st_mode) != 0o700 or st.st_uid != 0: errors.append("secrets directory must be 0700 root")
    missing = sorted(f"{svc}/{n}" for svc, names in expected.items() for n in names if not os.path.isfile(os.path.join(secrets, svc, n)))
    if missing: errors.append("missing secrets: " + " ".join(missing))
if not os.path.isfile(os.path.join(root, "config/bots.json")): errors.append("no config/bots.json: run config-setup.sh")
print("; ".join(errors))
EOF
)
  rm -f "$config"
  [[ -z $reasons ]] || fail check "$reasons"
  say "composition check passed"
}

# ensure_docker: after familia admin/src-tauri/resources/bootstrap.sh. Installs
# only what is missing; an installed Docker is never upgraded.
probe_registry() {
  local code
  code=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null) || return 1
  [[ $code == 200 || $code == 401 ]]
}

ensure_docker() {
  STAGE=docker
  if ! command -v docker >/dev/null; then
    say "installing Docker"
    local installer
    installer=$(mktemp)
    if ! { curl -fsS --max-time 30 https://get.docker.com -o "$installer" && sh "$installer"; }; then
      say "get.docker.com unavailable: installing docker.io from apt"
      apt-get update -y && apt-get install -y docker.io || fail docker "Docker installation failed"
    fi
    rm -f "$installer"
    systemctl enable --now docker || true
  fi
  if ! docker compose version >/dev/null 2>&1; then
    say "installing docker compose v2"
    apt-get update -y
    apt-get install -y docker-compose-plugin || apt-get install -y docker-compose-v2 || fail docker "docker compose v2 installation failed"
  fi
  # The Dockerfiles need BuildKit (ADD from git); docker.io comes without buildx.
  if ! docker buildx version >/dev/null 2>&1; then
    say "installing docker buildx"
    apt-get update -y
    apt-get install -y docker-buildx-plugin || apt-get install -y docker-buildx || fail docker "docker buildx installation failed"
  fi
  if [[ ! -f /etc/docker/daemon.json ]] && ! probe_registry https://registry-1.docker.io/v2/; then
    local mirror
    for mirror in https://mirror.gcr.io https://dockerhub.timeweb.cloud; do
      if probe_registry "$mirror/v2/"; then
        say "Docker Hub unreachable: registry mirror $mirror"
        mkdir -p /etc/docker
        printf '{\n  "registry-mirrors": ["%s"]\n}\n' "$mirror" >/etc/docker/daemon.json
        systemctl restart docker || true
        break
      fi
    done
  fi
  docker info >/dev/null || fail docker "Docker daemon is not running"
}
