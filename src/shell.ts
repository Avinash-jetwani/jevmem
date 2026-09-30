/**
 * A shell command line as the guard reads it (v0.6, the guard fixes from the trial): its simple commands, each with
 * its words, its redirections and its here inputs. The prefilter (src/prefilter.ts), the tamper check
 * (src/guardrail.ts) and the git expansion (src/gitstage.ts) all read a command line through `readCommandLine`.
 *
 * - A heredoc (`<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`) or a here-string (`<<<`) is the input of the command that owns
 *   it, never commands of its own. The body runs as commands only when it is fed to a shell (`bash`, `sh`, `zsh`,
 *   `dash`, `ksh`, with or without `-s`, or piped into one). In an unquoted heredoc, `$( … )` and backticks in the body
 *   still run, so those are read as commands.
 * - `cat > f <<EOF`, `tee f <<EOF`, `cat <<EOF | tee f`, and `echo …`/`printf …` redirected to a file write that file:
 *   the command records `writes` (the file and the content), and the prefilter checks it like a Write of that file.
 * - `bash -c '…'`, `sh -c`, `zsh -c`, `dash -c`, `ksh -c` and `eval '…'` are read as commands.
 * - A file the same command line writes and then runs (`cat > x.sh <<EOF … EOF && bash x.sh`, `sh x.sh`, `./x.sh`,
 *   `source x.sh`, `. x.sh`, `bash < x.sh`) counts as run: its content is read as commands, so a script cannot be
 *   smuggled past the guard through a heredoc.
 * - `$( … )` and backticks are read as commands of their own, as before.
 */

/** A heredoc or here-string fed to a command. */
export interface HereInput {
  op: "<<" | "<<<";
  body: string;
  /** A quoted delimiter (`<<'EOF'`): no expansion, so nothing in the body runs. Here-strings count as quoted. */
  quoted: boolean;
}

/** A file a command writes with content the guard can see. */
export interface WrittenFile {
  /** The target as written (quotes removed), not resolved. */
  file: string;
  content: string;
  append: boolean;
}

/** How a simple command reaches the guard. */
export type Via = "line" | "substitution" | "shell" | "eval" | "script";

/** One simple command of a command line. */
export interface SimpleCommand {
  /** The command as written, heredoc bodies left out (a substitution outside quotes is replaced by a space). */
  text: string;
  /** Its words, quotes removed; `sudo`, `env` and `VAR=value` are kept (`commandOf` skips them). */
  words: string[];
  /** Per word: does it hold a wildcard outside quotes (one the shell expands)? */
  globs: boolean[];
  /** Redirection targets, the operator each came with, and every redirection operator seen (see `shellWords`). */
  redirects: string[];
  redirectOps: string[];
  ops: string[];
  /** Heredocs and here-strings fed to this command, in order. */
  input: HereInput[];
  /** The separator before it: `;`, `&&`, `||`, `|`, `&`, a newline, `(`, or "" for the first of its scope. */
  sep: string;
  via: Via;
  /** Commands parsed from the same string share a scope; a subshell `( … )` opens one too. Directory changes stay inside it. */
  scope: number;
  /** The scope this one was parsed inside, or null for the command line itself. */
  parentScope: number | null;
  /** Files this command writes with content the guard can see. */
  writes: WrittenFile[];
  /** Its standard input when the guard can see it: its last here input's body, or what `cat <<EOF |`, `echo` or `printf` pipe into it. */
  stdin: string | null;
  /** The folder it runs in, once `withDirs` has followed `cd`, `pushd` and `popd`; null when the guard cannot tell. */
  cwd?: string | null;
}

/** Shells that read a script from a file, from stdin, or from `-c`. */
export const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "ash"]);

/** Words in front of a command that only change how it runs. */
export const PREFIX = new Set(["sudo", "env", "time", "nohup", "nice", "exec", "command", "builtin", "caffeinate", "stdbuf", "timeout", "xargs"]);

// ---------------------------------------------------------------------------------------------
// Words of one simple command

export interface ShellWordsResult {
  words: string[];
  redirects: string[];
  redirectOps: string[];
  ops: string[];
  globs?: boolean[];
  /** The bodies of `<<<` here-strings, in order. */
  hereStrings: string[];
}

