import { describe, expect, it } from "vitest";
import { scrubSecrets } from "../src/scrub.js";

describe("scrubSecrets", () => {
  it("redacts common key shapes but keeps the surrounding sentence", () => {
    const s = scrubSecrets("Set OPENAI key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 in env.");
    expect(s).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(s).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(s).toContain("in env.");
  });
  it("redacts key=value credentials and keeps the key name", () => {
    expect(scrubSecrets("DATABASE password=SuperSecret123!")).toBe("DATABASE password=[REDACTED]");
    expect(scrubSecrets("api_key: abcdefgh12345678")).toContain("api_key=[REDACTED]");
  });
  it("redacts credentials embedded in connection strings", () => {
    expect(scrubSecrets("use postgres://admin:hunter2@db.internal:5432/app")).toBe("use postgres://[REDACTED]@db.internal:5432/app");
  });
  it("redacts private key blocks and bearer tokens", () => {
    expect(scrubSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----")).toBe("[REDACTED]");
    expect(scrubSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toBe("Authorization: [REDACTED]");
  });
  it("leaves ordinary code and prose alone", () => {
    const text = "We decided to use tRPC for the API and keep the bundle under 200KB.";
    expect(scrubSecrets(text)).toBe(text);
  });
});
