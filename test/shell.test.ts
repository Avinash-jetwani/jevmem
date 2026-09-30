/**
 * The shell reader (src/shell.ts): how a command line is read the way the shell reads it. Heredocs and here-strings
 * are the input of the command that owns them, never commands of their own; a body runs as commands only when a shell
 * reads it; `bash -c` and `eval` strings are commands; a script written and then run on the same command line is read;
 * paths follow `cd`, `pushd`, `popd`, `~` and `git -C`. Nothing here touches the disk or the network.
 */
import { describe, expect, it } from "vitest";
import { commitMessage } from "../src/prefilter.js";
import { commandOf, condenseHeredocs, expandPath, readCommandLine, shellGlobRegExp, shellWords, stripKeywords, substitutionsIn, withDirs } from "../src/shell.js";

const texts = (cmd: string) => readCommandLine(cmd).map((c) => c.text);
const vias = (cmd: string) => readCommandLine(cmd).map((c) => `${c.via}:${c.text}`);
const j = (...lines: string[]) => lines.join("\n");

describe("heredocs and here-strings are input, not commands", () => {
  it("a heredoc's body belongs to the command that owns it; the lines after the delimiter are commands again", () => {
    const cmds = readCommandLine(j("cat > notes.md <<'EOF'", "git push --force origin main", "rm -rf /", "EOF", "ls"));
    expect(cmds.map((c) => c.text)).toEqual(["cat > notes.md <<'EOF'", "ls"]);
    expect(cmds[0]!.input).toEqual([{ op: "<<", body: "git push --force origin main\nrm -rf /", quoted: true }]);
    expect(cmds[0]!.writes).toEqual([{ file: "notes.md", content: "git push --force origin main\nrm -rf /", append: false }]);
    expect(cmds[1]!.input).toEqual([]);
  });

  it("every form: <<EOF, <<-EOF with tabs, <<'EOF', <<\"EOF\", << EOF, two heredocs on one line, and <<< here-strings", () => {
    expect(readCommandLine(j("cat <<EOF", "a", "EOF"))[0]!.input).toEqual([{ op: "<<", body: "a", quoted: false }]);
    expect(readCommandLine(j("cat <<-EOF", "\t\ta", "\tEOF"))[0]!.input).toEqual([{ op: "<<", body: "a", quoted: false }]);
    expect(readCommandLine(j('cat <<"EOF"', "$(rm x)", "EOF"))[0]!.input).toEqual([{ op: "<<", body: "$(rm x)", quoted: true }]);
    expect(readCommandLine(j("cat << END", "a", "END"))[0]!.input[0]!.body).toBe("a");
    const two = readCommandLine(j("diff <(cat <<'A') <(cat <<'B')", "one", "A", "two", "B"));
    expect(two.filter((c) => c.input.length).map((c) => c.input[0]!.body)).toEqual(["one", "two"]);
    expect(readCommandLine("grep x <<< 'git push --force'")[0]).toMatchObject({ words: ["grep", "x"], input: [{ op: "<<<", body: "git push --force", quoted: true }] });
    expect(shellWords("cat <<< hello").hereStrings).toEqual(["hello"]);
  });

  it("a body with no delimiter runs to the end; a body's own quotes and # are literal", () => {
    expect(readCommandLine(j("cat <<'EOF'", "it's # not a comment", "rm 'x"))[0]!.input[0]!.body).toBe("it's # not a comment\nrm 'x");
    expect(texts(j("cat <<'EOF'", "it's # not a comment", "EOF", "echo done"))).toEqual(["cat <<'EOF'", "echo done"]);
  });

  it("fed to a shell, the body is commands: bash, sh -s, zsh, dash, piped from cat, or read from a written file", () => {
    expect(vias(j("bash <<'EOF'", "cd app", "git push -f origin main", "EOF"))).toEqual(["line:bash <<'EOF'", "shell:cd app", "shell:git push -f origin main"]);
    expect(vias(j("sh -s <<'EOF'", "rm -rf build", "EOF"))).toContain("shell:rm -rf build");
    expect(vias(j("cat <<'EOF' | sh", "npm publish", "EOF"))).toEqual(["line:cat <<'EOF'", "line:sh", "shell:npm publish"]);
    expect(vias(j("cat > x.sh <<'EOF'", "npm publish", "EOF", "bash < x.sh"))).toContain("script:npm publish");
    // Any other command: the body is its input, never commands.
    expect(vias(j("python3 - <<'EOF'", "import os; os.system('git push -f')", "EOF"))).toEqual(["line:python3 - <<'EOF'"]);
    expect(vias(j("psql db <<'EOF'", "select 1;", "EOF"))).toEqual(["line:psql db <<'EOF'"]);
    expect(vias(j("git commit -F - <<'EOF'", "message", "EOF"))).toEqual(["line:git commit -F - <<'EOF'"]);
  });

  it("in an unquoted heredoc, $( ) and backticks in the body run", () => {
    expect(vias(j("python3 - <<EOF", 'print("$(git push -f origin main)")', "EOF"))).toEqual(["line:python3 - <<EOF", "substitution:git push -f origin main"]);
    expect(vias(j("cat > x <<EOF", "`rm -rf build`", "EOF"))).toContain("substitution:rm -rf build");
    expect(vias(j("cat > x <<'EOF'", "$(rm -rf build)", "EOF"))).toEqual(["line:cat > x <<'EOF'"]);
    expect(substitutionsIn("a $(b c) d `e` f")).toEqual(["b c", "e"]);
  });
});