/**
 * The words of one simple command, quotes removed; redirection targets and operators are listed apart. The operators
 * that write their target: `>`, `>>`, `>|` (past noclobber), `&>` and `&>>` (stdout and stderr), and `>&` before a word
 * that is not a descriptor number or `-` (as `&>`); `2>&1`, `>&2` and `2>&-` copy or close a descriptor and have no
 * target. `<` and `<&` read. A heredoc's delimiter (`<<EOF`) is neither a word nor a file; a here-string's word (`<<<`)
 * is its body. With `globs`, also whether each word has a wildcard outside quotes (one the shell expands).
 */
export function shellWords(segment: string, opts: { globs?: boolean } = {}): ShellWordsResult {
  const out: string[] = [];
  const redirects: string[] = [];
  const redirectOps: string[] = [];
  const hereStrings: string[] = [];
  let pendingOp = "";
  const ops: string[] = [];
  const globs: boolean[] = [];
  let cur = "";
  let started = false;
  let wild = false;
  let quote: "'" | '"' | null = null;
  // After `>`, `>>` or `<` the next word is a file; after `<<` it is a heredoc delimiter; after `<<<` a here-string.
  let next: "redirect" | "skip" | "here" | null = null;
  const push = () => {
    if (started) {
      if (next === "redirect") {
        redirects.push(cur);
        redirectOps.push(pendingOp);
      } else if (next === "here") hereStrings.push(cur);
      else if (next !== "skip") {
        out.push(cur);
        globs.push(wild);
      }
      next = null;
    }
    cur = "";
    started = false;
    wild = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    // A substitution is one piece of the word, quotes and heredocs inside it included: `-m "$(cat <<'EOF' … EOF)"`.
    if (quote !== "'" && ((c === "$" && segment[i + 1] === "(") || c === "`")) {
      const inner = tokenize(segment, c === "`" ? i + 1 : i + 2, c === "`" ? "`" : ")");
      cur += segment.slice(i, inner.end + 1);
      started = true;
      i = inner.end;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < segment.length) {
        // Inside double quotes a backslash quotes only $, `, ", \ and a newline; before anything else it stays.
        const n = segment[i + 1]!;
        if (n === "\n") i++;
        else if ("$`\"\\".includes(n)) cur += segment[++i];
        else cur += c;
      } else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\" && i + 1 < segment.length) {
      // A backslash before a newline continues the line; before anything else it quotes that character.
      if (segment[i + 1] === "\n") {
        i++;
        continue;
      }
      cur += segment[++i];
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    // `&>` and `&>>` send stdout and stderr to their target: the `&` opens the operator, it is not a word.
    const both = c === "&" && segment[i + 1] === ">";
    if (c === ">" || c === "<" || both) {
      if (both) {
        push();
        i++;
      } else if (/^\d*$/.test(cur)) {
        // A descriptor number before the operator (`2>`), not a word.
        cur = "";
        started = false;
      } else push();
      const first = segment[i]!;
      let op = both ? "&>" : first;
      while (segment[i + 1] === ">" || segment[i + 1] === "<") op += segment[++i];
      if (segment[i + 1] === "-" && op === "<<") i++; // <<-EOF
      if (segment[i + 1] === "|" && op === ">") op += segment[++i]; // >|
      if (segment[i + 1] === "&" && !both && (op === ">" || op === "<")) {
        // `2>&1`, `>&2`, `2>&-` and `<&0` copy or close a descriptor; `>& file` writes the file, as `&>` does.
        i++;
        const rest = segment.slice(i + 1);
        const fd = /^\s*(?:\d+|-)(?=$|[\s;&|<>)])/.exec(rest);
        if (fd) {
          i += fd[0].length;
          continue;
        }
        op += "&";
      }
      ops.push(op);
      pendingOp = op;
      next = op === "<<<" ? "here" : op.startsWith("<<") ? "skip" : "redirect";
      continue;
    }
    if (c === "*" || c === "?" || c === "[") wild = true;
    cur += c;
    started = true;
  }
  push();
  return { words: out, redirects, redirectOps, ops, hereStrings, ...(opts.globs ? { globs } : {}) };
}

