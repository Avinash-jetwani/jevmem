/**
 * The guard's local prefilter: which saved rules could a tool call be about? No network, no Jev, no file access.
 *
 * Rules and calls are reduced to the same four kinds of feature:
 * - paths and globs (`db/migrations/`, `*.pem`), matched against the paths a call touches;
 * - filenames (`.env`, `package-lock.json`, `Dockerfile`), matched against a path's last segment;
 * - command words (`npm`, `git push`), matched against each simple command of a shell command line;
 * - keywords (stemmed words that are not stop words), matched against the words of the call.
 * A rule that shares a feature with the call is a candidate; the strongest few go to Jev, which decides. A call that
 * shares nothing with any rule never leaves the machine.
 *
 * The prefilter sees only the call itself: `git add .` in a folder with an untracked `.env` shares nothing with
 * "Never commit .env files", so it is not caught (docs/guardrails.md).
 */

export type GuardTool = "Bash" | "Edit" | "Write";

/** A tool call as the guard sees it (from the PreToolUse payload). */
export interface GuardAction {
  tool: GuardTool;
  /** Bash: the command line. */
  command?: string;
  /** Edit and Write: the path, relative to the project root when it is inside it. */
  file?: string;
  /** Edit: the text being replaced. */
  removed?: string;
  /** Edit: the replacement. Write: the new file content. */
  added?: string;
}

export interface Features {
  /** Paths, directories and globs (rules), or every path the call touches (calls), normalised to forward slashes. */
  paths: string[];
  /** Filenames: `.env`, `package-lock.json`, `Dockerfile` (rules), or each touched path's last segment (calls). */
  files: string[];
  /** Command words and `command subcommand` pairs: `git`, `git push`, `npm`, `npm publish`. */
  commands: string[];
  /** Stemmed keywords. */
  keywords: string[];
}

export interface IndexedRule {
  id: string;
  text: string;
  /** Hash of the rule's text (provenance.lineSha), so an edited rule is not served an old cached answer. */
  sha: string;
  features: Features;
}

export interface Candidate {
  rule: IndexedRule;
  score: number;
  /** Why the rule matched, for `jevmem guard test` and the log: `file .env`, `command git push`, `keyword commit`. */
  reasons: string[];
  /** The words and paths the rule shares with the call (used to centre the content snippet sent to Jev). */
  terms: string[];
}

export interface MatchOptions {
  /** At most this many candidates, strongest first. */
  max: number;
  /** A rule is a candidate at or above this score (see WEIGHTS). */
  minScore: number;
}

/**
 * How much each kind of shared feature counts: a path or filename, or a `command subcommand` pair, is strong; a
 * single command word is medium (weak for git and the like, which almost every session runs); a broad directory such
 * as `src/` and each shared keyword are weak. A rule needs `minScore` to be a candidate, so one shared keyword alone
 * is not enough. Tuned on eval/guard-dev.jsonl only (results/README.md).
 */
export const WEIGHTS = { path: 3, broadPath: 1, file: 3, pair: 3, command: 2, commonCommand: 1, keyword: 1, keywordCap: 3 } as const;

export const DEFAULT_MATCH: MatchOptions = { max: 3, minScore: 2 };

// ---------------------------------------------------------------------------------------------
// Words

/**
 * Words that say nothing about what a rule or a call is about: English function words, the words rules are phrased
 * with (never, always, must), generic nouns and verbs, and shell and path noise.
 */
const STOP = new Set(
  `a an the and or nor but if then else so to of in on at by for from with without into onto via per as than too very
is are be been being was were am it its it's this that these those there here where when while which who whom whose
what why how we our ours us you your yours they their them i me my mine he she his her any all each every some none
no not never always must mustn should shouldn shall can cannot can't don't dont do does did done doing doesn didn only
just also still even ever instead before after during until unless because since though although whether either
neither both such same other others own more most less least much many few lot lots use used uses using make makes
made making keep keeps kept need needs needed want wants get gets got put puts let lets thing things way ways sure
please ok okay yes good bad new old first last next one two three rule rules file files code project projects repo
repository change changes changed work works working everything anything something nothing time times via etc e.g
i.e like run runs ran instead directly stay stays out away through across around over above below between within
upon about along behind beyond toward towards
echo cd true false dev null tmp usr bin var opt home lib local private sbin sudo env`.split(/\s+/),
);

