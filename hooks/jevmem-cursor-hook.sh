#!/bin/sh
# jevmem's Cursor launcher (POSIX sh), version 2. One file, two homes: `jevmem init --tool cursor` copies it into a
# project as .cursor/hooks/jevmem-hook.sh and names it in .cursor/hooks.json with relative commands (both files can be
# committed: nothing in here is a path of one computer), and the jevmem plugin for Cursor (cursor-plugin/, 0.7.6)
# ships the same file as hooks/jevmem-hook.sh, run as `sh "${CURSOR_PLUGIN_ROOT}/hooks/jevmem-hook.sh" --plugin <event>`
# by its hooks and as `… --plugin --mcp --root "${workspaceFolder}"` by its MCP entry.
#
#   jevmem-hook.sh [--cli <path>] [--node <path>] [--plugin] <event>
#       event: sessionStart | beforeSubmitPrompt | afterAgentResponse | stop | sessionEnd
#   jevmem-hook.sh [--cli <path>] [--node <path>] [--plugin] --mcp [--root <dir>]
#       --cli, --node: an explicit jevmem CLI and Node to run it with, before any search (the e2e harness uses them to
#       run the packed CLI, since Cursor gives its hooks its own resolved shell PATH, not the agent process's)
#       --plugin: run from the plugin: `jevmem hook --cursor --plugin` (the CLI stands down where the project has its
#       own jevmem hooks, so nothing is decided twice), JEVMEM_PLUGIN_VERSION read from the plugin's own manifest, and
#       on sessionStart the marker ~/.jevmem/cursor-plugin (the version and the time, once a day), which is how
#       `jevmem init` and `jevmem doctor` know the plugin is set up on this computer: Cursor records a plugin in its
#       own state. The one file the plugin writes outside a project.
#       --mcp: run the MCP server, `jevmem mcp`, with --root <dir> when <dir> is a folder (the Cursor app expands
#       ${workspaceFolder} per window and starts a plugin's server from the home folder) and from the working directory
#       otherwise (the agent CLI leaves the placeholder literal and starts the server in the project)
#
# Cursor runs a hook with the hook's JSON payload on stdin and reads its JSON answer; the working directory is the
# project root for a project's hooks and varies for a plugin's (the project root in the app, the plugin folder in the
# CLI), so the project is CURSOR_PROJECT_DIR, which Cursor always sets. This launcher (1) answers the least Cursor may
# need and exits 0 when the project has no jevmem.config.json, when no jevmem CLI or no Node.js 20+ is found, or on any
# other failure: it never blocks or slows Cursor; (2) finds the jevmem CLI as the Claude Code plugin's launcher does:
# `command -v jevmem`, else the path cached in .jevmem/cursor-launcher, else /opt/homebrew/bin, /usr/local/bin,
# ~/.local/bin, ~/.volta/bin, else the newest Node version under ~/.nvm that has it; (3) finds a Node.js 20+ to run it
# with; (4) runs `jevmem hook --cursor`: for `stop` and `sessionEnd` it saves the payload to a temp file, starts the CLI
# in its own process group and exits at once (Cursor waits for a stop hook's answer, and the CLI's work takes longer
# than a hook should), for the other events it runs the CLI in place. In --mcp mode the server runs in a project that is
# not turned on too (it answers that jevmem is off there, sends nothing and writes nothing), and a missing CLI is one
# line on stderr and exit 1, which Cursor shows as the server failing. The cache (the CLI path and the Node path, one
# line each) lives in the project's gitignored .jevmem/ folder and is written only in a project that is turned on.

given_cli=""; given_node=""; plugin=0; mcp=0; root=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cli) given_cli="$2"; shift 2 ;;
    --node) given_node="$2"; shift 2 ;;
    --plugin) plugin=1; shift ;;
    --mcp) mcp=1; shift ;;
    --root) root="$2"; shift 2 ;;
    *) break ;;
  esac
done
event="${1:-}"

# The answer Cursor needs when the CLI does not run: beforeSubmitPrompt must say the prompt may go on.
answer_and_exit() {
  cat > /dev/null 2>&1
  if [ "$event" = beforeSubmitPrompt ]; then printf '{"continue":true}\n'; fi
  exit 0
}

if [ "$mcp" -eq 1 ]; then
  event=mcp
  # A placeholder Cursor did not expand, or anything that is not a folder, means: the working directory.
  case "$root" in '${'*|'') root="" ;; *) [ -d "$root" ] || root="" ;; esac
  project="${root:-$PWD}"
else
  detach=0
  case "$event" in
    stop|sessionEnd) detach=1; trap '' TERM HUP INT ;;
    sessionStart|beforeSubmitPrompt|afterAgentResponse) ;;
    *) answer_and_exit ;;
  esac
  project="${CURSOR_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$PWD}}"
fi

