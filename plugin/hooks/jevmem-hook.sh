#!/bin/sh
# jevmem Claude Code plugin launcher (POSIX sh). The plugin contains no jevmem code: it runs the `jevmem` command
# already on this machine. This script fetches nothing and runs no package manager.
#
#   jevmem-hook.sh [--detach] [--guard] [--start] <jevmem arguments...>
#
# 1. --detach (the Stop hook) ignores SIGTERM, SIGHUP and SIGINT first: when a session ends, Claude Code signals an
#    async hook's process group, with `claude -p` as soon as the hook starts.
# 2. Opt-in per project: a hook in a project without jevmem.config.json reads its input and exits 0. No network,
#    no files, no output. The one exception is 7.
# 3. Finds the jevmem CLI: `command -v jevmem`, else the path this launcher cached in CLAUDE_PLUGIN_DATA the last time
#    it found one, else a fixed list of common global bin directories (Claude Code's desktop app can run hooks with a
#    PATH that lacks them). No CLI in an enabled project: the UserPromptSubmit hook shows the user one message per
#    session; the Stop hook stays silent. Both exit 0.
# 4. Finds Node 20+ to run it with, since `#!/usr/bin/env node` fails on a bare PATH. No Node: as for no CLI.
# 5. Prints one warning line to stderr when the CLI is older than this plugin.
# 6. Runs the CLI. With --detach it saves the hook JSON to a temp file, starts the CLI in its own process group and
#    exits at once, so the Stop hook never makes Claude wait.
# 7. --start marks the SessionStart hook (0.7.2): the one-time setup message. While ~/.jevmem/setup-notice does not
#    exist, the first SessionStart on this machine works out what is missing, with two shell tests (the CLI, as in 3,
#    and this project's jevmem.config.json), says so in one message and writes the marker; when the CLI is there and
#    the project is on it writes the marker and says nothing, since the CLI then runs and says itself when no key is
#    saved. The launcher reads no key and no credential: a project that is not on gets no CLI run, as before. The
#    message is a systemMessage, which Claude Code's terminal shows, and, outside a terminal, additionalContext as well,
#    asking Claude to pass it on, since the desktop app's Code tab does not draw a hook's systemMessage (2.1.295).
#    Nothing is sent and nothing is written inside the project, and after the marker exists a SessionStart costs one
#    `[ -f ]` more than before. Creating the marker by hand is the opt-out. Since 0.7.3 the message and the marker only
#    where 8 says the marker persists; elsewhere this hook says nothing and writes nothing.
# 8. Where Claude Code runs (0.7.3), from two variables it gives its hooks. A cloud session (CLAUDE_CODE_REMOTE=true, as
#    Claude Code's docs say; or CLAUDE_CODE_ENTRYPOINT starting with remote, as a claude.ai chat's cloud workspace has
#    remote_cowork), Cowork on the desktop (local-agent, or CLAUDE_CODE_IS_COWORK), Claude Tag (Slack, Teams) and GitHub
#    Actions get no one-time message and no marker: each chat's workspace is new, so 0.7.2's message showed at the start
#    of every chat and its advice fits no workspace; the per-session line of 3 stays silent there too. A terminal (cli)
#    gets the message as a systemMessage alone; the desktop app's Code tab (claude-desktop), the VS Code extension
#    (claude-vscode) and the desktop app's SSH sessions (ssh-remote) get it with additionalContext too. Any other
#    entrypoint, or none (a `claude -p` run is sdk-cli), gets no message and no marker either, and the line of 3 as before.
# --guard marks the PreToolUse hook (the guard). A jevmem CLI from before the guard would read that event as a finished
# turn, so the launcher runs it only when the CLI has the `guard` command (checked once per CLI file and cached);
# otherwise it reads the input and exits 0 without output. It prints no warning for this hook.

for a in "$@"; do
  if [ "$a" = "--detach" ]; then trap '' TERM HUP INT; fi
done

project="${CLAUDE_PROJECT_DIR:-$PWD}"
enabled=0
if [ -f "$project/jevmem.config.json" ]; then enabled=1; fi
is_hook=0
start=0
for a in "$@"; do
  if [ "$a" = "hook" ]; then is_hook=1; fi
  if [ "$a" = "--start" ]; then start=1; fi
done

