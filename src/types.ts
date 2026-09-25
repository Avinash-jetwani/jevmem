/** The seven memory kinds Jevmem tracks. `superseded` is only ever assigned by contradiction handling. */
export const KINDS = [
  "decision",
  "constraint",
  "preference",
  "bug",
  "architecture",
  "todo",
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
  /** How many memories to inject on UserPromptSubmit. */
  recallTopK: number;
  /** Minimum relevance probability for a memory to be injected. */
  recallMin: number;
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
    /** Max memory ids to include in one `touches_memory_id` choice. Pre-filtered by keyword overlap beyond this. */
    maxIdsPerCall: number;
    /** Max candidates sent to recall/search (pre-filtered by keyword overlap beyond this). */
    maxRecallCandidates: number;
    /** USD per million tokens, used for the cost column in `.jevmem/log.jsonl`. */
    usdPerMillionTokens: number;
    /** Cache identical (state, questions) → answers in `.jevmem/cache/`. */
    cache: boolean;
    /** Send `zeroDataRetention: true` with every request. `"auto"` turns it on when the base URL is a Vercel AI Gateway. */
    zeroDataRetention: boolean | "auto";
  };
  writer: {
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
  /** Two-tier decide: tier 1 (9 broad nouls) every turn, tier 2 (30 atomic nouls) only on borderline turns. */
  tiers: TiersConfig;
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
    chitChatMax: 0.5,
    injectionMax: 0.5,
    metaMax: 0.5,
    contradictionMin: 0.7,
    staleBelow: 0.4,
    recallTopK: 5,
    recallMin: 0.05,
  },
  jev: {
    model: "jev-latest",
    timeoutMs: 2000,
    maxIdsPerCall: 200,
    maxRecallCandidates: 60,
    usdPerMillionTokens: 0.042,
    cache: true,
    zeroDataRetention: "auto",
  },
  writer: {
    provider: "auto",
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
};