if [ "$plugin" -eq 1 ]; then
  # The plugin's version, from the manifest beside this file: never from CURSOR_PLUGIN_ROOT, which the agent CLI can
  # set to another plugin's folder when several plugins have hooks (measured on 2026.10.16: the probe's), while the
  # placeholder in the command text is substituted per plugin.
  manifest="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd -P)/.cursor-plugin/plugin.json"
  JEVMEM_PLUGIN_VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" 2>/dev/null | head -n 1)"
  export JEVMEM_PLUGIN_VERSION
  if [ "$event" = sessionStart ]; then
    marker="$HOME/.jevmem/cursor-plugin"
    today="$(date -u +%Y-%m-%d)"
    m_version=""; m_day=""
    if [ -f "$marker" ]; then { IFS= read -r m_version; IFS= read -r m_day; } < "$marker" 2>/dev/null; fi
    if [ "$m_version" != "$JEVMEM_PLUGIN_VERSION" ] || [ "${m_day%%T*}" != "$today" ]; then
      mkdir -p "$HOME/.jevmem" 2>/dev/null && printf '%s\n%s\n' "$JEVMEM_PLUGIN_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker" 2>/dev/null
    fi
  fi
fi

enabled=0
[ -f "$project/jevmem.config.json" ] && enabled=1
# A hook in a project that is not turned on: nothing runs, nothing is written. The server runs regardless: it answers.
[ "$mcp" -eq 1 ] || [ "$enabled" -eq 1 ] || answer_and_exit

cache="$project/.jevmem/cursor-launcher"
c_cli=""; c_node=""
if [ -f "$cache" ]; then { IFS= read -r c_cli; IFS= read -r c_node; } < "$cache" 2>/dev/null; fi

nvm_versions() {
  ls "$HOME/.nvm/versions/node" 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p' | sort -t . -k 1,1nr -k 2,2nr -k 3,3nr
}

# In --mcp mode with no CLI: one line for Cursor's server log, not silence.
not_found_and_exit() {
  if [ "$mcp" -eq 1 ]; then
    printf 'jevmem: the jevmem command was not found on this computer (looked on PATH, in /opt/homebrew/bin, /usr/local/bin, ~/.local/bin, ~/.volta/bin and under ~/.nvm): put the jevmem CLI in place (see the README), then restart Cursor\n' >&2
    exit 1
  fi
  answer_and_exit
}

cli=""
if [ -n "$given_cli" ] && [ -x "$given_cli" ]; then cli="$given_cli"; fi
[ -n "$cli" ] || cli="$(command -v jevmem 2>/dev/null)"
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
[ -n "$cli" ] || not_found_and_exit

node_ok() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' >/dev/null 2>&1; }
node=""
case "$(head -n 1 "$cli" 2>/dev/null)" in
  '#!'*node*)
    if node_ok "$given_node"; then node="$given_node"; fi
    if [ -z "$node" ] && [ "$c_cli" = "$cli" ] && node_ok "$c_node"; then node="$c_node"; fi
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
    [ -n "$node" ] || not_found_and_exit
    ;;
esac
if [ "$enabled" -eq 1 ] && { [ "$c_cli" != "$cli" ] || [ "$c_node" != "$node" ]; }; then
  mkdir -p "$project/.jevmem" 2>/dev/null && printf '%s\n%s\n' "$cli" "$node" > "$cache" 2>/dev/null
fi

cli_run() { if [ -n "$node" ]; then "$node" "$cli" "$@"; else "$cli" "$@"; fi; }

if [ "$mcp" -eq 1 ]; then
  if [ -n "$root" ]; then
    if [ -n "$node" ]; then exec "$node" "$cli" mcp --root "$root"; fi
    exec "$cli" mcp --root "$root"
  fi
  if [ -n "$node" ]; then exec "$node" "$cli" mcp; fi
  exec "$cli" mcp
fi

if [ "$plugin" -eq 1 ]; then set -- hook --cursor --plugin; else set -- hook --cursor; fi
if [ "$detach" -eq 1 ]; then
  tmp="${TMPDIR:-/tmp}/jevmem-cursor-hook.$$"
  ( umask 077; set -C; : > "$tmp" ) 2>/dev/null || exit 0
  cat > "$tmp"
  if command -v setsid >/dev/null 2>&1; then
    if [ -n "$node" ]; then setsid "$node" "$cli" "$@" --stdin-file "$tmp" </dev/null >/dev/null 2>&1 &
    else setsid "$cli" "$@" --stdin-file "$tmp" </dev/null >/dev/null 2>&1 & fi
  else
    set -m
    exec 2>/dev/null
    cli_run "$@" --stdin-file "$tmp" </dev/null >/dev/null 2>&1 &
  fi
  exit 0
fi
if [ -n "$node" ]; then exec "$node" "$cli" "$@"; fi
exec "$cli" "$@"
