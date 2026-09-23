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

describe("PII", () => {
  it("redacts email addresses and 16-digit numbers but not shorter ids or versions", () => {
    expect(scrubSecrets("ping bob.smith+dev@corp.example.org about it")).toBe("ping [REDACTED] about it");
    expect(scrubSecrets("card 4111111111111111 and 4111-1111-1111-1111")).toBe("card [REDACTED] and [REDACTED]");
    expect(scrubSecrets("ticket 123456 on v20.11.1 port 5432")).toBe("ticket 123456 on v20.11.1 port 5432");
  });
});

describe("env-style and short credentials", () => {
  it.each([
    ["DB_PASSWORD=supersecret123", "DB_PASSWORD=[REDACTED]"],
    ["export AWS_SECRET_ACCESS_KEY=abc", "export AWS_SECRET_ACCESS_KEY=[REDACTED]"],
    ["APP_SECRET=x1", "APP_SECRET=[REDACTED]"],
    ["GITHUB_TOKEN=gh1", "GITHUB_TOKEN=[REDACTED]"],
    ["STRIPE_KEY: 'k9'", "STRIPE_KEY=[REDACTED]"],
    ["set db_password = hunter", "set db_password=[REDACTED]"],
  ])("redacts %s", (input, want) => {
    expect(scrubSecrets(input)).toBe(want);
  });

  it.each([
    ["password=hunter2", "password=[REDACTED]"],
    ["pwd=abc", "pwd=[REDACTED]"],
    ["pass: 1234", "pass=[REDACTED]"],
    ['passwd="pw"', "passwd=[REDACTED]"],
  ])("redacts short password %s", (input, want) => {
    expect(scrubSecrets(input)).toBe(want);
  });

  it("redacts npm, Hugging Face, GitLab and short Stripe tokens", () => {
    for (const t of ["npm_abcdefghijklmnopqrstuvwx12", "hf_abcdefghijklmnopqrstuvwxyz", "glpat-abcdefghijklmnopqrstu", "sk_live_abcdef123456", "rk_test_ABCDEF123456"]) {
      expect(scrubSecrets(`token ${t} here`)).toBe("token [REDACTED] here");
    }
  });

  it("keeps non-secret env assignments and prose", () => {
    for (const t of ["NODE_ENV=production", "MAX_TOKENS=4000", "PORT=8080", "Keep the bundle under 500 KB.", "the bypass flag is off"]) {
      expect(scrubSecrets(t)).toBe(t);
    }
  });
});

describe("documented limits (SECURITY.md 'Not caught')", () => {
  it("does not claim to catch phone numbers, 15-digit Amex numbers, names or apikey: <short>", () => {
    for (const t of ["call 555-123-4567", "amex 378282246310005", "John Smith, 12 Main St", "apikey: abc"]) expect(scrubSecrets(t)).toBe(t);
  });
  it("is over-eager on *_key pairs, as documented", () => {
    expect(scrubSecrets("primary_key: id")).toBe("primary_key=[REDACTED]");
    expect(scrubSecrets("api_key: 'abc'")).toBe("api_key=[REDACTED]");
  });
});
