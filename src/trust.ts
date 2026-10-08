/**
 * `jevmem trust` (0.7.0): mark a line you wrote as verified, so the guard can block on it (docs/guardrails.md) and recall
 * serves it without the poisoning gate. A line is verified when `.jevmem/provenance.jsonl` holds its id and the hash of
 * its exact text (src/provenance.ts); `trust` writes that record, `via: "trust"`, after showing the line, taking a yes on
 * a terminal, and asking the poisoning gate about it. What stops a planted line from being trusted: the record is local
 * and gitignored, so a clone inherits none; a line whose text changes afterwards has a new hash and is unverified again;
 * the gate refuses a line that reads as instructions aimed at an AI; and the command refuses without a terminal, so an
 * agent's shell cannot run it (its PreToolUse call is asked about by the guard's tamper check as well).
 */
import type { CliIo } from "./cli-main.js";
import { hiddenTextReason, planGate, settleGate, gateLines } from "./guard.js";
import type { JevCaller } from "./jev.js";
import { isVerified, readProvenance, recordProvenance } from "./provenance.js";
import type { MemoryStore } from "./store.js";
import type { JevmemConfig } from "./types.js";

export interface TrustDeps {
  jev: JevCaller;
  /** Shows the line and asks; resolves true on a yes. The CLI reads the answer on the terminal. */
  confirm: (prompt: string) => Promise<boolean>;
}

export const TRUST_PROMPT = "Trust this line? [y/N] ";

/** Trust the lines with these ids, one at a time. Returns the exit code: 1 when any id was refused or not found. */
export async function trustLines(root: string, cfg: JevmemConfig, store: MemoryStore, ids: string[], io: CliIo, deps: TrustDeps): Promise<number> {
  let code = 0;
  for (const id of ids) {
    const m = store.active().find((x) => x.id === id);
    if (!m) {
      io.err(`jevmem trust: no live line with id ${id} in ${cfg.memoryFile}\n`);
      code = 1;
      continue;
    }
    if (isVerified(readProvenance(root), m)) {
      io.out(`${id} is already verified: jevmem wrote this exact text on this machine, or it was trusted before\n`);
      continue;
    }
    io.out(`[${m.kind}] ${m.text}  (${id})\n`);
    if (!(await deps.confirm(TRUST_PROMPT))) {
      io.out(`not trusted: ${id}\n`);
      continue;
    }
    const hidden = hiddenTextReason(m.text);
    if (hidden) {
      io.err(`jevmem trust: refused ${id}: ${hidden}\n`);
      code = 1;
      continue;
    }
    // The poisoning gate, as recall asks it for an unverified line; its verdict is cached like any other.
    const plan = planGate(root, [m], cfg.thresholds.injectionMax);
    if (plan.withheld.length) {
      io.err(`jevmem trust: refused ${id}: ${plan.withheld[0]!.reason}\n`);
      code = 1;
      continue;
    }
    if (plan.check.length) {
      let withheld;
      try {
        const { scores, model } = await gateLines(deps.jev, [m], { timeoutMs: cfg.jev.timeoutMs, label: "gate" });
        withheld = settleGate(root, [m], scores, cfg.thresholds.injectionMax, model, "jevmem trust").withheld;
      } catch (err) {
        io.err(`jevmem trust: the poisoning gate could not check ${id} (${err instanceof Error ? err.message : String(err)}); nothing was changed\n`);
        code = 1;
        continue;
      }
      if (withheld.length) {
        io.err(`jevmem trust: refused ${id}: ${withheld[0]!.reason}\n`);
        code = 1;
        continue;
      }
    }
    recordProvenance(root, m, "trust");
    io.out(`trusted ${id}: jevmem treats this line as one it wrote here (the guard can block on it; an edit to its text makes it unverified again)\n`);
  }
  return code;
}