detach=0
if [ "$1" = "--detach" ]; then detach=1; shift; fi
guard=0
if [ "$1" = "--guard" ]; then guard=1; shift; fi
if [ "$1" = "--start" ]; then shift; fi

# 8. Where Claude Code runs: remote (a cloud session, Cowork, Claude Tag, GitHub Actions), terminal, app (the Code tab,
# the VS Code extension, an SSH session) or other. Shell tests on two variables; no process is started.
place="other"
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || [ -n "${CLAUDE_CODE_IS_COWORK:-}" ]; then place="remote"
else
  case "${CLAUDE_CODE_ENTRYPOINT:-}" in
    remote*|local-agent|local_agent|claude_in_slack|claude-in-slack|claude-in-teams|claude-code-github-action) place="remote" ;;
    cli) place="terminal" ;;
    claude-desktop|claude-vscode|ssh-remote) place="app" ;;
  esac
fi

# Node versions under ~/.nvm, newest first (numeric major, minor, patch).
nvm_versions() {
  ls "$HOME/.nvm/versions/node" 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p' | sort -t . -k 1,1nr -k 2,2nr -k 3,3nr
}

# 3. The CLI: on PATH, else the one cached below, else the first of a fixed list of common global bin directories,
# else the newest nvm Node version that has it. The cache in CLAUDE_PLUGIN_DATA holds five lines: the CLI path, an
# id (the CLI file's `ls -lL` line and this plugin's folder, which changes with each plugin version), the Node path,
# the version warning, and whether the CLI has the guard (1 or 0), so a warm run reads one small file with shell
# builtins and starts no extra process. Sets cli (empty when none) and the c_* cache fields; runs once.
cli=""; c_cli=""; c_id=""; c_node=""; c_warning=""; c_guard=""; cache=""; cli_searched=0
find_cli() {
  if [ "$cli_searched" -eq 1 ]; then return 0; fi
  cli_searched=1
  cache="${CLAUDE_PLUGIN_DATA:-}/cli"
  if [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && [ -f "$cache" ]; then
    { IFS= read -r c_cli; IFS= read -r c_id; IFS= read -r c_node; IFS= read -r c_warning; IFS= read -r c_guard; } < "$cache"
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
}

# 7. The one-time message, one text per state (src/setup.ts has the same texts; a test keeps them equal). No quotes or
# backslashes: they go into JSON through printf. The launcher reads no key: whether one is saved is the CLI's to say.
NOTICE_NOCLI="jevmem: the plugin is added, but the jevmem command it runs is not on this computer yet, so it does nothing. To finish: get the jevmem command (one line, in the README: https://github.com/Avinash-jetwani/jevmem#readme), then run jevmem setup in a project folder (it asks for your TypeSafe key and turns jevmem on there). Shown once."
NOTICE_NOTON="jevmem: the jevmem command is in place, but jevmem is not turned on in this project, so nothing is saved or sent from here. To turn it on here: run jevmem setup in this folder (it asks for your TypeSafe key if none is saved). Shown once."
# What asks Claude to pass the message on, around the text (\n is JSON's newline; printf %s leaves it as written).
RELAY_HEAD='<jevmem-setup-notice>\n'
RELAY_TAIL='\n</jevmem-setup-notice>\nThis is a one-time setup notice for the user from the jevmem plugin. Give it to the user at the start of your next reply, in these words, then go on with what they asked. It will not be shown again.'
notice=""
# Sets notice to the text for the first missing step and writes the marker; writes the marker alone when the CLI is
# there and the project is on. A marker that cannot be written means no message (it would otherwise show every session).
setup_notice() {
  find_cli
  state=""
  if [ -z "$cli" ]; then state="no-cli"
  elif [ "$enabled" -eq 0 ]; then state="not-on"
  fi
  ( umask 077; mkdir -p "$HOME/.jevmem" ) 2>/dev/null || return 0
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"
  if [ -z "$state" ]; then
    ( umask 077; printf 'done %s\n' "$now" > "$HOME/.jevmem/setup-notice" ) 2>/dev/null
    return 0
  fi
  ( umask 077; printf 'shown %s %s\n' "$state" "$now" > "$HOME/.jevmem/setup-notice" ) 2>/dev/null || return 0
  case "$state" in
    no-cli) notice="$NOTICE_NOCLI" ;;
    not-on) notice="$NOTICE_NOTON" ;;
  esac
}
# The message as the hook's JSON output, when the CLI is not run for this event.
print_notice() {
  if [ "$place" = "terminal" ]; then
    printf '{"systemMessage":"%s"}\n' "$notice"
  else
    printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s%s%s"}}\n' "$notice" "$RELAY_HEAD" "$notice" "$RELAY_TAIL"
  fi
}
if [ "$start" -eq 1 ] && [ "$is_hook" -eq 1 ] && { [ "$place" = "terminal" ] || [ "$place" = "app" ]; } && [ ! -f "$HOME/.jevmem/setup-notice" ]; then setup_notice; fi

