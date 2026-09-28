/**
 * The eight memory kinds Jevmem tracks. `superseded` is only ever assigned by contradiction handling. `dead-end` is an
 * approach that was tried and failed or was dropped, with the reason (docs/dead-ends.md).
 */
export const KINDS = [
  "decision",
  "constraint",
  "preference",
  "bug",
  "architecture",
  "todo",
  "dead-end",
  "superseded",
] as const;
export type Kind = (typeof KINDS)[number];

/** Kinds Jev may pick for a *new* memory (everything except `superseded`). */
export const NEW_KINDS = KINDS.filter((k) => k !== "superseded") as Exclude<Kind, "superseded">[];

export const IMPORTANCE_LEVELS = ["trivial", "minor", "useful", "important", "critical"] as const;
export type Importance = (typeof IMPORTANCE_LEVELS)[number];

export interface Memory {
  id: string;
  kind: Kind;
  text: string;
  ts: string; // ISO-8601
  conf: number; // 0..1, Jev confidence at save time
  /** Set when this memory has been superseded by a newer one. */
  supersededBy?: string;
  /** Set by `jevmem audit` when the memory scored below the stale threshold. */
  stale?: number;
}

export interface Thresholds {
  /** Minimum importance level to save. */
  importanceMin: Importance;
  /** Minimum combined kind-family score (from the atomic nouls) for the turn to count as having memorable content. */
  contentMin: number;
  /**
   * A dead end must say why it failed or was dropped, and Jev decides whether the turn does: the dead-end noul, which
   * asks for the reason, at or above this (docs/dead-ends.md). Replaces the word list of part 2.
   */
  deadEndMin: number;
  /** Skip when `is_only_chit_chat` is at or above this. */
  chitChatMax: number;
  /** Skip when the injection guard noul is at or above this. */
  injectionMax: number;
  /** Skip when the assistant reply is in the state and the meta family (options / self-summary / memory commentary) is at or above this. */
  metaMax: number;
  /** Mark a contradiction when `contradicts_existing_memory` is at or above this. */
  contradictionMin: number;
  /** `jevmem audit` marks memories below this as `[stale?]`. */
  staleBelow: number;
  /** How many memories to inject on UserPromptSubmit, at most. */
  recallTopK: number;
  /**
   * The recall choice's floor until v0.6 part 3b, which gave it a key of its own (`recallChoiceMin`): every
   * `jevmem.config.json` written by `jevmem init` holds this at 0.05, so a new default here would not reach them. The
   * prompt hook no longer reads it.
   */
  recallMin: number;
  /**
   * The recall choice's floor (v0.6 part 3b): a line whose relevance noul is under the sure level (0.97) must also have at
   * least this probability in the "most relevant" choice to be injected. 0.03, chosen on eval/recall-dev.jsonl: at 0.05 the
   * second of two lines a prompt needed was pruned when the first took most of the choice.
   */
  recallChoiceMin: number;
  /** Jev's per-line relevance ("does memory X bear on what the query asks?") at or above which a line may be injected. */
  recallRelevanceMin: number;
}

export interface JevmemConfig {
  /** `false` turns jevmem's hooks off in this project (for example with the plugin installed for every project). */
  enabled?: boolean;
  memoryFile: string;
  thresholds: Thresholds;
  jev: {
    model: string;
    /** Per-call timeout in the hook path. Jev is skipped (never blocks) past this. */
    timeoutMs: number;
    /**
     * The prompt hook's budget for its Jev call (v0.6 part 3b; `timeoutMs` until then). When the call fails or runs past
     * it, the prompt gets the lines that share the most words with it instead (src/recall.ts), so it never waits longer
     * and never goes without memory because of Jev.
     */
    recallTimeoutMs: number;
    /** Max memory ids to include in one `touches_memory_id` choice. Pre-filtered by keyword overlap beyond this. */
    maxIdsPerCall: number;
    /** Max candidates sent to search, MCP `search_memory` and `jevmem search` (pre-filtered by keyword overlap beyond this). */
    maxRecallCandidates: number;
    /**
     * Max live lines the prompt hook sends Jev: every line up to this (Jev's choice takes 255 options), pre-filtered by
     * keyword overlap beyond it. Until v0.6 the hook used `maxRecallCandidates` (60).
     */
    maxRecallLines: number;
    /** USD per million tokens, used for the cost column in `.jevmem/log.jsonl`. */
    usdPerMillionTokens: number;
    /** Cache identical (state, questions) → answers in `.jevmem/cache/`. */
    cache: boolean;
    /** Send `zeroDataRetention: true` with every request. `"auto"` turns it on when the base URL is a Vercel AI Gateway. */
    zeroDataRetention: boolean | "auto";
  };
  writer: {
    /**
     * The one-line writer. `"openai"` or `"anthropic"` sends the text of a turn Jev decided to save to that provider
     * to condense it (using OPENAI_API_KEY or ANTHROPIC_API_KEY). `"none"`, the default, writes the line locally.
     * `"auto"` is the pre-0.5.4 value and now means `"none"`. `"writer": "openai"` is shorthand for the provider.
     */
    provider: "auto" | "openai" | "anthropic" | "none";
    model?: string;
    maxChars: number;
    timeoutMs: number;
  };
  daemon: {
    /** Keep a warm Jev client in a small local process so hook calls skip TLS/connection setup. */
    enabled: boolean;
    /** Start the daemon automatically from the first hook call (alias kept for `enabled`). */
    autostart?: boolean;
    /** The daemon exits after this many minutes without a request. */
    idleMinutes: number;
  };
  /** Logistic weights over the atomic nouls, per family. Hand-set defaults; `jevmem fit` overwrites them from labels. */
  weights?: Record<string, { bias: number; w: Record<string, number> }>;
  /** Two-tier decide: tier 1 (10 broad nouls) every turn, tier 2 (31 atomic nouls) only on borderline turns. */
  tiers: TiersConfig;
  /** The PreToolUse guard: checks Bash, Edit and Write calls against the project's saved `[constraint]` lines. */
  guard: GuardConfig;
}

