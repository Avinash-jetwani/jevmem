#!/bin/sh
# jevmem hook launcher (POSIX sh), used by `jevmem init` for the Stop hook and by the Claude Code plugin.
#
#   jevmem-hook.sh [--node <path>] [--detach] <jevmem arguments...>
#
# Claude Code runs hooks without your shell profile, and from the desktop app often with a bare PATH, so node is
# looked for in: --node, $JEVMEM_NODE, a path cached in $CLAUDE_PLUGIN_DATA, PATH, then the usual install locations
# (Homebrew, Volta, nvm, fnm, asdf, mise, n), taking the first that is Node 20 or newer.
#
# --detach is for the Stop hook. When a session ends, Claude Code sends SIGTERM (then SIGKILL a few seconds later) to
# the process group of an async hook that is still running; with `claude -p` that happens as soon as the hook starts.
# So the launcher ignores SIGTERM, saves the hook JSON from stdin to a temp file, starts node in its own process group,
# and exits at once. Node then queues the turn and hands it to jevmem's daemon. The hook never makes Claude wait, and
# the end of a session does not cut the handoff short.
#
# Always exits 0: a missing node must not block Claude Code (the reason is printed to stderr).

# First of all: a detaching (Stop) hook ignores SIGTERM, SIGHUP and SIGINT. With `claude -p` the session-end SIGTERM
# reaches the hook's process group as soon as the hook starts, so this must come before anything else can run.
for a in "$@"; do
  if [ "$a" = "--detach" ]; then trap '' TERM HUP INT; fi
done

# Opt-in per project: jevmem acts only in a project that contains jevmem.config.json (written by `jevmem enable` or
# `jevmem init`). For a hook, this check runs first, before node is looked for or anything is read or written: in any
# other project the hook reads its input, exits 0 and does nothing else (no network, no files, no output).
project="${CLAUDE_PROJECT_DIR:-$PWD}"
enabled=0
[ -f "$project/jevmem.config.json" ] && enabled=1
for a in "$@"; do
  if [ "$a" = "hook" ] && [ "$enabled" -eq 0 ]; then
    cat > /dev/null 2>&1
    exit 0
  fi
done

case "$0" in */*) here="${0%/*}" ;; *) here="." ;; esac
here=$(cd "$here" && pwd -P)
cli="$here/../dist/cli.js"

node=""
detach=0
while [ $# -gt 0 ]; do
  case "$1" in
    --node) node="$2"; shift 2 ;;
    --detach) detach=1; shift ;;
    *) break ;;
  esac
done

node_ok() {
  [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1
}

find_node() {
  if [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && [ -f "$CLAUDE_PLUGIN_DATA/node-path" ]; then
    cached=$(cat "$CLAUDE_PLUGIN_DATA/node-path" 2>/dev/null)
    if [ -n "$cached" ] && [ -x "$cached" ]; then echo "$cached"; return 0; fi
  fi
  for c in "${JEVMEM_NODE:-}" "$(command -v node 2>/dev/null)" \
    /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" \
    "$HOME/.local/share/fnm/aliases/default/bin/node" "$HOME/Library/Application Support/fnm/aliases/default/bin/node" \
    "$HOME/.asdf/shims/node" "$HOME/.local/share/mise/shims/node" "$HOME/n/bin/node" /usr/bin/node; do
    if node_ok "$c"; then echo "$c"; return 0; fi
  done
  # nvm: newest installed version first.
  for c in $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -t v -k 2 -n -r); do
    if node_ok "$c"; then echo "$c"; return 0; fi
  done
  return 1
}

if [ -z "$node" ] || [ ! -x "$node" ]; then
  node=$(find_node)
  if [ -z "$node" ]; then
    echo "jevmem: no Node.js 20+ found (set JEVMEM_NODE to its path); skipped" >&2
    exit 0
  fi
  # Cached only for an enabled project, so a project that has not opted in leaves no file anywhere.
  if [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && [ "$enabled" -eq 1 ]; then
    mkdir -p "$CLAUDE_PLUGIN_DATA" 2>/dev/null && printf '%s' "$node" > "$CLAUDE_PLUGIN_DATA/node-path" 2>/dev/null
  fi
fi

if [ "$detach" -eq 1 ]; then
  tmp=$(mktemp "${TMPDIR:-/tmp}/jevmem-hook.XXXXXX") || exit 0
  cat > "$tmp"
  if command -v setsid >/dev/null 2>&1; then
    setsid "$node" "$cli" "$@" --stdin-file "$tmp" </dev/null >/dev/null 2>&1 &
  else
    set -m
    "$node" "$cli" "$@" --stdin-file "$tmp" </dev/null >/dev/null 2>&1 &
  fi
  exit 0
fi

exec "$node" "$cli" "$@"