/**
 * The command word of a simple command and its subcommand (skipping `sudo`, `env`, `VAR=value` and git's `-C dir`),
 * with the word as written (`raw`: `./x.sh`, `/usr/bin/git`) and the index it has among `words`.
 */
export function commandOf(words: string[]): { cmd: string | null; sub: string | null; args: string[]; raw: string | null; at: number } {
  let i = 0;
  while (i < words.length && (PREFIX.has(words[i]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || (words[i - 1] === "timeout" && /^\d/.test(words[i]!)))) i++;
  const raw = words[i];
  if (!raw) return { cmd: null, sub: null, args: [], raw: null, at: -1 };
  const cmd = (raw.split("/").pop() ?? raw).toLowerCase();
  let j = i + 1;
  if (cmd === "git") while (words[j] === "-C" || words[j] === "-c" || words[j] === "--git-dir" || words[j] === "--work-tree") j += 2;
  if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn") while (words[j]?.startsWith("-")) j += words[j] === "--prefix" || words[j] === "-C" || words[j] === "--dir" || words[j] === "--filter" ? 2 : 1;
  const next = words[j];
  const sub = PAIRED.has(cmd) && next && /^[a-z][a-z0-9:-]*$/i.test(next) ? next.toLowerCase() : null;
  return { cmd, sub, args: words.slice(i + 1), raw, at: i };
}

/** Git and package-manager tools whose next word makes a `command subcommand` pair. */
export const PAIRED = new Set(["git", "gh", "npm", "pnpm", "yarn", "bun", "docker", "podman", "kubectl", "helm", "terraform", "tofu", "cargo", "go", "pip", "pip3", "poetry", "uv", "aws", "gcloud", "az", "heroku", "vercel", "flyctl", "fly", "wrangler", "firebase", "supabase", "prisma", "rails", "rake", "bundle", "composer", "dotnet", "mvn", "gradle", "make", "brew", "apt", "apt-get", "systemctl", "npx", "pnpx", "bunx"]);

// ---------------------------------------------------------------------------------------------
// The tokenizer: segments, substitutions and heredoc bodies

interface Pending {
  delimiter: string;
  quoted: boolean;
  strip: boolean;
  seg: Seg;
}

interface Seg {
  text: string;
  sep: string;
  depth: number;
  /** The text inside `$( … )` and backticks, in order. */
  nested: string[];
  /** Heredoc bodies, in order, with where each body sits in the source. */
  bodies: { body: string; quoted: boolean; start: number; end: number }[];
}

/** Where heredoc bodies sit in a command line, so the text sent to Jev can shorten them. */
export interface BodyRange {
  start: number;
  end: number;
  body: string;
  /** The delimiter line was found (the range ends after it); otherwise the body runs to the end of the source. */
  delimited: boolean;
}

interface Tokenized {
  segments: Seg[];
  /** The index where the scan stopped: the matching `)` or backtick, or the end. */
  end: number;
  bodies: BodyRange[];
}

/**
 * Split `src` from `pos` into segments on `&&`, `||`, `;`, `|`, `&`, newlines and parentheses. Quotes are respected;
 * heredoc bodies are read at the newline that ends their line and attached to the segment that owns them; the inside
 * of `$( … )` and backticks is kept for a scan of its own. With `stop`, the scan ends at the unmatched `)` or the
 * closing backtick.
 */
function tokenize(src: string, pos: number, stop: ")" | "`" | null): Tokenized {
  const segments: Seg[] = [];
  const bodies: BodyRange[] = [];
  let cur = "";
  let sep = "";
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let seg: Seg = { text: "", sep, depth, nested: [], bodies: [] };
  const pending: Pending[] = [];
  const push = (nextSep: string) => {
    if (cur.trim()) {
      seg.text = cur.trim();
      seg.sep = sep;
      seg.depth = depth;
      segments.push(seg);
    } else if (seg.nested.length || seg.bodies.length) {
      // A segment with no words of its own (a bare `$(…)`): keep what it carries.
      seg.text = cur.trim();
      seg.sep = sep;
      seg.depth = depth;
      segments.push(seg);
    }
    seg = { text: "", sep: nextSep, depth, nested: [], bodies: [] };
    sep = nextSep;
    cur = "";
  };
  /** Read the bodies of the heredocs opened on the line that just ended; `i` is the index after the newline. */
  const readBodies = (i: number): number => {
    let p = i;
    for (const h of pending) {
      const start = p;
      let body = "";
      let found = false;
      while (p < src.length) {
        let nl = src.indexOf("\n", p);
        if (nl < 0) nl = src.length;
        const rawLine = src.slice(p, nl);
        const line = h.strip ? rawLine.replace(/^\t+/, "") : rawLine;
        if (line === h.delimiter) {
          found = true;
          p = nl < src.length ? nl + 1 : nl;
          break;
        }
        body += line + "\n";
        p = nl < src.length ? nl + 1 : nl;
      }
      body = body.replace(/\n$/, "");
      const end = found ? p : src.length;
      h.seg.bodies.push({ body, quoted: h.quoted, start, end });
      bodies.push({ start, end, body, delimited: found });
    }
    pending.length = 0;
    return p;
  };
  let i = pos;
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < src.length) {
        cur += c + src[++i];
        continue;
      }
      if (c === quote) quote = null;
      // Command substitution runs inside double quotes too.
      if (quote === '"' && c === "$" && src[i + 1] === "(") {
        const inner = tokenize(src, i + 2, ")");
        seg.nested.push(src.slice(i + 2, inner.end));
        bodies.push(...inner.bodies);
        cur += src.slice(i, inner.end + 1);
        i = inner.end;
        continue;
      }
      if (quote === '"' && c === "`") {
        const inner = tokenize(src, i + 1, "`");
        seg.nested.push(src.slice(i + 1, inner.end));
        bodies.push(...inner.bodies);
        cur += src.slice(i, inner.end + 1);
        i = inner.end;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < src.length) {
      if (src[i + 1] === "\n") {
        // A continued line: the newline is not a separator and opens no heredoc body.
        cur += " ";
        i++;
        continue;
      }
      cur += c + src[++i];
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (stop === ")" && c === ")" && depth === 0) break;
    if (stop === "`" && c === "`") break;
    if (c === "$" && src[i + 1] === "(") {
      const inner = tokenize(src, i + 2, ")");
      seg.nested.push(src.slice(i + 2, inner.end));
      bodies.push(...inner.bodies);
      cur += " ";
      i = inner.end;
      continue;
    }
    if (c === "`") {
      const inner = tokenize(src, i + 1, "`");
      seg.nested.push(src.slice(i + 1, inner.end));
      bodies.push(...inner.bodies);
      cur += " ";
      i = inner.end;
      continue;
    }
    if (c === "#" && (cur === "" || /\s$/.test(cur))) {
      // A comment runs to the end of the line (the newline itself is handled below).
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl - 1;
      continue;
    }
    if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      // A heredoc: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`, `<< EOF`. The operator and delimiter stay in the text.
      let j = i + 2;
      let strip = false;
      if (src[j] === "-") {
        strip = true;
        j++;
      }
      while (src[j] === " " || src[j] === "\t") j++;
      let delimiter = "";
      let quoted = false;
      let k = j;
      for (; k < src.length; k++) {
        const d = src[k]!;
        if (d === "'" || d === '"') {
          const close = src.indexOf(d, k + 1);
          if (close < 0) break;
          delimiter += src.slice(k + 1, close);
          quoted = true;
          k = close;
          continue;
        }
        if (d === "\\" && k + 1 < src.length) {
          delimiter += src[++k];
          quoted = true;
          continue;
        }
        if (/[\s;|&<>()]/.test(d)) break;
        delimiter += d;
      }
      if (delimiter) pending.push({ delimiter, quoted, strip, seg });
      cur += src.slice(i, k);
      i = k - 1;
      continue;
    }
    if (c === "&" && (src[i - 1] === ">" || src[i - 1] === "<" || src[i + 1] === ">")) {
      cur += c; // 2>&1, <&0, &>file
      continue;
    }
    if (c === "|" && src[i - 1] === ">") {
      cur += c; // >|file writes the file even with noclobber set; it is not a pipe
      continue;
    }
    if (c === "\n") {
      push("\n");
      if (pending.length) i = readBodies(i + 1) - 1;
      continue;
    }
    if (c === ";" || c === "|" || c === "&") {
      let s = c;
      if ((c === "|" || c === "&") && src[i + 1] === c) {
        s = c + c;
        i++;
      }
      push(s);
      continue;
    }
    if (c === "(") {
      push("(");
      depth++;
      continue;
    }
    if (c === ")") {
      push(")");
      depth = Math.max(0, depth - 1);
      continue;
    }
    cur += c;
  }
  push("");
  return { segments, end: i, bodies };
}

