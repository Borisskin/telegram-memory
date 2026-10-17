#!/usr/bin/env bash
# First install and every update: one command.
#   sudo scripts/update.sh [--force]   → RESULT=up-to-date | updated <version> | failed <stage> …
# Installs Docker if missing, takes the newest commit of origin/main, checks its
# VERSION and release tag, builds the images from config/vendors.json, verifies
# them, checks the composition, starts it and waits for readiness. state/applied
# changes only after full success, so a rerun finishes an interrupted update.
source "$(dirname "$0")/lib.sh"
force=
if (($# == 1)) && [[ $1 == --force ]]; then force=1
elif (($# != 0)); then usage "usage: sudo scripts/update.sh [--force]"
fi
tm_start update
recover_secrets
ensure_docker
cd "$REPO"
# git runs as the owner of the clone: as root it would leave root-owned files
# in .git and break the owner's own git commands.
repo_owner=$(stat -c %U "$REPO")
# umask 022: lib.sh keeps 077 for secrets, but checked-out files go into images
# and must stay readable there.
git() { if [[ $repo_owner == root ]]; then (umask 022; command git "$@"); else (umask 022; runuser -u "$repo_owner" -- git "$@"); fi; }

STAGE=fetch
say "fetching origin/main"
git fetch --tags --force origin main || fail fetch "git fetch failed (see log)"
target=$(git rev-parse origin/main)
applied_version= applied_commit=
if applied; then read -r applied_version applied_commit <"$STATE"; fi
if [[ $target == "$applied_commit" && -z $force ]]; then
  say "commit ${target:0:7} is already applied"
  result 0 up-to-date
fi

STAGE=version
version=$(git show "$target:VERSION" | tr -d '[:space:]')
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail version "VERSION is not three numbers: $version"
if [[ -n $applied_version ]] && ! python3 -c 'import sys; a, b = (tuple(map(int, v.split("."))) for v in sys.argv[1:]); sys.exit(a < b)' "$version" "$applied_version"; then
  fail version "version $version is lower than applied $applied_version"
fi
for tag in $(git tag --points-at "$target" 'v*'); do
  [[ $tag == "v$version" ]] || fail version "tag $tag does not match VERSION $version"
done

STAGE=fetch
[[ -z $(git status --porcelain --untracked-files=no) ]] || fail fetch "local changes in $REPO: commit or discard them"
previous=$(git rev-parse HEAD)
git merge --ff-only "$target" || fail fetch "cannot fast-forward to origin/main (see log)"
commit=$(git rev-parse HEAD)
# The running process still has the previous scripts; continue with the new ones.
if [[ -z ${TM_REEXEC:-} ]] && ! git diff --quiet "$previous" "$commit" -- scripts; then
  say "scripts changed: restarting update with the new version"
  export TM_REEXEC=1
  exec 1>&3 2>&3
  exec "$REPO/scripts/update.sh" "$@"
fi
tm_env
say "version $TM_VERSION, commit ${commit:0:7}"

STAGE=build
built() { [[ $(docker image inspect -f '{{index .Config.Labels "com.telegram-memory.commit"}}' "telegram-memory/$1:$TM_VERSION" 2>/dev/null) == "$commit" ]]; }
if [[ -z $force ]] && built coordinator && built telegram-mcp; then
  say "images for ${commit:0:7} already built"
else
  labels=(--label "org.opencontainers.image.version=$TM_VERSION" --label "com.telegram-memory.commit=$commit")
  args=()
  for name in telegram-mcp notebooklm-mcp-cli obsidian-clipper; do
    prefix=$(tr 'a-z-' 'A-Z_' <<<"$name")
    args+=(--build-arg "${prefix}_REPO=$(vendor "$name" repo)" --build-arg "${prefix}_COMMIT=$(vendor "$name" commit)")
  done
  args+=(--build-arg "NODE_IMAGE=$(vendor node image)")
  tg_commit=$(vendor telegram-mcp commit)
  say "building telegram-mcp base ${tg_commit:0:7}"
  docker build --progress=plain -t "telegram-memory/telegram-mcp-base:$tg_commit" "$(vendor telegram-mcp repo)#$tg_commit" || fail build "telegram-mcp base (see log)"
  say "building telegram-mcp"
  docker build --progress=plain "${labels[@]}" "${args[@]}" -t "telegram-memory/telegram-mcp:$TM_VERSION" -f docker/telegram-mcp.Dockerfile docker || fail build "telegram-mcp (see log)"
  say "building coordinator"
  docker build --progress=plain "${labels[@]}" "${args[@]}" -t "telegram-memory/coordinator:$TM_VERSION" -f docker/coordinator.Dockerfile . || fail build "coordinator (see log)"
fi

STAGE=verify
say "verifying images"
clip="import('/app/src/clipper.ts').then((m) => m.clipHtml('<html><body><article><h1>Check</h1><p>Clipper smoke test paragraph with enough text to extract.</p></article></body></html>', 'https://example.com/check')).then((r) => { if (!/smoke test/.test(r.content ?? '')) process.exit(1); })"
docker run --rm --network none --entrypoint node "telegram-memory/coordinator:$TM_VERSION" --experimental-strip-types -e "$clip" || fail verify "Obsidian Clipper does not convert a page to Markdown in the coordinator image"
docker run --rm --network none --entrypoint python "telegram-memory/telegram-mcp:$TM_VERSION" -c 'import mcp.server.fastmcp' || fail verify "telegram-mcp cannot import its MCP server in the image"
nlm=$(docker run --rm --network none --entrypoint /opt/notebooklm/bin/python "telegram-memory/telegram-mcp:$TM_VERSION" -c 'import importlib.metadata as m; print(m.version("notebooklm-mcp-cli"))') || fail verify "notebooklm-mcp-cli is missing in the telegram-mcp image"
[[ $nlm == "$(vendor notebooklm-mcp-cli version)" ]] || fail verify "notebooklm-mcp-cli $nlm instead of $(vendor notebooklm-mcp-cli version)"

check_stack

STAGE=start
say "starting the stack"
dc up -d --remove-orphans --wait --wait-timeout 180 || fail start "$(first_unready)"
wait_ready

mkdir -p "$(dirname "$STATE")"
printf '%s %s\n' "$TM_VERSION" "$commit" >"$STATE.new"
mv -f "$STATE.new" "$STATE"
result 0 "updated $TM_VERSION"
