import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyAudit, auditMemories, formatAuditTable, snapshotRepo } from "../src/audit.js";
import { rankMemories } from "../src/recall.js";
import { MemoryStore } from "../src/store.js";
import { mockJev } from "./helpers.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jevmem-audit-"));

describe("audit", () => {
  it("snapshots the repo, asks one noul per memory, and flags lines below the threshold", async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "index.ts"), "");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "demo", dependencies: { pg: "^8" } }));
    fs.writeFileSync(path.join(root, "README.md"), "# demo");
    const snap = snapshotRepo(root);
    expect(snap.tree).toEqual(["README.md", "package.json", "src/", "src/index.ts"]);
    expect((snap.packageJson as any).dependencies.pg).toBe("^8");

    const store = new MemoryStore(root);
    const keep = store.add({ kind: "decision", text: "Use pg for Postgres access" });
    const gone = store.add({ kind: "architecture", text: "Auth lives in packages/auth" });
    const jev = mockJev((q) => Object.fromEntries(Object.keys(q).map((k) => [k, k === `true_${gone.id}` ? 0.2 : 0.9])));
    const rows = await auditMemories(jev, store, { staleBelow: 0.4 });
    expect(jev.calls).toHaveLength(1);
    expect(Object.keys(jev.calls[0]!.questions)).toHaveLength(2);
    expect(rows.find((r) => r.memory.id === gone.id)!.stale).toBe(true);
    expect(rows.find((r) => r.memory.id === keep.id)!.stale).toBe(false);
    applyAudit(store, rows);
    const raw = fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8");
    expect(raw).toContain("- [architecture] [stale?] Auth lives in packages/auth");
    expect(raw).toContain("stale:0.20");
    expect(raw).toContain("- [decision] Use pg for Postgres access  <!--");
    expect(formatAuditTable(rows)).toContain("stale?");
    // A later pass that scores it healthy clears the flag.
    const rows2 = rows.map((r) => ({ ...r, stillTrue: 0.9, stale: false }));
    applyAudit(store, rows2);
    expect(fs.readFileSync(path.join(root, "JEVMEM.md"), "utf8")).not.toContain("[stale?]");
  });
});

describe("search ranking", () => {
  it("batches a choice plus one noul per candidate (capped at 50) into one call and ranks by noul", async () => {
    const store = new MemoryStore(tmp());
    const mems = Array.from({ length: 60 }, (_, i) => store.add({ kind: "todo", text: `task ${i} about ${i % 2 ? "auth" : "billing"}` }));
    const jev = mockJev((q) => {
      const o: Record<string, number> = {};
      for (const k of Object.keys(q)) if (k.startsWith("rel_")) o[k] = k === `rel_${mems[1]!.id}` ? 0.95 : 0.1;
      return o;
    });
    const ranked = await rankMemories(jev, "auth task", store.active(), { perCandidateNouls: true, noulCap: 50 });
    expect(jev.calls).toHaveLength(1);
    const names = Object.keys(jev.calls[0]!.questions);
    expect(names.filter((n) => n.startsWith("rel_"))).toHaveLength(50);
    expect(names).toContain("most_relevant");
    expect(ranked[0]!.memory.id).toBe(mems[1]!.id);
    expect(ranked[0]!.relevance).toBe(0.95);
    expect(ranked).toHaveLength(60);
  });
});
