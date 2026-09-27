#!/usr/bin/env python3
"""How a plugin user sets or changes the sensitive `typesafe_api_key` option, checked in Claude Code's own terminal UI.

    python3 scripts/plugin-configure-check.py [--claude <path to the claude binary>]   (run `pnpm build` first)

The jevmem plugin is installed from a marketplace that is NOT called jevmem (a copy of plugin/ in a temporary marketplace
named not-jevmem), in a temporary CLAUDE_CONFIG_DIR, and Claude Code's TUI is driven on a pseudo-terminal:

  A. `/plugin configure jevmem` (no marketplace name): type a key into the masked field, Enter.
  B. The same command again, with another key: the value is replaced after install.
  C. The path Claude Code's docs describe: `/plugin`, Tab to the Installed tab, Enter on jevmem, Configure options.
  D. `claude plugin install jevmem@not-jevmem --config typesafe_api_key=…` on the installed plugin (informational).

After each, a headless session (`claude -p`) in an enabled project runs jevmem's hooks, and a local stand-in for Jev (not
the real Jev) records the key each request carries: the step passes when every request carries the key just entered.
The keys are fake test values. Needs the e2e token (CLAUDE_CODE_OAUTH_TOKEN, or ~/.jevmem/e2e-oauth-token) for the
sessions. Claude Code keeps the sensitive value in the macOS keychain, in an item named after the temporary config dir
(`Claude Code-credentials-<hash>`, not your own); the script deletes that item at the end. DISABLE_AUTOUPDATER=1 keeps
Claude Code from updating itself during the run.
"""
import fcntl, hashlib, http.server, json, os, pty, re, select, shutil, struct, subprocess, sys, tempfile, termios, threading, time, unicodedata

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = sys.argv[1:]
CLAUDE = args[args.index("--claude") + 1] if "--claude" in args else shutil.which("claude")
TOKEN = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or open(os.path.expanduser("~/.jevmem/e2e-oauth-token")).read().strip()
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_=>]")

def clean(s):
    return re.sub(r"[ \t]+", " ", ANSI.sub(" ", s).replace("\r", "\n"))

class Tui:
    """Claude Code's TUI on a pseudo-terminal: start it, wait for text, type."""
    def __init__(self, cwd, env, log):
        self.log = open(log, "a")
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execve(CLAUDE, [CLAUDE], env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 140, 0, 0))
        self.raw = ""
        self.mark = 0
    def pump(self, secs):
        end = time.time() + secs
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], max(0, min(0.2, end - time.time())))
            if r:
                try:
                    d = os.read(self.fd, 65536).decode("utf-8", "replace")
                except OSError:
                    return False
                if not d:
                    return False
                self.raw += d
                self.log.write(d)
        return True
    def since(self, i):
        return clean(self.raw[i:])
    def wait_for(self, pattern, timeout):
        end = time.time() + timeout
        while time.time() < end:
            if re.search(pattern, self.since(self.mark), re.S):
                return True
            if not self.pump(0.3):
                break
        return bool(re.search(pattern, self.since(self.mark), re.S))
    def type(self, s):
        self.mark = len(self.raw)
        for ch in s:
            os.write(self.fd, ch.encode())
            time.sleep(0.03)
        self.pump(0.8)
    def send(self, s, settle):
        self.mark = len(self.raw)
        os.write(self.fd, s.encode())
        self.pump(settle)
    def selected(self):
        for line in reversed(clean(self.raw[-6000:]).split("\n")):
            if "❯" in line:
                return line
        return ""
    def close(self):
        for _ in range(2):
            try:
                os.write(self.fd, b"\x03")
            except OSError:
                pass
            self.pump(1)
        try:
            os.kill(self.pid, 9)
            os.waitpid(self.pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass

class StandIn:
    """A stand-in for Jev (not the real one): records the key of each request, answers every question with a quiet no."""
    def __init__(self):
        self.keys = []
        outer = self
        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
                if body.get("state") != "ready":  # the daemon's warm-up call
                    outer.keys.append(self.headers.get("authorization", "").replace("Bearer ", ""))
                ans = {}
                for name, q in (body.get("questions") or {}).items():
                    if q.get("type") == "noul":
                        ans[name] = {"type": "noul", "noul": 0.05}
                    elif q.get("type") == "choice":
                        labels = list(q["criteria"]); c = "none" if "none" in labels else labels[0]
                        ans[name] = {"type": "choice", "choice": c, "probabilities": {l: 0.9 if l == c else 0.1 / max(1, len(labels) - 1) for l in labels}, "confidence": 0.9}
                    else:
                        ans[name] = {"type": "score", "score": 0, "probabilities": {"0": 1}, "legend": {}, "confidence": 1}
                out = json.dumps({"model": "stand-in", "answers": ans, "usage": {"input_tokens": 1, "output_tokens": 1}}).encode()
                self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(out))); self.end_headers(); self.wfile.write(out)
            def log_message(self, *a):
                pass
        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"

