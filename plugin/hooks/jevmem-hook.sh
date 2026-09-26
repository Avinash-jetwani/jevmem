#!/bin/sh
# jevmem Claude Code plugin launcher (POSIX sh). The plugin contains no jevmem code: it runs the `jevmem` command
# already on this machine. This script fetches nothing and runs no package manager.
#
#   jevmem-hook.sh [--detach] <jevmem arguments...>
#
# 1. --detach (the Stop hook) ignores SIGTERM, SIGHUP and SIGINT first: when a session ends, Claude Code signals an
#    async hook's process group, with `claude -p` as soon as the hook starts.
# 2. Opt-in per project: a hook in a project without jevmem.config.json reads its input and exits 0. No network,
#    no files, no output.
# 3. Finds the jevmem CLI: `command -v jevmem`, else the path this launcher cached in CLAUDE_PLUGIN_DATA the last time
#    it found one, else a fixed list of common global bin directories (Claude Code's desktop app can run hooks with a
#    PATH that lacks them). No CLI in an enabled project: the UserPromptSubmit hook shows the user one message per
#    session; the Stop hook stays silent. Both exit 0.
# 4. Finds Node 20+ to run it with, since `#!/usr/bin/env node` fails on a bare PATH. No Node: as for no CLI.
# 5. Prints one warning line to stderr when the CLI is older than this plugin.
# 6. Runs the CLI. With --detach it saves the hook JSON to a temp file, starts the CLI in its own process group and
#    exits at once, so the Stop hook never makes Claude wait.

for a in "$@"; do
  if [ "$a" = "--detach" ]; then trap '' TERM HUP INT; fi
done

project="${CLAUDE_PROJECT_DIR:-$PWD}"
if [ ! -f "$project/jevmem.config.json" ]; then
  for a in "$@"; do
    if [ "$a" = "hook" ]; then cat > /dev/null 2>&1; exit 0; fi
  done
fi

detach=0
if [ "$1" = "--detach" ]; then detach=1; shift; fi

# Node versions under ~/.nvm, newest first (numeric major, minor, patch).
nvm_versions() {
  ls "$HOME/.nvm/versions/node" 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p' | sort -t . -k 1,1nr -k 2,2nr -k 3,3nr
}