describe("shell strings, eval and scripts written then run", () => {
  it("bash -c, sh -c, zsh -c, dash -c, with the c in a cluster, and eval are read as commands", () => {
    expect(vias("bash -c 'git push -f origin main'")).toEqual(["line:bash -c 'git push -f origin main'", "shell:git push -f origin main"]);
    expect(vias("sh -c 'cd app && rm -rf build'")).toEqual(["line:sh -c 'cd app && rm -rf build'", "shell:cd app", "shell:rm -rf build"]);
    expect(vias('zsh -c "npm publish"')).toContain("shell:npm publish");
    expect(vias("dash -c 'ls'")).toContain("shell:ls");
    expect(vias("bash -lc 'npm publish'")).toContain("shell:npm publish");
    expect(vias("bash -e -c 'npm publish' arg0")).toContain("shell:npm publish");
    expect(vias('eval "git push -f origin main"')).toEqual(['line:eval "git push -f origin main"', "eval:git push -f origin main"]);
    expect(vias("eval git push -f origin main")).toContain("eval:git push -f origin main");
    // A shell running a file the command line did not write: nothing to read.
    expect(vias("bash deploy.sh")).toEqual(["line:bash deploy.sh"]);
  });

  it("a file the same command line writes and then runs is read as commands: bash x, sh x, ./x, source x, . x, bash < x, printf > x", () => {
    for (const run of ["bash /tmp/x.sh", "sh /tmp/x.sh", "zsh /tmp/x.sh", "source /tmp/x.sh", ". /tmp/x.sh", "bash < /tmp/x.sh", "/tmp/x.sh", "nohup /tmp/x.sh"]) {
      expect(vias(j("cat > /tmp/x.sh <<'EOF'", "git push -f origin main", "EOF", run)), run).toContain("script:git push -f origin main");
    }
    expect(vias(j("cat > run.sh <<'EOF'", "npm publish", "EOF", "chmod +x run.sh && ./run.sh"))).toContain("script:npm publish");
    expect(vias(j("tee run.sh <<'EOF' >/dev/null", "npm publish", "EOF", "sh run.sh"))).toContain("script:npm publish");
    expect(vias(j("cat <<'EOF' | tee run.sh", "npm publish", "EOF", "sh run.sh"))).toContain("script:npm publish");
    expect(vias("printf 'git push -f origin main\\n' > /tmp/p.sh && bash /tmp/p.sh")).toContain("script:git push -f origin main");
    expect(vias("echo 'npm publish' >> /tmp/p.sh; bash /tmp/p.sh")).toContain("script:npm publish");
    expect(vias(j("S=/tmp/s; cat > $S/go.sh <<'EOF'", "npm publish", "EOF", "chmod +x $S/go.sh && $S/go.sh"))).toContain("script:npm publish");
    // Written and run by something that is not a shell: the content is a Write, not commands.
    expect(vias(j("cat > /tmp/x.py <<'EOF'", "os.system('git push -f')", "EOF", "python3 /tmp/x.py"))).toEqual(["line:cat > /tmp/x.py <<'EOF'", "line:python3 /tmp/x.py"]);
  });

  it("substitutions, subshells, comments, quotes and line continuations, as before", () => {
    expect(texts("echo $(git add .env) `rm x`")).toEqual(["echo", "git add .env", "rm x"]);
    expect(texts('echo "$(git push -f)"')).toEqual(['echo "$(git push -f)"', "git push -f"]);
    expect(texts("(cd app && git add .env)")).toEqual(["cd app", "git add .env"]);
    expect(texts("ls # && rm -rf /")).toEqual(["ls"]);
    expect(texts("a && b || c; d | e & f\ng")).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(texts('echo "x && y" \'z; w\'')).toEqual(['echo "x && y" \'z; w\'']);
    expect(readCommandLine("git commit \\\n  -m x")[0]!.words).toEqual(["git", "commit", "-m", "x"]);
    expect(readCommandLine("cat x >| out")[0]!.redirectOps).toEqual([">|"]);
    // A $( ) that holds a heredoc with an apostrophe in its body.
    const claude = readCommandLine(j('git commit -m "$(cat <<\'EOF\'', "Fix the user's login", "", "Co-Authored-By: X <x@example.com>", "EOF", ')"'));
    expect(claude.map((c) => c.via)).toEqual(["line", "substitution"]);
    expect(claude[1]!.input[0]!.body).toBe("Fix the user's login\n\nCo-Authored-By: X <x@example.com>");
  });
});