def main():
    root = os.path.realpath(tempfile.mkdtemp(prefix="jevmem-plugin-configure-"))
    cfg, market, binp, project = (os.path.join(root, d) for d in ("config", "market", "bin", "project"))
    jev = StandIn()
    # A marketplace that is not called jevmem, with this checkout's plugin in it.
    shutil.copytree(os.path.join(REPO, "plugin"), os.path.join(market, "plugin"))
    os.makedirs(os.path.join(market, ".claude-plugin"))
    json.dump({"name": "not-jevmem", "owner": {"name": "test"}, "plugins": [{"name": "jevmem", "description": "jevmem from a marketplace not called jevmem", "source": "./plugin"}]}, open(os.path.join(market, ".claude-plugin", "marketplace.json"), "w"))
    # The jevmem CLI and Node on the PATH, as an npm install gives; an enabled project with one memory line whose
    # .jevmem/.env points jevmem at the stand-in.
    os.makedirs(binp); os.symlink(os.path.join(REPO, "dist", "cli.js"), os.path.join(binp, "jevmem")); os.symlink(shutil.which("node"), os.path.join(binp, "node"))
    os.makedirs(project)
    cli_env = {"PATH": f"{binp}:/usr/bin:/bin", "HOME": os.path.join(root, "cli-home"), "TMPDIR": "/tmp"}
    for a in (["enable"], ["add", "decision", "We use Postgres 16 for the primary store."]):
        subprocess.run(["jevmem", *a], cwd=project, env=cli_env, capture_output=True)
    open(os.path.join(project, ".jevmem", ".env"), "w").write(f"TYPESAFE_BASE_URL={jev.url}\n")
    os.makedirs(cfg)
    json.dump({"hasCompletedOnboarding": True, "theme": "dark", "projects": {project: {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}}}, open(os.path.join(cfg, ".claude.json"), "w"))
    env = {"HOME": os.environ["HOME"], "USER": os.environ["USER"], "PATH": f"{binp}:/usr/bin:/bin:/usr/sbin:/sbin", "TERM": "xterm-256color", "LANG": "en_US.UTF-8", "TMPDIR": "/tmp",
           "CLAUDE_CONFIG_DIR": cfg, "CLAUDE_CODE_OAUTH_TOKEN": TOKEN, "DISABLE_AUTOUPDATER": "1", "JEVMEM_CACHE": "0"}
    log = os.path.join(root, "tui.log")
    def run(*a):
        return subprocess.run([CLAUDE, *a], cwd=project, env=env, capture_output=True, text=True, timeout=240, stdin=subprocess.DEVNULL)
    def show(text):
        print("  " + text.strip().replace(root, "<tmp>").replace("\n", "\n  "))
    results = {}
    try:
        print(f"# {run('--version').stdout.strip()}, in a temporary CLAUDE_CONFIG_DIR; Jev is a local stand-in (not the real Jev)")
        for a in (["plugin", "marketplace", "add", market], ["plugin", "install", "jevmem@not-jevmem"]):
            r = run(*a); print("$ claude " + " ".join("<marketplace not named jevmem>" if x == market else x for x in a)); show(r.stdout + r.stderr)

        def headless(label, key):
            n = len(jev.keys)
            # A question of its own each time: a repeated one is answered from jevmem's cache or skipped as seen.
            run("-p", f"Step {label}: which database do we use for the primary store? One short sentence.", "--max-turns", "1")
            time.sleep(1)
            keys = jev.keys[n:]
            ok = bool(keys) and all(k == key for k in keys)
            print(f"{'PASS' if ok else 'FAIL'} {label}: the next session's hooks sent {len(keys)} request(s) to the stand-in, with key(s) {sorted(set(keys))}; expected {key}")
            return ok

        def enter_key(t, key):
            t.type(key)
            masked = key not in t.since(t.mark)
            start = len(t.raw)
            t.send("\r", 3)
            saved = "Configuration saved" in t.since(start)
            return masked, saved

        def by_command(key):
            t = Tui(project, env, log)
            t.wait_for(r"for shortcuts", 60)
            t.type("/plugin configure jevmem"); t.send("\r", 1)
            opened = t.wait_for(r"Configure jevmem.*Plugin options", 20)
            masked, saved = enter_key(t, key) if opened else (False, False)
            t.close()
            return opened, masked, saved

        def by_menu(key):
            t = Tui(project, env, log)
            t.wait_for(r"for shortcuts", 60)
            t.type("/plugin"); t.send("\r", 3)
            t.send("\t", 1); t.wait_for(r"jevmem", 10)  # Discover -> Installed
            t.send("\r", 2)  # jevmem's details
            for _ in range(12):
                if "Configure options" in t.selected():
                    break
                t.send("\x1b[B", 0.6)
            t.send("\r", 2)
            opened = t.wait_for(r"Configure jevmem.*Plugin options", 20)
            masked, saved = enter_key(t, key) if opened else (False, False)
            t.close()
            return opened, masked, saved

        for step, how, key in (("A", "/plugin configure jevmem", "cfg-test-key-A-0001"), ("B", "/plugin configure jevmem, again", "cfg-test-key-B-0002"), ("C", "/plugin > Installed > jevmem > Configure options", "cfg-test-key-C-0003")):
            opened, masked, saved = (by_command if step != "C" else by_menu)(key)
            print(f"{'PASS' if opened and masked and saved else 'FAIL'} {step} ({how}): the 'Configure jevmem' dialog opened: {opened}; the key was masked: {masked}; 'Configuration saved.': {saved}")
            results[step] = opened and masked and saved and headless(f"{step}", key)
        r = run("plugin", "install", "jevmem@not-jevmem", "--config", "typesafe_api_key=cfg-test-key-D-0004")
        print("$ claude plugin install jevmem@not-jevmem --config typesafe_api_key=<key D>   (the plugin is installed already)"); show((r.stdout + r.stderr).replace("cfg-test-key-D-0004", "<key D>"))
        results["D"] = headless("D (informational)", "cfg-test-key-D-0004")
    finally:
        subprocess.run(["jevmem", "daemon", "stop"], cwd=project, env=cli_env, capture_output=True)
        svc = "Claude Code-credentials-" + hashlib.sha256(unicodedata.normalize("NFC", cfg).encode()).hexdigest()[:8]
        found = subprocess.run(["security", "delete-generic-password", "-a", os.environ["USER"], "-s", svc], capture_output=True).returncode == 0
        print(f"# cleanup: the keychain item {svc} (this run's temporary config) {'deleted' if found else 'was not there'}; the daemon stopped")
    ok = all(results.get(s) for s in "ABC")
    print("RESULT", "A, B and C passed" if ok else f"failed: {results}")
    sys.exit(0 if ok else 1)

main()
