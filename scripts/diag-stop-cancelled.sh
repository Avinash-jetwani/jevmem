#!/usr/bin/env bash
# Why does the async Stop hook read "exit_code 1, cancelled" after a `claude -p` turn? One `claude -p` turn per run, in
# a temporary CLAUDE_CONFIG_DIR, HOME and enabled project (never ~/.claude), with one plugin loaded by --plugin-dir, and
# the Stop hook's hook_response event read from --include-hook-events. No TypeSafe key is given: the hooks log "no key"
# lines, which shows whether the Stop hook's CLI ran. Plugins compared:
#   ctlasync  a control plugin whose only hook is an async Stop hook running `true`
#   ctlsync   the same, not async
#   j057      the plugin the directory serves (0.5.7), from $J057 (a copy of ~/.claude/plugins/synced/<bucket>/<id>/),
#             with the jevmem on PATH
#   jmain     this checkout's plugin/, with this checkout's dist/cli.js as `jevmem`
#
#   scripts/diag-stop-cancelled.sh [--runs N] [--out results/x.json]
#
# Auth as scripts/e2e.sh: CLAUDE_CODE_OAUTH_TOKEN, or ~/.jevmem/e2e-oauth-token (never printed).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNS=6; OUT=""
while [ $# -gt 0 ]; do case "$1" in --runs) RUNS="$2"; shift 2;; --out) OUT="$2"; shift 2;; *) echo "unknown $1"; exit 2;; esac; done
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude)}"
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || CLAUDE_CODE_OAUTH_TOKEN="$(tr -d '[:space:]' < "$HOME/.jevmem/e2e-oauth-token" 2>/dev/null)"
[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || { echo "no CLAUDE_CODE_OAUTH_TOKEN and no ~/.jevmem/e2e-oauth-token"; exit 2; }
NODE_BIN="$(dirname "$(command -v node)")"
W="$(mktemp -d /tmp/jevmem-stopdiag.XXXXXX)"; trap 'rm -rf "$W"' EXIT
mk() { mkdir -p "$W/$1/.claude-plugin" "$W/$1/hooks"; printf '{"name":"%s","version":"0.0.1"}\n' "$1" > "$W/$1/.claude-plugin/plugin.json"; printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"true"%s,"timeout":20}]}]}}\n' "$2" > "$W/$1/hooks/hooks.json"; }
mk ctlasync ',"async":true'; mk ctlsync ''
cp -R "$ROOT/plugin" "$W/jmain"; mkdir -p "$W/mainbin"; ln -s "$ROOT/dist/cli.js" "$W/mainbin/jevmem"
J057="${J057:-$(ls -d "$HOME"/.claude/plugins/synced/*/*/ 2>/dev/null | while read -r d; do grep -q '"name": *"jevmem"' "$d/.claude-plugin/plugin.json" 2>/dev/null && echo "$d" && break; done)}"
plugins="ctlsync ctlasync jmain"; [ -n "$J057" ] && { cp -R "$J057" "$W/j057"; plugins="ctlsync ctlasync j057 jmain"; }

one() { # one() <plugin> -> "<exit_code> <outcome> <stop reached the CLI 0|1>"
  local p="$1" t; t="$(mktemp -d "$W/run.XXXXXX")"; mkdir -p "$t/home" "$t/cfg" "$t/proj"
  [ -d "$HOME/.nvm" ] && ln -s "$HOME/.nvm" "$t/home/.nvm"
  ( cd "$t/proj" && git init -q && env HOME="$t/home" "$NODE_BIN/node" "$ROOT/dist/cli.js" enable >/dev/null )
  local bin=""; [ "$p" = jmain ] && bin="$W/mainbin:"
  ( cd "$t/proj" && env -i HOME="$t/home" USER="$USER" PATH="$bin$NODE_BIN:/usr/bin:/bin" TERM=dumb CLAUDE_CONFIG_DIR="$t/cfg" DISABLE_AUTOUPDATER=1 CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN}" \
    "$CLAUDE_BIN" -p "reply with ok" --max-turns 1 --plugin-dir "$W/$p" --output-format stream-json --verbose --include-hook-events < /dev/null > "$t/ev" 2>/dev/null )
  sleep 4
  "$NODE_BIN/node" -e '
    const fs=require("fs");const [ev,log]=process.argv.slice(1);let r=null;
    for(const l of fs.readFileSync(ev,"utf8").split("\n")){try{const e=JSON.parse(l);if(e.type==="system"&&e.subtype==="hook_response"&&e.hook_event==="Stop")r=e}catch{}}
    const ran=fs.existsSync(log)&&/"error":"Stop:/.test(fs.readFileSync(log,"utf8"));
    console.log(`${r?r.exit_code:"none"} ${r?r.outcome:"none"} ${ran?1:0}`)' "$t/ev" "$t/proj/.jevmem/log.jsonl"
  rm -rf "$t"
}
echo "Claude Code $("$CLAUDE_BIN" --version | head -1); $RUNS run(s) per plugin"
json="{\"date\":\"$(date +%F)\",\"claudeCode\":\"$("$CLAUDE_BIN" --version | head -1 | cut -d' ' -f1)\",\"runsPerPlugin\":$RUNS,\"plugins\":{"
first=1
for p in $plugins; do
  c=0; s=0; ran=0
  for _ in $(seq 1 "$RUNS"); do read -r code outcome reached <<<"$(one "$p")"; [ "$outcome" = cancelled ] && c=$((c+1)); [ "$outcome" = success ] && s=$((s+1)); ran=$((ran+reached)); done
  echo "$p: cancelled $c, success $s, Stop reached the jevmem CLI $ran (of $RUNS)"
  [ $first -eq 1 ] || json+=","; first=0
  json+="\"$p\":{\"n\":$RUNS,\"cancelled\":$c,\"success\":$s,\"stopReachedCli\":$ran}"
done
json+="}}"
[ -n "$OUT" ] && printf '%s\n' "$json" | "$NODE_BIN/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s),null,2)+"\n"))' > "$OUT" && echo "wrote $OUT"
