#!/bin/sh
# jevmem's Cursor hook launcher (POSIX sh), version 1. `jevmem init --tool cursor` copies this file into a project as
# .cursor/hooks/jevmem-hook.sh and names it in .cursor/hooks.json with relative commands, so both files can be committed
# with the project: nothing in here is a path of one computer.
#
#   jevmem-hook.sh <event>      event: sessionStart | beforeSubmitPrompt | afterAgentResponse | stop | sessionEnd
#
# Cursor runs a project hook from the project root with the hook's JSON payload on stdin and reads its JSON answer. This
# launcher (1) answers the least Cursor may need and exits 0 when the project has no jevmem.config.json, when no jevmem
# CLI or no Node.js 20+ is found, or on any other failure: it never blocks or slows Cursor; (2) finds the jevmem CLI as
# the Claude Code plugin's launcher does: `command -v jevmem`, else the path cached in .jevmem/cursor-launcher, else
# /opt/homebrew/bin, /usr/local/bin, ~/.local/bin, ~/.volta/bin, else the newest Node version under ~/.nvm that has it;
# (3) finds a Node.js 20+ to run it with; (4) runs `jevmem hook --cursor`: for `stop` and `sessionEnd` it saves the
# payload to a temp file, starts the CLI in its own process group and exits at once (Cursor waits for a stop hook's
# answer, and the CLI's work takes longer than a hook should), for the other events it runs the CLI in place.
# The cache (the CLI path and the Node path, one line each) lives in the project's gitignored .jevmem/ folder and is
# written only in a project that is turned on.

event="${1:-}"

# The answer Cursor needs when the CLI does not run: beforeSubmitPrompt must say the prompt may go on.
answer_and_exit() {
  cat > /dev/null 2>&1
  if [ "$event" = beforeSubmitPrompt ]; then printf '{"continue":true}\n'; fi
  exit 0
}

detach=0
case "$event" in
  stop|sessionEnd) detach=1; trap '' TERM HUP INT ;;
  sessionStart|beforeSubmitPrompt|afterAgentResponse) ;;
  *) answer_and_exit ;;
esac

project="${CURSOR_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$PWD}}"
[ -f "$project/jevmem.config.json" ] || answer_and_exit

cache="$project/.jevmem/cursor-launcher"
c_cli=""; c_node=""
if [ -f "$cache" ]; then { IFS= read -r c_cli; IFS= read -r c_node; } < "$cache" 2>/dev/null; fi

nvm_versions() {
  ls "$HOME/.nvm/versions/node" 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p' | sort -t . -k 1,1nr -k 2,2nr -k 3,3nr
}

cli="$(command -v jevmem 2>/dev/null)"
if [ -z "$cli" ] && [ -n "$c_cli" ] && [ -x "$c_cli" ]; then cli="$c_cli"; fi
if [ -z "$cli" ]; then
  for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/.volta/bin"; do
    if [ -x "$d/jevmem" ]; then cli="$d/jevmem"; break; fi
  done
fi
if [ -z "$cli" ]; then
  for v in $(nvm_versions); do
    if [ -x "$HOME/.nvm/versions/node/v$v/bin/jevmem" ]; then cli="$HOME/.nvm/versions/node/v$v/bin/jevmem"; break; fi
  done
fi
[ -n "$cli" ] || answer_and_exit

node_ok() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' >/dev/null 2>&1; }
node=""
case "$(head -n 1 "$cli" 2>/dev/null)" in
  '#!'*node*)
    if [ "$c_cli" = "$cli" ] && node_ok "$c_node"; then node="$c_node"; fi
    if [ -z "$node" ]; then
      for n in "${cli%/*}/node" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
        if node_ok "$n"; then node="$n"; break; fi
      done
    fi
    if [ -z "$node" ]; then
      for v in $(nvm_versions); do
        if node_ok "$HOME/.nvm/versions/node/v$v/bin/node"; then node="$HOME/.nvm/versions/node/v$v/bin/node"; break; fi
      done
    fi
    [ -n "$node" ] || answer_and_exit
    ;;
esac
if [ "$c_cli" != "$cli" ] || [ "$c_node" != "$node" ]; then
  mkdir -p "$project/.jevmem" 2>/dev/null && printf '%s\n%s\n' "$cli" "$node" > "$cache" 2>/dev/null
fi

cli_run() { if [ -n "$node" ]; then "$node" "$cli" "$@"; else "$cli" "$@"; fi; }

if [ "$detach" -eq 1 ]; then
  tmp="${TMPDIR:-/tmp}/jevmem-cursor-hook.$$"
  ( umask 077; set -C; : > "$tmp" ) 2>/dev/null || exit 0
  cat > "$tmp"
  if command -v setsid >/dev/null 2>&1; then
    if [ -n "$node" ]; then setsid "$node" "$cli" hook --cursor --stdin-file "$tmp" </dev/null >/dev/null 2>&1 &
    else setsid "$cli" hook --cursor --stdin-file "$tmp" </dev/null >/dev/null 2>&1 & fi
  else
    set -m
    exec 2>/dev/null
    cli_run hook --cursor --stdin-file "$tmp" </dev/null >/dev/null 2>&1 &
  fi
  exit 0
fi
if [ -n "$node" ]; then exec "$node" "$cli" hook --cursor; fi
exec "$cli" hook --cursor