// ---------------------------------------------------------------------------------------------
// Reading a command line

let scopeCounter = 0;

/** Does a shell command read its script from stdin: no file argument, or `-s`, or `-`? Returns the file it runs otherwise. */
function shellScript(args: string[]): { stdin: boolean; file: string | null; cString: string | null } {
  let stdin = true;
  let file: string | null = null;
  let cString: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      const f = args[i + 1];
      if (f && f !== "-") {
        file = f;
        stdin = false;
      }
      break;
    }
    if (a === "-s") continue;
    if (a === "-") break;
    if (a.startsWith("-")) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a) || a === "--command") {
        cString = args[i + 1] ?? "";
        stdin = false;
        break;
      }
      if (a === "-o" || a === "--rcfile" || a === "--init-file") i++;
      continue;
    }
    file = a;
    stdin = false;
    break;
  }
  return { stdin, file, cString };
}

/** `printf`'s and `echo -e`'s escapes, so a written line reads as the shell would run it. */
function unescape(text: string): string {
  return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

const writesTarget = (op: string) => op.includes(">") && !op.startsWith("<");
const appends = (op: string) => op === ">>" || op === "&>>";

/** A written file's key: the target as written, quotes removed, without a leading `./`. */
export function writtenKey(file: string): string {
  let s = file.replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

/**
 * Read a command line into its simple commands, in order, with the commands that run inside it (substitutions,
 * shell strings, heredocs fed to a shell, `eval`, and scripts written and then run) following the command they
 * belong to.
 */
export function readCommandLine(cmd: string): SimpleCommand[] {
  scopeCounter = 0;
  const out: SimpleCommand[] = [];
  read(cmd, "line", null, out, new Map(), 0);
  return out;
}

function read(src: string, via: Via, parentScope: number | null, out: SimpleCommand[], written: Map<string, string>, depthLimit: number): void {
  if (depthLimit > 6 || src.length > 200_000) return;
  const scope = scopeCounter++;
  const { segments } = tokenize(src, 0, null);
  let piped: string | null = null;
  const subshellScopes: number[] = [];
  let lastDepth = 0;
  for (const seg of segments) {
    // A `( … )` subshell opens a scope of its own.
    while (seg.depth > lastDepth) {
      subshellScopes.push(scopeCounter++);
      lastDepth++;
    }
    while (seg.depth < lastDepth) {
      subshellScopes.pop();
      lastDepth--;
    }
    const own = subshellScopes.length ? subshellScopes[subshellScopes.length - 1]! : scope;
    const w = shellWords(seg.text, { globs: true });
    const input: HereInput[] = [...seg.bodies.map((b) => ({ op: "<<" as const, body: b.body, quoted: b.quoted })), ...w.hereStrings.map((body) => ({ op: "<<<" as const, body, quoted: true }))];
    const stdin: string | null = input.length ? input[input.length - 1]!.body : seg.sep === "|" ? piped : null;
    const sc: SimpleCommand = { text: seg.text, words: w.words, globs: w.globs ?? [], redirects: w.redirects, redirectOps: w.redirectOps, ops: w.ops, input, sep: seg.sep, via, scope: own, parentScope: subshellScopes.length ? scope : parentScope, writes: [], stdin };
    out.push(sc);
    const { cmd, args, raw } = commandOf(w.words);
    const outputs = w.redirects.filter((_, k) => writesTarget(w.redirectOps[k] ?? ">")).map((f, k) => ({ file: f, append: appends(w.redirectOps[k] ?? ">") }));
    // Substitutions run first, as the shell runs them before the command.
    for (const n of seg.nested) read(n, "substitution", own, out, written, depthLimit + 1);
    // In an unquoted heredoc, `$( … )` and backticks in the body run.
    for (const b of seg.bodies) if (!b.quoted) for (const n of substitutionsIn(b.body)) read(n, "substitution", own, out, written, depthLimit + 1);
    let nextPiped: string | null = null;
    if (cmd === "cat" || cmd === "tee") {
      const content: string | null = stdin;
      if (content !== null) {
        const targets = cmd === "tee" ? args.filter((a) => !a.startsWith("-")).map((file) => ({ file, append: args.includes("-a") || args.includes("--append") })) : [];
        for (const t of [...outputs, ...targets]) {
          sc.writes.push({ file: t.file, content, append: t.append });
          written.set(writtenKey(t.file), (t.append ? (written.get(writtenKey(t.file)) ?? "") + "\n" : "") + content);
        }
        // `cat <<EOF | bash`, `cat <<EOF | tee f`: the body goes on down the pipe.
        if (cmd === "tee" || !outputs.length) nextPiped = content;
      }
    } else if (cmd === "echo" || cmd === "printf") {
      const text = args.filter((a, k) => !(k === 0 && /^-[neE]+$/.test(a))).join(" ");
      const content = cmd === "printf" || args[0] === "-e" ? unescape(text) : text;
      for (const t of outputs) {
        sc.writes.push({ file: t.file, content, append: t.append });
        written.set(writtenKey(t.file), (t.append ? (written.get(writtenKey(t.file)) ?? "") + "\n" : "") + content);
      }
      if (!outputs.length) nextPiped = content;
    } else if (cmd && SHELLS.has(cmd)) {
      const s = shellScript(args);
      if (s.cString !== null) read(s.cString, "shell", own, out, written, depthLimit + 1);
      else if (s.file !== null) {
        const content = written.get(writtenKey(s.file));
        if (content !== undefined) read(content, "script", own, out, written, depthLimit + 1);
      } else if (s.stdin) {
        // `bash <<EOF`, `cat <<EOF | sh`: the body is the script; `bash < x.sh`: a file written earlier is.
        const fromFile = w.redirects.find((_, k) => w.redirectOps[k] === "<");
        const fromWritten = fromFile !== undefined ? (written.get(writtenKey(fromFile)) ?? null) : null;
        if (stdin !== null) read(stdin, "shell", own, out, written, depthLimit + 1);
        else if (fromWritten !== null) read(fromWritten, "script", own, out, written, depthLimit + 1);
      }
    } else if (cmd === "eval") {
      read(args.join(" "), "eval", own, out, written, depthLimit + 1);
    } else if (cmd === "source" || cmd === ".") {
      const file = args.find((a) => !a.startsWith("-"));
      const content = file !== undefined ? written.get(writtenKey(file)) : undefined;
      if (content !== undefined) read(content, "script", own, out, written, depthLimit + 1);
    } else if (raw !== null && (raw.includes("/") || written.has(writtenKey(raw)))) {
      // `./x.sh`, `/tmp/x.sh` or `$S/x.sh`: a script written earlier on this command line, run directly.
      const content = written.get(writtenKey(raw));
      if (content !== undefined) read(content, "script", own, out, written, depthLimit + 1);
    }
    piped = nextPiped;
  }
}

/** The insides of `$( … )` and backticks in a text (an unquoted heredoc body), in order. */
export function substitutionsIn(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "$" && text[i + 1] === "(") {
      const inner = tokenize(text, i + 2, ")");
      out.push(text.slice(i + 2, inner.end));
      i = inner.end;
    } else if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      const stop = end < 0 ? text.length : end;
      out.push(text.slice(i + 1, stop));
      i = stop;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Following the current directory

/** `~`, `$HOME`, `${HOME}`, `$PWD`, `${PWD}` and `$CLAUDE_PROJECT_DIR` in a path; null when it holds anything else the shell would expand. */
export function expandPath(arg: string, cwd: string | null, home: string | undefined, root: string | undefined): string | null {
  let s = arg;
  if (s === "~" || s.startsWith("~/")) {
    if (!home) return null;
    s = home + s.slice(1);
  } else if (s.startsWith("~")) return null;
  s = s.replace(/\$\{?HOME\}?(?=$|\/)/g, () => home ?? "\u0000").replace(/\$\{?PWD\}?(?=$|\/)/g, () => cwd ?? "\u0000").replace(/\$\{?CLAUDE_PROJECT_DIR\}?(?=$|\/)/g, () => root ?? "\u0000");
  if (s.includes("\u0000") || /[$`]/.test(s)) return null;
  return s;
}

/**
 * The folder each command runs in, following `cd`, `pushd` and `popd` inside each scope (a `bash -c` string, a
 * subshell, a script) without leaking into the one around it; `cd` to a folder the guard cannot tell (`cd "$DIR"`,
 * `cd -`) makes the rest of that scope unknown (null). Sets `cwd` on each command and returns them.
 */
export function withDirs(commands: SimpleCommand[], cwd: string, home?: string, root?: string, resolve: (base: string, p: string) => string = (b, p) => joinPath(b, p)): SimpleCommand[] {
  const dirs = new Map<number, string | null>();
  const stacks = new Map<number, (string | null)[]>();
  for (const c of commands) {
    if (!dirs.has(c.scope)) dirs.set(c.scope, c.parentScope !== null && dirs.has(c.parentScope) ? (dirs.get(c.parentScope) ?? null) : cwd);
    c.cwd = dirs.get(c.scope) ?? null;
    const { cmd, args } = commandOf(c.words);
    if (cmd === "cd" || cmd === "pushd") {
      const plain = args.filter((a) => a === "-" || !a.startsWith("-") || a === "--").filter((a) => a !== "--");
      const arg = plain[0];
      let next: string | null;
      if (c.cwd === null) next = null;
      else if (arg === undefined) next = home ?? null;
      else if (arg === "-" || /[*?[]/.test(arg)) next = null;
      else {
        const e = expandPath(arg, c.cwd, home, root);
        next = e === null ? null : e.startsWith("/") ? e : resolve(c.cwd, e);
      }
      if (cmd === "pushd") {
        const st = stacks.get(c.scope) ?? [];
        st.push(c.cwd);
        stacks.set(c.scope, st);
      }
      dirs.set(c.scope, next);
    } else if (cmd === "popd") {
      const st = stacks.get(c.scope) ?? [];
      dirs.set(c.scope, st.length ? (st.pop() ?? null) : null);
    }
  }
  return commands;
}

/** A relative path joined to a base, normalising `.` and `..` (forward slashes). */
export function joinPath(base: string, p: string): string {
  const parts: string[] = [];
  const all = `${base.replace(/\\/g, "/")}/${p.replace(/\\/g, "/")}`.split("/");
  const abs = all[0] === "";
  for (const part of all) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return (abs ? "/" : "") + parts.join("/");
}

// ---------------------------------------------------------------------------------------------
// What is sent

/**
 * The command line with each heredoc body cut to at most `max` characters around the first of `terms` (or its start),
 * so the shape of the call (`cat > x.py <<'EOF' … EOF && python3 x.py`) stays in view when the body is long.
 */
export function condenseHeredocs(cmd: string, max: number, snippet: (body: string) => string): string {
  const { bodies } = tokenize(cmd, 0, null);
  if (!bodies.length) return cmd;
  const sorted = [...bodies].sort((a, b) => a.start - b.start);
  let out = "";
  let last = 0;
  for (const b of sorted) {
    if (b.start < last) continue; // a body inside another (a substitution's heredoc): the outer cut covers it
    out += cmd.slice(last, b.start);
    const body = cmd.slice(b.start, b.end);
    // The body's own text ends before the delimiter line; keep the delimiter line as written.
    const text = b.delimited ? body.replace(/\n[^\n]*\n?$/, "") : body;
    const tail = body.slice(text.length);
    out += text.length > max ? snippet(text) + tail : body;
    last = b.end;
  }
  return out + cmd.slice(last);
}
