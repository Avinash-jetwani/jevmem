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
}

export const DEFAULT_CONFIG: JevmemConfig = {
  memoryFile: "JEVMEM.md",
  thresholds: {
    importanceMin: "useful",
    contentMin: 0.5,
    chitChatMax: 0.5,
    injectionMax: 0.5,
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
    maxChars: 140,
    timeoutMs: 8000,
  },
  daemon: {
    enabled: true,
    idleMinutes: 30,
  },
};