# 2. A hook in a project that is not turned on: read the input, say the one-time message if this is its moment, exit.
if [ "$enabled" -eq 0 ] && [ "$is_hook" -eq 1 ]; then
  cat > /dev/null 2>&1
  if [ -n "$notice" ]; then print_notice; fi
  exit 0
fi

# No CLI, or no Node to run it: a hook reads its input and exits 0. The UserPromptSubmit hook (not --detach) prints
# $1 as a systemMessage, which Claude Code shows the user, once per session: the session ids already told are listed
# in CLAUDE_PLUGIN_DATA/notified; not in a cloud or Cowork session (8), where it stays silent. The SessionStart hook
# prints the one-time message when this is its moment. The Stop hook stays silent. Outside a hook, $1 goes to stderr.
not_found() {
  msg="$1"; shift
  if [ "$is_hook" -eq 1 ]; then
    input="$(cat 2>/dev/null)"
    if [ "$start" -eq 1 ]; then
      if [ -n "$notice" ]; then print_notice; fi
      exit 0
    fi
    [ "$detach" -eq 0 ] || exit 0
    [ "$place" != "remote" ] || exit 0
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
  echo "$msg" >&2
  exit 0
}
readme="See the jevmem README to set it up: https://github.com/Avinash-jetwani/jevmem#readme"

find_cli
if [ -z "$cli" ]; then not_found "jevmem: CLI not found, so memory is off in this project. $readme" "$@"; fi

# 4 and 5, from the cache when it is for this CLI file and this plugin version.
cache_id="$(ls -lL "$cli" 2>/dev/null)|${CLAUDE_PLUGIN_ROOT:-}"
node=""
warning=""
has_guard=""
cached=0
if [ "$c_cli" = "$cli" ] && [ "$c_id" = "$cache_id" ] && [ -n "$c_guard" ] && { [ -z "$c_node" ] || [ -x "$c_node" ]; }; then
  node="$c_node"; warning="$c_warning"; has_guard="$c_guard"; cached=1
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
  # Does this CLI have the guard? One that doesn't answers `guard --help` with "unknown command" and exit 1. Asked
  # from / so that an older CLI does nothing in this project (such as showing a one-time notice nobody would see).
  if (cd / && cli_run guard --help) </dev/null >/dev/null 2>&1; then has_guard=1; else has_guard=0; fi
  if [ -n "${CLAUDE_PLUGIN_DATA:-}" ] && [ -n "$cli_version" ]; then
    mkdir -p "$CLAUDE_PLUGIN_DATA" 2>/dev/null && printf '%s\n%s\n%s\n%s\n%s\n' "$cli" "$cache_id" "$node" "$warning" "$has_guard" > "$cache" 2>/dev/null
  fi
fi

# The guard's hook with a CLI that has no guard: read the input and exit 0, with no output.
if [ "$guard" -eq 1 ] && [ "$has_guard" != "1" ]; then cat > /dev/null 2>&1; exit 0; fi

# 5. One warning line when the CLI is older than this plugin (not from the guard's hook, which runs on every tool call).
if [ -n "$warning" ] && [ "$guard" -eq 0 ]; then echo "$warning" >&2; fi

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
    # Job control gives the CLI its own process group. The shell and the child both set it, and when the child is first
    # the shell prints "child setpgid (...): Operation not permitted" (harmless, about 1 launch in 1,000). Nothing else is
    # printed from here, so stderr goes to /dev/null first; a redirected { … & } group would leave the CLI holding it.
    set -m
    exec 2>/dev/null
    cli_run "$@" --stdin-file "$tmp" </dev/null >/dev/null 2>&1 &
  fi
  exit 0
fi
if [ -n "$node" ]; then exec "$node" "$cli" "$@"; fi
exec "$cli" "$@"