export const GUARD_MODES = ["ask", "block", "warn", "off"] as const;
export type GuardMode = (typeof GUARD_MODES)[number];

export interface GuardConfig {
  /**
   * What the guard does when Jev says a call may break a saved rule. `ask`: Claude Code asks the user, showing the
   * rule. `block`: the call is denied at or above `blockMin` (Claude sees the rule), asked below it. `warn`: no
   * permission decision; the rule is added to Claude's context as a fact. `off`: the hook does nothing.
   */
  mode: GuardMode;
  /** Jev's "does this call break this rule?" probability at or above which the guard acts. */
  askMin: number;
  /** In `block` mode, deny at or above this; between `askMin` and `blockMin`, ask. */
  blockMin: number;
  /** The hook's own time budget in milliseconds. The Jev call gets what is left; no answer in time means no decision. */
  budgetMs: number;
  /** At most this many candidate rules per call are sent to Jev (the strongest prefilter matches). */
  maxCandidates: number;
}

export interface BorderlineRule {
  /**
   * Which kind nouls the band applies to. `max`: only the strongest kind noul (is there content at all?).
   * `any`: every kind noul; fires on most real turns because secondary kinds often score 0.3–0.7.
   */
  kindNoulScope: "max" | "any";
  /** Escalate when the kind noul(s) in scope are inside [low, high]. */
  kindNoulLow: number;
  kindNoulHigh: number;
  /** Escalate when the `kind` choice confidence is below this (tier 1 could not pick a kind). */
  kindConfidenceMin: number;
  /** Escalate when `contradicts_existing_memory` is at or above this. */
  contradictionMin: number;
  /** Escalate when the importance score's confidence is below this. */
  importanceConfidenceMin: number;
  /** Escalate when the injection noul is inside [low, high]. */
  injectionLow: number;
  injectionHigh: number;
  /**
   * Do not escalate when tier 1 is already sure the turn must be skipped (injection above `injectionHigh`, or
   * chit-chat at or above this value). Tier 2 could only confirm the skip. Set to 1.01 to disable.
   */
  sureSkipChitChatMin: number;
}

export interface TiersConfig {
  /** `auto`: tier 1, then tier 2 on borderline turns. `fast`: tier 1 only. `full`: always tier 2. */
  mode: "auto" | "fast" | "full";
  borderline: BorderlineRule;
  /** Threshold overrides applied when tier 1's answer is final (fitted from tier-1 labels by `jevmem fit`). */
  tier1Thresholds?: Partial<Thresholds>;
  /** Examples per criterion side in tier 2 (1 or 2). */
  tier2ExamplesPerSide: 1 | 2;
}

export const DEFAULT_CONFIG: JevmemConfig = {
  memoryFile: "JEVMEM.md",
  thresholds: {
    importanceMin: "useful",
    contentMin: 0.5,
    deadEndMin: 0.7,
    chitChatMax: 0.5,
    injectionMax: 0.5,
    metaMax: 0.5,
    contradictionMin: 0.7,
    staleBelow: 0.4,
    recallTopK: 5,
    recallMin: 0.05,
    recallChoiceMin: 0.03,
    recallRelevanceMin: 0.8,
  },
  jev: {
    model: "jev-latest",
    timeoutMs: 2000,
    recallTimeoutMs: 1000,
    maxIdsPerCall: 200,
    maxRecallCandidates: 60,
    maxRecallLines: 250,
    usdPerMillionTokens: 0.042,
    cache: true,
    zeroDataRetention: "auto",
  },
  writer: {
    provider: "none",
    maxChars: 200,
    timeoutMs: 8000,
  },
  daemon: {
    enabled: true,
    idleMinutes: 30,
  },
  tiers: {
    mode: "auto",
    borderline: {
      kindNoulScope: "max",
      kindNoulLow: 0.3,
      kindNoulHigh: 0.7,
      kindConfidenceMin: 0.6,
      // Off by default since v0.4.2 (1.01 never fires): escalating on a likely contradiction sent every reversal to
      // tier 2, whose kind and injection gates skipped terse reversals, so the old line stayed live. See DECISIONS.md.
      contradictionMin: 1.01,
      importanceConfidenceMin: 0.5,
      injectionLow: 0.3,
      injectionHigh: 0.7,
      sureSkipChitChatMin: 0.9,
    },
    tier2ExamplesPerSide: 1,
  },
  guard: {
    mode: "ask",
    askMin: 0.5,
    blockMin: 0.9,
    budgetMs: 1000,
    maxCandidates: 3,
  },
};