/** A light suffix stripper, the same on both sides: "commits", "committing" and "committed" all become "commit". */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (w.length <= 3 || /^\d+$/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) w = w.slice(0, -1);
  if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("ation") && w.length > 7) w = w.slice(0, -5);
  else if (w.endsWith("ion") && w.length > 6) w = w.slice(0, -3);
  else if (w.endsWith("er") && w.length > 5) w = w.slice(0, -2);
  if (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w)) w = w.slice(0, -1);
  if (w.endsWith("e") && w.length > 4) w = w.slice(0, -1);
  return w;
}

/** Split text into words: camelCase and snake_case identifiers become separate words, as do path segments. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9']+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length > 0);
}

/** The stemmed keywords of a text, without stop words, numbers or one- and two-letter words. */
export function keywords(text: string): string[] {
  const out = new Set<string>();
  for (const w of words(text)) {
    const lower = w.toLowerCase();
    if (lower.length < 3 || STOP.has(lower) || /^\d+$/.test(lower)) continue;
    const s = stem(lower);
    if (s.length >= 3 && !STOP.has(s)) out.add(s);
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------
// Command words

/** Command-line tools a rule can name. A rule word in this list is a command-word feature. */
export const TOOLS = new Set(
  `git gh npm npx pnpm yarn bun deno node python python3 pip pip3 poetry uv pipenv conda cargo rustc go gofmt java mvn
gradle dotnet ruby gem bundle rails rake php composer docker podman kubectl helm terraform tofu pulumi ansible vagrant
aws gcloud az heroku vercel netlify flyctl fly wrangler firebase supabase prisma sequelize knex alembic flyway liquibase
psql mysql mongo mongosh redis-cli sqlite3 rm rmdir mv cp chmod chown ln dd mkfs truncate shred kill pkill killall
shutdown reboot systemctl service crontab curl wget ssh scp rsync sftp nc tar zip unzip sed awk perl tee make cmake
brew apt apt-get yum dnf apk jest vitest mocha pytest playwright cypress eslint prettier tsc webpack vite next nuxt
turbo nx lerna changeset semantic-release black ruff isort flake8 pylint mypy autopep8 yapf gofmt goimports
golangci-lint rubocop biome oxlint stylelint fastlane pod`.split(/\s+/),
);

/**
 * Tool names that are also everyday words ("applies go through CI", "Format Python with ruff"): in a rule's plain
 * text they count only as part of a `command subcommand` pair; inside backticks they count on their own.
 */
const AMBIGUOUS_TOOLS = new Set(["go", "make", "node", "python", "python3", "bundle", "service", "next", "fly", "gem", "kill", "apt", "bun", "zip", "turbo", "tee", "java", "ruby", "php"]);

/** Tools nearly every session runs: a rule naming only the tool itself is a weak match for them. */
const COMMON_TOOLS = new Set(["git", "gh", "node", "python", "python3", "bash", "sh"]);

/** Git and package-manager subcommands that make a `command subcommand` pair. */
const PAIRED = new Set(["git", "gh", "npm", "pnpm", "yarn", "bun", "docker", "podman", "kubectl", "helm", "terraform", "tofu", "cargo", "go", "pip", "pip3", "poetry", "uv", "aws", "gcloud", "az", "heroku", "vercel", "flyctl", "fly", "wrangler", "firebase", "supabase", "prisma", "rails", "rake", "bundle", "composer", "dotnet", "mvn", "gradle", "make", "brew", "apt", "apt-get", "systemctl", "npx", "pnpx", "bunx"]);

/**
 * Subcommands that make a pair when a rule names a tool in plain text ("never git push", "no kubectl delete"): "git
 * history" or "go through" is not a command. Tools not listed here (make, rake, cloud CLIs) take any word; inside
 * backticks any word counts.
 */
const SUBCOMMANDS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries({
    git: "add commit push pull fetch merge rebase reset checkout switch restore branch tag stash cherry-pick revert clean rm mv clone config am apply bisect submodule worktree gc filter-branch filter-repo log diff status show blame",
    gh: "pr repo release issue workflow run api auth gist secret",
    npm: "install i add remove rm uninstall publish unpublish run exec update upgrade audit ci link pack version init test start build deploy deprecate dist-tag",
    docker: "run build push pull exec rm rmi compose system volume network login tag prune",
    kubectl: "apply delete create edit patch scale rollout exec drain cordon uncordon port-forward replace set label annotate taint get describe logs",
    helm: "install upgrade uninstall delete rollback template lint package push repo dependency",
    terraform: "apply destroy plan import init state taint untaint workspace fmt validate refresh",
    cargo: "publish build test run add install yank release update fmt clippy",
    go: "build test run mod get install vet generate fmt work clean tool",
    pip: "install uninstall download freeze",
  }).flatMap(([tool, subs]) => {
    const set = new Set(subs.split(" "));
    const same: Record<string, string[]> = { npm: ["pnpm", "yarn", "bun"], docker: ["podman"], terraform: ["tofu"], pip: ["pip3", "uv", "poetry"] };
    return [tool, ...(same[tool] ?? [])].map((t) => [t, set] as const);
  }),
);

/** Words in front of a command that only change how it runs. */
const PREFIX = new Set(["sudo", "env", "time", "nohup", "nice", "exec", "command", "builtin", "caffeinate", "stdbuf", "timeout", "xargs"]);

/** Short flags that say something a rule might be about. */
const FLAG_WORDS: Record<string, string[]> = { "-f": ["force"], "-rf": ["force", "recursive"], "-fr": ["force", "recursive"], "-r": ["recursive"], "-R": ["recursive"], "-D": ["delete", "force"], "-A": ["all"], "-a": ["all"] };

// ---------------------------------------------------------------------------------------------
// Paths

const KNOWN_FILES = new Set(["dockerfile", "makefile", "procfile", "gemfile", "jenkinsfile", "vagrantfile", "license", "licence", "codeowners", "id_rsa", "id_ed25519", "known_hosts", "authorized_keys", "brewfile", "rakefile", "justfile"]);
/** Directory names that are paths even without a slash. */
const KNOWN_DIRS = new Set(["node_modules", "__pycache__", ".venv", "venv", "vendor", "third_party"]);
/** Top-level directories so common that naming one says little: a match on one alone is weak. */
const BROAD_DIRS = new Set(["src", "lib", "app", "apps", "packages", "pkg", "internal", "cmd", "test", "tests", "spec", "specs", "docs", "doc", "scripts", "bin", "tools", "config", "configs", "public", "assets", "static", "web", "server", "client", "include", "examples", "e2e"]);
// Two or more characters: "e.g." and "v1.2" are not filenames.
const EXT = "(?:[a-z0-9]{2,8})";
const FILE_RE = new RegExp(`^[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*\\.${EXT}$`, "i");

/** Normalise a path-ish token: forward slashes, no leading `./`, no surrounding quotes or trailing punctuation. */
export function normPath(p: string): string {
  let s = p.trim().replace(/^[`'"(<[{]+|[`'")>\]},;:!?]+$/g, "").replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/([^:/])\/{2,}/g, "$1/"); // but not the // of a URL
  // A sentence full stop after a filename: ".env." → ".env", "package.json." → "package.json".
  if (/\.$/.test(s) && s.length > 1 && !/^\.+$/.test(s)) s = s.slice(0, -1);
  return s;
}

function isUrl(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(?:www\.|git@)/i.test(s);
}

/** Classify a token as a path, a glob, a filename, or nothing. */
export function pathKind(token: string): "glob" | "path" | "file" | null {
  const s = normPath(token);
  if (!s || s.length > 200 || isUrl(s) || /^\d+(?:\.\d+)*$/.test(s) || s === "." || s === ".." || s === "/") return null;
  if (/\s/.test(s)) return null;
  if (/[*?]/.test(s) && /[A-Za-z0-9./]/.test(s.replace(/[*?]/g, ""))) return "glob";
  if (s.includes("/")) return "path";
  if (KNOWN_DIRS.has(s.toLowerCase())) return "path";
  if (/^\.[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s)) return "file"; // dotfiles and dot-directories: .env, .github, .npmrc
  if (FILE_RE.test(s) && /[a-z]/.test(s.split(".").pop() ?? "")) return "file";
  if (KNOWN_FILES.has(s.toLowerCase())) return "file";
  return null;
}

/** `*.pem`, `db/**` and `src/*.test.ts` as regular expressions over a relative path. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  const g = normPath(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
        if (g[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // `*.pem` matches the last segment anywhere; `db/*.sql` matches that path from the root or under any directory.
  return new RegExp(`(?:^|/)${re}$`, "i");
}

// ---------------------------------------------------------------------------------------------
// Rules

/** A rule's clauses: split at ; and at the end of a sentence, at commas and at "but". */
function clauses(text: string): string[] {
  return text.split(/;|[.!?](?=\s|$)|,\s+|\s+but\s+/i).map((c) => c.trim()).filter(Boolean);
}
const NEGATION = /\b(?:never|not|no|nor|don'?t|do not|doesn'?t|mustn'?t|must not|shouldn'?t|should not|isn'?t|aren'?t|won'?t|can'?t|cannot|avoid|without)\b/i;

/**
 * Features of one saved rule. In a rule that both forbids and prefers ("Use pnpm; never run npm", "Format with ruff,
 * not black"), command words and keywords come only from the clauses that forbid: calls using the preferred tool are
 * not about the rule. Paths and filenames count from every clause ("Everything in docs/api/ is generated; never edit
 * it" is about docs/api/).
 */
export function ruleFeatures(text: string): Features {
  const paths = new Set<string>();
  const files = new Set<string>();
  const commands = new Set<string>();
  const pathWords = new Set<string>();
  const addPath = (tok: string) => {
    const kind = pathKind(tok);
    if (!kind) return false;
    const s = normPath(tok);
    if (kind === "file") files.add(s.toLowerCase());
    else paths.add(s.replace(/\/+$/, "/"));
    for (const w of words(s)) pathWords.add(w.toLowerCase());
    return true;
  };
  const parts = clauses(text);
  const forbidding = parts.filter((c) => NEGATION.test(c));
  const scoped = forbidding.length > 0 && forbidding.length < parts.length ? forbidding : parts;
  // Paths and filenames, from every clause (code spans included).
  for (const span of [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)) for (const x of shellWords(span).words) addPath(x);
  for (const tok of text.replace(/`[^`]*`/g, " ").split(/[\s,;()]+/)) addPath(tok);
  // Command words and keywords, from the clauses in scope.
  const kwText: string[] = [];
  for (const clause of scoped) {
    for (const span of [...clause.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)) {
      const w = shellWords(span).words;
      const cmd = w.find((x) => !/=/.test(x) && !PREFIX.has(x));
      if (cmd && (TOOLS.has(cmd.toLowerCase()) || w.length > 1) && !pathKind(cmd)) {
        commands.add(cmd.toLowerCase());
        const sub = w[w.indexOf(cmd) + 1];
        if (sub && PAIRED.has(cmd.toLowerCase()) && /^[a-z][a-z0-9:-]*$/i.test(sub)) commands.add(`${cmd.toLowerCase()} ${sub.toLowerCase()}`);
      }
      kwText.push(w.filter((x) => !pathKind(x)).join(" "));
    }
    const plainText = clause.replace(/`[^`]*`/g, " ");
    // Command words are read from the text around paths and filenames: "go.mod" is not `go mod`.
    const plain = words(plainText.split(/[\s,;()]+/).filter((t) => !pathKind(t)).join(" ")).map((w) => w.toLowerCase());
    for (const w of plain) if (TOOLS.has(w) && !AMBIGUOUS_TOOLS.has(w)) commands.add(w);
    // "git push" / "npm publish" written without backticks.
    for (let i = 0; i + 1 < plain.length; i++) {
      const [tool, sub] = [plain[i]!, plain[i + 1]!];
      if (!PAIRED.has(tool) || !TOOLS.has(tool) || !/^[a-z][a-z-]{1,}$/.test(sub) || STOP.has(sub)) continue;
      if (SUBCOMMANDS[tool] ? SUBCOMMANDS[tool]!.has(sub) : true) commands.add(`${tool} ${sub}`);
    }
    // "force-push", "force push" and "push --force" all name a forced git push.
    if (/\bforce[- ]?push/i.test(clause)) commands.add("git push");
    kwText.push(plainText.split(/[\s,;()]+/).filter((t) => !pathKind(t)).join(" "));
  }
  // A pair names the command more precisely than the tool alone: `kubectl delete` replaces `kubectl`.
  for (const c of [...commands]) if (c.includes(" ")) commands.delete(c.split(" ")[0]!);
  // Keywords: not the words of a path (the path itself is the feature) and not tool names (commands are).
  const kw = keywords(kwText.join(" ")).filter((k) => !TOOLS.has(k) && ![...pathWords].some((w) => stem(w) === k && !plainOutsidePaths(text, w)));
  return { paths: [...paths], files: [...files], commands: [...commands], keywords: kw };
}

/** Does `word` appear in `text` outside a path or filename token? */
function plainOutsidePaths(text: string, word: string): boolean {
  const lower = word.toLowerCase();
  return text
    .replace(/`[^`]*`/g, " ")
    .split(/[\s,;()]+/)
    .filter((t) => !pathKind(t))
    .some((t) => words(t).some((w) => stem(w.toLowerCase()) === stem(lower)));
}

// ---------------------------------------------------------------------------------------------
// Shell command lines

/**
 * Split a command line into its simple commands: on `&&`, `||`, `;`, `|`, `&`, newlines and parentheses, and with
 * the insides of `$( … )` and backticks as commands of their own. Quotes are respected.
 */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  const nested: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < cmd.length) {
        cur += c + cmd[++i];
        continue;
      }
      if (c === quote) quote = null;
      // Command substitution runs inside double quotes too.
      if (quote === '"' && c === "$" && cmd[i + 1] === "(") {
        const end = matchParen(cmd, i + 1);
        nested.push(cmd.slice(i + 2, end));
        cur += cmd.slice(i, end + 1);
        i = end;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) {
      cur += c + cmd[++i];
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "$" && cmd[i + 1] === "(") {
      const end = matchParen(cmd, i + 1);
      nested.push(cmd.slice(i + 2, end));
      cur += " ";
      i = end;
      continue;
    }
    if (c === "`") {
      const end = cmd.indexOf("`", i + 1);
      const stop = end < 0 ? cmd.length : end;
      nested.push(cmd.slice(i + 1, stop));
      cur += " ";
      i = stop;
      continue;
    }
    if (c === "#" && (cur === "" || /\s$/.test(cur))) {
      // A comment runs to the end of the line.
      const nl = cmd.indexOf("\n", i);
      i = nl < 0 ? cmd.length : nl - 1;
      continue;
    }
    if (c === "&" && (cmd[i - 1] === ">" || cmd[i + 1] === ">")) {
      cur += c; // 2>&1, &>file
      continue;
    }
    if (c === ";" || c === "\n" || c === "(" || c === ")" || c === "|" || c === "&") {
      push();
      if ((c === "|" || c === "&") && cmd[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  push();
  for (const n of nested) out.push(...splitCommand(n));
  return out;
}

function matchParen(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return s.length;
}

/** The words of one simple command, quotes removed; redirection targets and operators (`>`, `>>`, `<`) are listed apart. */
export function shellWords(segment: string): { words: string[]; redirects: string[]; ops: string[] } {
  const out: string[] = [];
  const redirects: string[] = [];
  const ops: string[] = [];
  let cur = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  // After `>`, `>>` or `<` the next word is a file; after `<<` or `<<<` it is a heredoc delimiter or a string.
  let next: "redirect" | "skip" | null = null;
  const push = () => {
    if (started) {
      if (next === "redirect") redirects.push(cur);
      else if (next !== "skip") out.push(cur);
      next = null;
    }
    cur = "";
    started = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < segment.length) cur += segment[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\" && i + 1 < segment.length) {
      cur += segment[++i];
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    if (c === ">" || c === "<") {
      // `2>&1` and `>&2` redirect to a descriptor, not a file.
      if (/^\d*$/.test(cur)) {
        cur = "";
        started = false;
      } else push();
      let op = c;
      while (segment[i + 1] === ">" || segment[i + 1] === "<") op += segment[++i];
      if (segment[i + 1] === "-" && op === "<<") i++; // <<-EOF
      if (segment[i + 1] === "&") {
        i++;
        while (/\d|-/.test(segment[i + 1] ?? "")) i++;
        continue;
      }
      ops.push(op);
      next = op.startsWith("<<") ? "skip" : "redirect";
      continue;
    }
    cur += c;
    started = true;
  }
  push();
  return { words: out, redirects, ops };
}

/** The command word of a simple command and its subcommand (skipping `sudo`, `env`, `VAR=value` and git's `-C dir`). */
export function commandOf(words: string[]): { cmd: string | null; sub: string | null; args: string[] } {
  let i = 0;
  while (i < words.length && (PREFIX.has(words[i]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || (words[i - 1] === "timeout" && /^\d/.test(words[i]!)))) i++;
  const raw = words[i];
  if (!raw) return { cmd: null, sub: null, args: [] };
  const cmd = (raw.split("/").pop() ?? raw).toLowerCase();
  let j = i + 1;
  if (cmd === "git") while (words[j] === "-C" || words[j] === "-c" || words[j] === "--git-dir" || words[j] === "--work-tree") j += 2;
  if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn") while (words[j]?.startsWith("-")) j += words[j] === "--prefix" || words[j] === "-C" || words[j] === "--dir" || words[j] === "--filter" ? 2 : 1;
  const next = words[j];
  const sub = PAIRED.has(cmd) && next && /^[a-z][a-z0-9:-]*$/i.test(next) ? next.toLowerCase() : null;
  return { cmd, sub, args: words.slice(i + 1) };
}

// ---------------------------------------------------------------------------------------------
// Calls

/** How much of an Edit or Write's content the prefilter reads. The snippet sent to Jev is much shorter (guardrail.ts). */
export const CONTENT_SCAN_CHARS = 16_000;

/**
 * Features of one tool call. `root` (the project root) turns absolute paths inside the project into relative ones;
 * for a path outside it only the last segment gives keywords (not `Users`, `home` or the user name).
 */
export function actionFeatures(action: GuardAction, root?: string): Features & { segments: string[] } {
  const paths = new Set<string>();
  const files = new Set<string>();
  const commands = new Set<string>();
  const kw = new Set<string>();
  const rootN = root ? normPath(root).replace(/\/+$/, "") : null;
  const addPath = (p: string) => {
    let s = normPath(p);
    if (!s || s === "." || s === "..") return;
    let outside = false;
    if (s.startsWith("/") || /^[A-Za-z]:\//.test(s) || s.startsWith("~")) {
      if (rootN && s.toLowerCase().startsWith(`${rootN.toLowerCase()}/`)) s = s.slice(rootN.length + 1);
      else outside = true;
    }
    paths.add(s);
    const base = s.replace(/\/+$/, "").split("/").pop();
    if (base) files.add(base.toLowerCase());
    for (const k of keywords(outside ? (base ?? "") : s)) kw.add(k);
  };
  const segments: string[] = [];
  if (action.tool === "Bash") {
    for (const seg of splitCommand(action.command ?? "")) {
      segments.push(seg);
      const { words: w, redirects } = shellWords(seg);
      const { cmd, sub, args } = commandOf(w);
      if (cmd) {
        commands.add(cmd);
        if (sub) commands.add(`${cmd} ${sub}`);
        for (const k of keywords(cmd)) kw.add(k);
      }
      for (const a of args) {
        if (FLAG_WORDS[a]) for (const x of FLAG_WORDS[a]!) kw.add(stem(x));
        const eq = /^--?[A-Za-z0-9-]+=(.+)$/.exec(a);
        if (a.startsWith("-") && !eq) {
          for (const k of keywords(a)) kw.add(k);
          continue;
        }
        const value = eq ? eq[1]! : a;
        if (pathKind(value)) addPath(value);
        for (const k of keywords(value)) kw.add(k);
      }
      for (const r of redirects) if (!/^\d+$/.test(r)) addPath(r);
    }
  } else {
    if (action.file) addPath(action.file);
    const text = `${(action.added ?? "").slice(0, CONTENT_SCAN_CHARS)}\n${(action.removed ?? "").slice(0, CONTENT_SCAN_CHARS / 2)}`;
    for (const k of keywords(text)) kw.add(k);
    // Paths written in the content (an import of `src/secrets/*`, a workflow step running `./deploy.sh`).
    for (const tok of text.split(/[\s"'`()[\]{},;=]+/)) {
      const kind = pathKind(tok);
      if (kind === "path" || kind === "file") {
        const s = normPath(tok);
        if (kind === "file") files.add(s.toLowerCase());
        else paths.add(s);
      }
    }
    // Shell commands written into scripts, CI files and Makefiles count as command words too.
    for (const line of text.split("\n")) {
      const { cmd, sub } = commandOf(shellWords(line.replace(/^\s*(?:-\s*)?(?:run:\s*)?/, "")).words);
      if (cmd && TOOLS.has(cmd)) {
        commands.add(cmd);
        if (sub) commands.add(`${cmd} ${sub}`);
      }
    }
  }
  return { paths: [...paths], files: [...files], commands: [...commands], keywords: [...kw], segments };
}

// ---------------------------------------------------------------------------------------------
// Matching

function pathMatches(rulePath: string, callPath: string): boolean {
  const r = rulePath.replace(/\/+$/, "").toLowerCase();
  const c = callPath.replace(/\/+$/, "").toLowerCase();
  if (!r || !c) return false;
  if (c === r || c.endsWith(`/${r}`) || c.startsWith(`${r}/`) || c.includes(`/${r}/`)) return true;
  return false;
}

function fileMatches(ruleFile: string, callFile: string): boolean {
  // `.env` covers `.env.local` and `.env.production`, not `.env.example`: that one is a template people commit.
  if (callFile === ruleFile) return true;
  return callFile.startsWith(`${ruleFile}.`) && !/\.(?:example|sample|template|dist|defaults?)$/.test(callFile);
}

/** Score every rule against a call's features and return the candidates, strongest first. */
export function matchRules(rules: IndexedRule[], call: Features, opts: MatchOptions = DEFAULT_MATCH): Candidate[] {
  const callKw = new Set(call.keywords);
  const callCmds = new Set(call.commands);
  const out: Candidate[] = [];
  for (const rule of rules) {
    const f = rule.features;
    const reasons: string[] = [];
    const terms = new Set<string>();
    let score = 0;
    for (const p of f.paths) {
      const glob = /[*?]/.test(p) ? globToRegExp(p) : null;
      const hit = call.paths.find((c) => (glob ? glob.test(c) : pathMatches(p, c)));
      if (hit) {
        score += BROAD_DIRS.has(p.replace(/\/+$/, "").toLowerCase()) ? WEIGHTS.broadPath : WEIGHTS.path;
        reasons.push(`path ${p} ~ ${hit}`);
        terms.add(hit.split("/").pop() ?? hit);
      }
    }
    for (const r of f.files) {
      const hit = call.files.find((c) => fileMatches(r, c));
      if (hit) {
        score += WEIGHTS.file;
        reasons.push(`file ${r} ~ ${hit}`);
        terms.add(hit);
      }
    }
    let kwScore = 0;
    for (const c of f.commands) {
      if (!callCmds.has(c)) {
        // A tool the rule names, mentioned in the call without being run (an `eslint-disable` comment): a keyword.
        if (!c.includes(" ") && callKw.has(stem(c))) {
          kwScore += WEIGHTS.keyword;
          reasons.push(`keyword ${c}`);
          terms.add(c);
        }
        continue;
      }
      score += c.includes(" ") ? WEIGHTS.pair : COMMON_TOOLS.has(c) ? WEIGHTS.commonCommand : WEIGHTS.command;
      reasons.push(`command ${c}`);
      terms.add(c.split(" ").pop()!);
    }
    for (const k of f.keywords) {
      if (!callKw.has(k)) continue;
      kwScore += WEIGHTS.keyword;
      reasons.push(`keyword ${k}`);
      terms.add(k);
    }
    score += Math.min(kwScore, WEIGHTS.keywordCap);
    if (score >= opts.minScore && reasons.length) out.push({ rule, score, reasons, terms: [...terms] });
  }
  out.sort((a, b) => b.score - a.score || a.rule.id.localeCompare(b.rule.id));
  return out.slice(0, Math.max(0, opts.max));
}

/**
 * The part of `text` to send to Jev: `max` characters around the first place one of `terms` appears (so a rule
 * matched deep in a long file is still in view), or the start.
 */
export function snippetAround(text: string, terms: string[], max: number): string {
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    if (t.length < 3) continue;
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = at < 0 ? 0 : Math.max(0, Math.min(text.length - max, at - Math.floor(max / 3)));
  return (start > 0 ? "…" : "") + text.slice(start, start + max) + (start + max < text.length ? "…" : "");
}
