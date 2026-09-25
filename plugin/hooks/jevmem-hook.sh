#!/bin/sh
# jevmem Claude Code plugin launcher (POSIX sh). The plugin contains no jevmem code: it runs the jevmem CLI you
# installed from npm (`npm install -g jevmem`). Nothing is downloaded at run time.
#
#   jevmem-hook.sh [--detach] <jevmem arguments...>
#
# 1. --detach (the Stop hook) ignores SIGTERM, SIGHUP and SIGINT first: when a session ends, Claude Code signals an
#    async hook's process group, with `claude -p` as soon as the hook starts.
# 2. Opt-in per project: a hook in a project without jevmem.config.json reads its input and exits 0. No network,
#    no files, no output.
# 3. Finds the jevmem CLI: `jevmem` on PATH, else the usual global npm bin directories (Claude Code's desktop app runs
#    hooks with a bare PATH). No CLI: exits 0 silently.
# 4. Finds Node 20+ to run it with, since `#!/usr/bin/env node` fails on a bare PATH.
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

# 3. The CLI.
cli=""
for c in "$(command -v jevmem 2>/dev/null)" /opt/homebrew/bin/jevmem /usr/local/bin/jevmem "$HOME/.npm-global/bin/jevmem" \
  "$HOME/.volta/bin/jevmem" "$HOME/.local/share/fnm/aliases/default/bin/jevmem" \
  "$HOME/Library/Application Support/fnm/aliases/default/bin/jevmem" "$HOME/.asdf/shims/jevmem" \
  "$HOME/.local/share/mise/shims/jevmem" "$HOME/n/bin/jevmem"; do
  if [ -n "$c" ] && [ -x "$c" ]; then cli="$c"; break; fi
done
if [ -z "$cli" ]; then
  for c in $(ls -d "$HOME"/.nvm/versions/node/v*/bin/jevmem 2>/dev/null | sort -t v -k 2 -n -r); do
    if [ -x "$c" ]; then cli="$c"; break; fi
  done
fi
if [ -z "$cli" ]; then
  for a in "$@"; do
    if [ "$a" = "hook" ]; then cat > /dev/null 2>&1; exit 0; fi
  done
  echo "jevmem: the jevmem CLI is not installed; run: npm install -g jevmem" >&2
  exit 0
fi

# 4 and 5 are cached in CLAUDE_PLUGIN_DATA, keyed by the CLI file (its `ls -lL` line) and this plugin's folder
# (which changes with each plugin version), so a warm run reads one small file with shell builtins and starts no
# extra process.
key="$(ls -lL "$cli" 2>/dev/null)|${CLAUDE_PLUGIN_ROOT:-}"
cache="${CLAUDE_PLUGIN_DATA:-}/cli"
node=""
warning=""
cached=0
if [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && [ -f "$cache" ]; then
  { IFS= read -r c_key; IFS= read -r c_node; IFS= read -r c_warning; } < "$cache"
  if [ "$c_key" = "$key" ] && { [ -z "$c_node" ] || [ -x "$c_node" ]; }; then
    node="$c_node"; warning="$c_warning"; cached=1
  fi
fi

# Run the CLI with the given arguments (through Node when it is a Node script); paths may contain spaces.
cli_run() { if [ -n "$node" ]; then "$node" "$cli" "$@"; else "$cli" "$@"; fi; }

if [ "$cached" -eq 0 ]; then
  # 4. Node, when the CLI is a Node script (npm's usual install); version managers' shims run on their own.
  case "$(head -n 1 "$cli" 2>/dev/null)" in
    '#!'*node*)
      node_ok() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' >/dev/null 2>&1; }
      for n in "${cli%/*}/node" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
        if node_ok "$n"; then node="$n"; break; fi
      done
      if [ -z "$node" ]; then
        for n in $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -t v -k 2 -n -r); do
          if node_ok "$n"; then node="$n"; break; fi
        done
      fi
      if [ -z "$node" ]; then
        for a in "$@"; do
          if [ "$a" = "hook" ]; then cat > /dev/null 2>&1; exit 0; fi
        done
        echo "jevmem: Node.js 20 or newer was not found" >&2
        exit 0
      fi
      ;;
  esac
  # 5. Compare the CLI's version with this plugin's.
  cli_version=$(cli_run --version 2>/dev/null)
  plugin_version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "${CLAUDE_PLUGIN_ROOT:-${0%/*}/..}/.claude-plugin/plugin.json" 2>/dev/null | head -n 1)
  older=$(printf '%s\n%s\n' "$cli_version" "$plugin_version" | awk -F. 'NR==1{split($0,a,".")} NR==2{split($0,b,"."); for(i=1;i<=3;i++){if(a[i]+0<b[i]+0){print 1; exit} if(a[i]+0>b[i]+0){exit}}}')
  if [ -n "$cli_version" ] && [ -n "$plugin_version" ] && [ "$older" = "1" ]; then
    warning="jevmem: the installed CLI is $cli_version, older than this plugin ($plugin_version); run: npm install -g jevmem"
  fi
  if [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && [ -n "$cli_version" ]; then
    mkdir -p "$CLAUDE_PLUGIN_DATA" 2>/dev/null && printf '%s\n%s\n%s\n' "$key" "$node" "$warning" > "$cache" 2>/dev/null
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