describe("the folder each command runs in", () => {
  const dirs = (cmd: string, cwd = "/p", home = "/home/me") => withDirs(readCommandLine(cmd), cwd, home, "/p").map((c) => `${c.text}@${c.cwd}`);
  it("follows cd, pushd, popd, ~, $HOME and $PWD; cd to a folder it cannot tell makes the rest unknown", () => {
    expect(dirs("cd web && rm x")).toEqual(["cd web@/p", "rm x@/p/web"]);
    expect(dirs("pushd web/app; rm x; popd; rm y")).toEqual(["pushd web/app@/p", "rm x@/p/web/app", "popd@/p/web/app", "rm y@/p"]);
    expect(dirs("cd ~/work && rm x")[1]).toBe("rm x@/home/me/work");
    expect(dirs('cd "$HOME/work" && rm x')[1]).toBe("rm x@/home/me/work");
    expect(dirs("cd $PWD/web && rm x")[1]).toBe("rm x@/p/web");
    expect(dirs("cd .. && rm x")[1]).toBe("rm x@/");
    expect(dirs('cd "$DIR" && rm x')[1]).toBe("rm x@null");
    expect(dirs("cd - && rm x")[1]).toBe("rm x@null");
    expect(dirs("cd && rm x")[1]).toBe("rm x@/home/me");
  });

  it("a cd inside bash -c, a subshell or a script stays there", () => {
    expect(dirs("bash -c 'cd /tmp && rm x' && rm y")).toEqual(["bash -c 'cd /tmp && rm x'@/p", "cd /tmp@/p", "rm x@/tmp", "rm y@/p"]);
    expect(dirs("(cd /tmp && rm x); rm y")).toEqual(["cd /tmp@/p", "rm x@/tmp", "rm y@/p"]);
    expect(dirs(j("cat > /tmp/s.sh <<'EOF'", "cd /tmp", "rm x", "EOF", "bash /tmp/s.sh; rm y")).at(-1)).toBe("rm y@/p");
  });

  it("expands ~, $HOME, ${HOME}, $PWD and $CLAUDE_PROJECT_DIR in a path, and gives up on anything else the shell would expand", () => {
    expect(expandPath("~/.jevmem/env", "/p", "/home/me", "/p")).toBe("/home/me/.jevmem/env");
    expect(expandPath("$HOME/.jevmem/env", "/p", "/home/me", "/p")).toBe("/home/me/.jevmem/env");
    expect(expandPath("${HOME}/x", "/p", "/home/me", "/p")).toBe("/home/me/x");
    expect(expandPath("$PWD/.jevmem", "/p", "/home/me", "/p")).toBe("/p/.jevmem");
    expect(expandPath("$CLAUDE_PROJECT_DIR/.jevmem", "/p", "/home/me", "/p")).toBe("/p/.jevmem");
    expect(expandPath("$S/x.sh", "/p", "/home/me", "/p")).toBeNull();
    expect(expandPath("~bob/x", "/p", "/home/me", "/p")).toBeNull();
    expect(expandPath("~/x", "/p", undefined, "/p")).toBeNull();
  });
});