# No CLI, or no Node to run it: a hook reads its input and exits 0. The UserPromptSubmit hook (not --detach) prints
# $1 as a systemMessage, which Claude Code shows the user, once per session: the session ids already told are listed
# in CLAUDE_PLUGIN_DATA/notified. The Stop hook stays silent. Outside a hook, $1 goes to stderr.
not_found() {
  msg="$1"; shift
  for a in "$@"; do
    if [ "$a" = "hook" ]; then
      input="$(cat 2>/dev/null)"
      [ "$detach" -eq 0 ] || exit 0
      printf '%s\n' "$input" | grep -q '"hook_event_name" *: *"UserPromptSubmit"' || exit 0
      sid="$(printf '%s\n' "$input" | sed -n 's/.*"session_id" *: *"\([A-Za-z0-9_-]*\)".*/\1/p' | head -n 1)"
      [ -n "$sid" ] || sid=unknown
      if [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
        seen="$CLAUDE_PLUGIN_DATA/notified"
        if [ -f "$seen" ] && grep -qxF "$sid" "$seen" 2>/dev/null; then exit 0; fi
        mkdir -p "$CLAUDE_PLUGIN_DATA" 2>/dev/null && printf '%s\n' "$sid" >> "$seen" 2>/dev/null
      fi
      printf '{"systemMessage":"%s"}\n' "$msg"
      exit 0
    fi
  done
  echo "$msg" >&2
  exit 0
}
readme="See the jevmem README to set it up: https://github.com/Avinash-jetwani/jevmem#readme"

# 3. The CLI: on PATH, else the one cached below, else the first of a fixed list of common global bin directories,
# else the newest nvm Node version that has it. The cache in CLAUDE_PLUGIN_DATA holds four lines: the CLI path, a
# key (the CLI file's `ls -lL` line and this plugin's folder, which changes with each plugin version), the Node path
# and the version warning, so a warm run reads one small file with shell builtins and starts no extra process.
cache="${CLAUDE_PLUGIN_DATA:-}/cli"
c_cli=""; c_key=""; c_node=""; c_warning=""
if [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && [ -f "$cache" ]; then
  { IFS= read -r c_cli; IFS= read -r c_key; IFS= read -r c_node; IFS= read -r c_warning; } < "$cache"
fi
cli="$(command -v jevmem 2>/dev/null)"
if [ -z "$cli" ] && [ -n "$c_cli" ] && [ -x "$c_cli" ]; then cli="$c_cli"; fi
if [ -z "$cli" ]; then
  for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/.volta/bin"; do
    if [ -f "$d/jevmem" ] && [ -x "$d/jevmem" ]; then cli="$d/jevmem"; break; fi
  done
fi
if [ -z "$cli" ]; then
  for v in $(nvm_versions); do
    if [ -f "$HOME/.nvm/versions/node/v$v/bin/jevmem" ] && [ -x "$HOME/.nvm/versions/node/v$v/bin/jevmem" ]; then
      cli="$HOME/.nvm/versions/node/v$v/bin/jevmem"; break
    fi
  done
fi
if [ -z "$cli" ]; then not_found "jevmem: CLI not found, so memory is off in this project. $readme" "$@"; fi

# 4 and 5, from the cache when it is for this CLI file and this plugin version.
key="$(ls -lL "$cli" 2>/dev/null)|${CLAUDE_PLUGIN_ROOT:-}"
node=""
warning=""
cached=0
if [ "$c_cli" = "$cli" ] && [ "$c_key" = "$key" ] && { [ -z "$c_node" ] || [ -x "$c_node" ]; }; then
  node="$c_node"; warning="$c_warning"; cached=1
fi

# Run the CLI with the given arguments (through Node when it is a Node script); paths may contain spaces.
cli_run() { if [ -n "$node" ]; then "$node" "$cli" "$@"; else "$cli" "$@"; fi; }

if [ "$cached" -eq 0 ]; then
  # 4. Node, when the CLI is a Node script; version managers' shims run on their own.
  case "$(head -n 1 "$cli" 2>/dev/null)" in
    '#!'*node*)
      node_ok() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' >/dev/null 2>&1; }
      for n in "${cli%/*}/node" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
        if node_ok "$n"; then node="$n"; break; fi
      done
      if [ -z "$node" ]; then
        for v in $(nvm_versions); do
          if node_ok "$HOME/.nvm/versions/node/v$v/bin/node"; then node="$HOME/.nvm/versions/node/v$v/bin/node"; break; fi
        done
      fi
      if [ -z "$node" ]; then not_found "jevmem: Node.js 20 or newer not found, so memory is off in this project. $readme" "$@"; fi
      ;;
  esac
  # 5. Compare the CLI's version with this plugin's.
  cli_version=$(cli_run --version 2>/dev/null)
  plugin_version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "${CLAUDE_PLUGIN_ROOT:-${0%/*}/..}/.claude-plugin/plugin.json" 2>/dev/null | head -n 1)
  older=$(printf '%s\n%s\n' "$cli_version" "$plugin_version" | awk -F. 'NR==1{split($0,a,".")} NR==2{split($0,b,"."); for(i=1;i<=3;i++){if(a[i]+0<b[i]+0){print 1; exit} if(a[i]+0>b[i]+0){exit}}}')
  if [ -n "$cli_version" ] && [ -n "$plugin_version" ] && [ "$older" = "1" ]; then
    warning="jevmem: the jevmem CLI is $cli_version, older than this plugin ($plugin_version); update the jevmem CLI"
  fi
  if [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && [ -n "$cli_version" ]; then
    mkdir -p "$CLAUDE_PLUGIN_DATA" 2>/dev/null && printf '%s\n%s\n%s\n%s\n' "$cli" "$key" "$node" "$warning" > "$cache" 2>/dev/null
  fi
fi

# 5. One warning line when the CLI is older than this plugin.
if [ -n "$warning" ]; then echo "$warning" >&2; fi

# 6. Run.
if [ "$detach" -eq 1 ]; then
  # A new file only this user can read (noclobber: never write through an existing file or link).
  tmp="${TMPDIR:-/tmp}/jevmem-hook.$$"
  ( umask 077; set -C; : > "$tmp" ) 2>/dev/null || exit 0
  cat > "$tmp"
  if command -v setsid >/dev/null 2>&1; then
    if [ -n "$node" ]; then setsid "$node" "$cli" "$@" --stdin-file "$tmp" </dev/null >/dev/null 2>&1 &
    else setsid "$cli" "$@" --stdin-file "$tmp" </dev/null >/dev/null 2>&1 & fi
  else
    set -m
    cli_run "$@" --stdin-file "$tmp" </dev/null >/dev/null 2>&1 &
  fi
  exit 0
fi
if [ -n "$node" ]; then exec "$node" "$cli" "$@"; fi
exec "$cli" "$@"