describe("the message a git commit would get", () => {
  const msg = (cmd: string, readFile?: (f: string) => string | null) => {
    const c = withDirs(readCommandLine(cmd), "/p", "/home/me", "/p").find((x) => x.words.includes("commit"))!;
    return commitMessage(c, { home: "/home/me", readFile });
  };
  it("-m, several -m joined as git joins them, --message=, -am, -F -, -F <file>, --trailer, -s, and the $(cat <<'EOF') form", () => {
    expect(msg('git commit -m "docs: x"')).toBe("docs: x");
    expect(msg('git commit -m "docs: x" -m "Co-Authored-By: Someone <x@example.com>"')).toBe("docs: x\n\nCo-Authored-By: Someone <x@example.com>");
    expect(msg('git commit --message="docs: x" --message "more"')).toBe("docs: x\n\nmore");
    expect(msg("git commit -am 'fix'")).toBe("fix");
    expect(msg("git commit -qm 'fix'")).toBe("fix");
    expect(msg(j("git commit -F - <<'EOF'", "subject", "", "Signed-off-by: A <a@example.com>", "EOF"))).toBe("subject\n\nSigned-off-by: A <a@example.com>");
    expect(msg(j("cat <<'EOF' | git commit -F -", "piped subject", "EOF"))).toBe("piped subject");
    expect(msg("git commit -F notes/msg.txt", (f) => (f === "/p/notes/msg.txt" ? "from a file\n" : null))).toBe("from a file\n");
    expect(msg("cd sub && git commit --file=msg.txt", (f) => (f === "/p/sub/msg.txt" ? "in sub" : null))).toBe("in sub");
    expect(msg("git commit -F msg.txt")).toBeNull();
    expect(msg('git commit -m x --trailer "Co-authored-by: Y <y@example.com>"')).toBe("x\n\nCo-authored-by: Y <y@example.com>");
    expect(msg("git commit -s -m x")).toBe("x\n\nSigned-off-by: (the committer's name and email)");
    expect(msg("git commit --signoff -am x")).toBe("x\n\nSigned-off-by: (the committer's name and email)");
    expect(msg("git commit --amend --trailer 'Co-Authored-By: Bot <b@example.com>' --no-edit")).toBe("Co-Authored-By: Bot <b@example.com>");
    expect(msg(j('git commit -m "$(cat <<\'EOF\'', "feat: the form Claude Code uses", "", "Co-Authored-By: Claude <noreply@anthropic.com>", "EOF", ')"'))).toBe("feat: the form Claude Code uses\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
    expect(msg('git commit -m "$(printf "one\\ntwo")"')).toBe("one\ntwo");
  });

  it("no message in the call: an editor, --amend --no-edit, -c, -C, --fixup, --squash, and -t", () => {
    for (const c of ["git commit", "git commit --amend --no-edit", "git commit -c HEAD", "git commit -C HEAD~1", "git commit --fixup HEAD", "git commit --squash abc123", "git commit -t /tmp/template"]) expect(msg(c), c).toBeNull();
    expect(msg("git -c user.name=X commit -m y")).toBe("y");
    expect(msg("git -C sub commit -m y")).toBe("y");
  });
});

describe("what is sent", () => {
  it("cuts each heredoc body to the size given, around the terms, and keeps the shape of the call", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i} of the script`).join("\n");
    const cmd = j("cat > /tmp/x.sh <<'EOF'", body, "EOF", "bash /tmp/x.sh");
    const out = condenseHeredocs(cmd, 80, (b) => `${b.slice(0, 77)}…`);
    expect(out.startsWith("cat > /tmp/x.sh <<'EOF'\nline 0 of the script")).toBe(true);
    expect(out.endsWith("…\nEOF\nbash /tmp/x.sh")).toBe(true);
    expect(out.length).toBeLessThan(cmd.length);
    expect(condenseHeredocs("ls -la", 80, (b) => b)).toBe("ls -la");
    expect(condenseHeredocs(j("cat <<'EOF'", "short", "EOF"), 80, (b) => b)).toBe(j("cat <<'EOF'", "short", "EOF"));
  });
});

describe("the shell's reserved words (0.6.1): `[` after `if` or `while` is the test command, not a path", () => {
  const words = (cmd: string) => readCommandLine(cmd).map((c) => c.words);
  const cmds = (cmd: string) => readCommandLine(cmd).map((c) => commandOf(c.words).cmd);

  it("if, then, elif, else, fi, while, until, do, done and `!` are dropped in front of a command; `[` and `[[` are the command", () => {
    expect(words("if [ -f x ]; then git push origin directory; fi")).toEqual([["[", "-f", "x", "]"], ["git", "push", "origin", "directory"], []]);
    expect(words('while [ -z "$id" ]; do sleep 1; done')).toEqual([["[", "-z", "$id", "]"], ["sleep", "1"], []]);
    expect(words("until [[ -f x ]]; do :; done")).toEqual([["[[", "-f", "x", "]]"], [":"], []]);
    expect(words("if ! grep -q x f; then echo no; elif test -d y; then echo y; else echo z; fi")).toEqual([["grep", "-q", "x", "f"], ["echo", "no"], ["test", "-d", "y"], ["echo", "y"], ["echo", "z"], []]);
    expect(words(j("if [ -f x ]", "then", "  git push origin directory", "fi"))).toEqual([["[", "-f", "x", "]"], [], ["git", "push", "origin", "directory"], []]);
    expect(words("{ cd /tmp && rm -rf y; }")).toEqual([["cd", "/tmp"], ["rm", "-rf", "y"], []]);
    expect(words("! [ -e x ] && touch x")).toEqual([["[", "-e", "x", "]"], ["touch", "x"]]);
    // A bare `[` or `[[` is never a wildcard the shell expands; `x[1].txt` and `[ab]*` are, a quoted `[q]` is not.
    expect(shellWords("[ -f x ]", { globs: true }).globs).toEqual([false, false, false, false]);
    expect(shellWords("ls x[1].txt [ab]* '[q]' [", { globs: true }).globs).toEqual([false, true, true, false, false]);
  });

  it("for, select, case and `in` start a segment that runs nothing; a function definition keeps the commands of its body", () => {
    expect(words('for f in *.md; do wc -l "$f"; done')).toEqual([[], ["wc", "-l", "$f"], []]);
    expect(cmds("case $x in a) echo a;; *) git push origin directory;; esac")).toEqual([null, "echo", "*", "git", null]);
    expect(words("select o in a b; do echo $o; done")).toEqual([[], ["echo", "$o"], []]);
    expect(words("function deploy { git push origin main; }")).toEqual([["git", "push", "origin", "main"], []]);
    expect(words("function deploy() { git push origin main; }")).toEqual([[], ["git", "push", "origin", "main"], []]);
    expect(words("deploy() { git push origin main; }")).toEqual([["deploy"], ["git", "push", "origin", "main"], []]);
    expect(stripKeywords(["if", "!", "[", "-f", "x", "]"], [false, false, false, false, false, false])).toEqual({ words: ["[", "-f", "x", "]"], along: [false, false, false, false], none: false });
    expect(stripKeywords(["for", "i", "in", "a"])).toEqual({ words: [], along: undefined, none: true });
    expect(stripKeywords(["fi"])).toEqual({ words: [], along: undefined, none: true });
    expect(stripKeywords(["ls", "if"])).toEqual({ words: ["ls", "if"], along: undefined, none: false });
  });

  it("a command a keyword starts is still read whole: `if bash -c`, `while sh <<EOF`", () => {
    expect(vias("if bash -c 'git push --force origin main'; then :; fi")).toEqual(["line:if bash -c 'git push --force origin main'", "shell:git push --force origin main", "line:then :", "line:fi"]);
    expect(vias(j("while sh <<'EOF'", "git push origin directory", "EOF", "do :; done"))).toEqual(["line:while sh <<'EOF'", "shell:git push origin directory", "line:do :", "line:done"]);
  });

  it("a glob becomes a regular expression that never throws: balanced brackets are a class, anything else is itself", () => {
    const m = (glob: string, name: string) => shellGlobRegExp(glob)!.test(name);
    expect(m("*.md", "a.md")).toBe(true);
    expect(m("a?.txt", "ab.txt")).toBe(true);
    expect(m("[ab]*.ts", "b1.ts")).toBe(true);
    expect(m("[!ab]*.ts", "a1.ts")).toBe(false);
    expect(m("[a-c]x", "bx")).toBe(true);
    expect(m("[]]", "]")).toBe(true);
    expect(m("[", "[")).toBe(true);
    expect(m("[[", "[[")).toBe(true);
    expect(m("a[", "a[")).toBe(true);
    expect(m("[a-", "[a-")).toBe(true);
    expect(m("x]", "x]")).toBe(true);
    expect(m("(a)+.txt", "(a)+.txt")).toBe(true);
    expect(m("a\\b", "a\\b")).toBe(true);
    expect(m("$HOME{1}", "$HOME{1}")).toBe(true);
    expect(m("[*]", "*")).toBe(true);
    expect(m("[*]", "a")).toBe(false);
    // No dotfiles unless the pattern starts with a dot.
    expect(shellGlobRegExp("*", { dotfiles: false })!.test(".env")).toBe(false);
    expect(shellGlobRegExp(".*", { dotfiles: false })!.test(".env")).toBe(true);
    for (const p of ["[", "[[", "[!", "[^", "[]", "[]]", "[!]", "[a-", "]", "[[:alpha:]]", "\\", "\\[", "(", ")", "{", "}", "|", "+", "?", "*", "^", "$", ".", "a{1,2}", "**", "[*]", "[?]", "[\\]", "[a-z", "-", "[-]", "[--]", "[z-a]", "(?<", "\\p{L}"]) expect(() => shellGlobRegExp(p), p).not.toThrow();
  });
});
