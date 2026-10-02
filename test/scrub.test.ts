import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { scrubSecrets } from "../src/scrub.js";

describe("scrubSecrets", () => {
  it("redacts common key shapes but keeps the surrounding sentence", () => {
    // Synthetic example keys in the providers' shapes, not real ones.
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
    // Synthetic example tokens: only their shapes matter.
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

describe("names with no underscore before the word, in every form (0.5.7 sent these values as they were)", () => {
  it.each([
    // NAME=value
    ["PGPASSWORD=hunter2", "PGPASSWORD=[REDACTED]"],
    ["export PGPASSWORD=hunter2 && psql -h db", "export PGPASSWORD=[REDACTED] && psql -h db"],
    ["PGPASSWORD=x", "PGPASSWORD=[REDACTED]"],
    ["pgpassword=x", "pgpassword=[REDACTED]"],
    ["MYSQLPWD=x", "MYSQLPWD=[REDACTED]"],
    ["MYSQL_PWD=x", "MYSQL_PWD=[REDACTED]"],
    ["DB_PASS=x", "DB_PASS=[REDACTED]"],
    ["APIKEY=abc", "APIKEY=[REDACTED]"],
    ["AUTHTOKEN=t", "AUTHTOKEN=[REDACTED]"],
    ["CLIENTSECRET=s", "CLIENTSECRET=[REDACTED]"],
    ["HTPASSWD=user:x", "HTPASSWD=[REDACTED]"],
    ["curl https://maps.example.com/v1?key=abc123", "curl https://maps.example.com/v1?key=[REDACTED]"],
    ["deploy --api-key=abc", "deploy --api-key=[REDACTED]"],
    ["token := \"abc\"", "token=[REDACTED]"],
    // NAME: value
    ["PGPASSWORD: hunter2", "PGPASSWORD=[REDACTED]"],
    ["apikey: abc", "apikey=[REDACTED]"],
    ["apiKey: abc", "apiKey=[REDACTED]"],
    ["X-Api-Key: abc123", "X-Api-Key=[REDACTED]"],
    ["spring.datasource.password: s3cret", "spring.datasource.password=[REDACTED]"],
    ["secret: a", "secret=[REDACTED]"],
    ["Password:\nhunter2", "Password=[REDACTED]"],
    // with an underscore, as before, and a secret word inside a longer name
    ["DB_PASSWORD=x", "DB_PASSWORD=[REDACTED]"],
    ["SECRET_KEY_BASE=abc", "SECRET_KEY_BASE=[REDACTED]"],
    ["GITHUB_TOKEN_2=t", "GITHUB_TOKEN_2=[REDACTED]"],
    // a quoted value is redacted whole (0.5.7 left everything after its first space)
    ['DB_PASSWORD="two words"', "DB_PASSWORD=[REDACTED]"],
    ["password: 'correct horse battery'", "password=[REDACTED]"],
  ])("%s", (input, want) => {
    expect(scrubSecrets(input)).toBe(want);
  });

  it.each([
    // "name": "value" keeps its quotes and separator
    ['{"PGPASSWORD": "hunter2"}', '{"PGPASSWORD": "[REDACTED]"}'],
    ['{"apiKey":"abc","region":"eu"}', '{"apiKey":"[REDACTED]","region":"eu"}'],
    ['{"password": "a b c", "user": "admin"}', '{"password": "[REDACTED]", "user": "admin"}'],
    ["{'client_secret': 'x'}", "{'client_secret': '[REDACTED]'}"],
    ['"authToken": 12345', '"authToken": "[REDACTED]"'],
    ['"secret": "a\\"b"', '"secret": "[REDACTED]"'],
    ['"api-key" = "abc"', '"api-key" = "[REDACTED]"'],
  ])("%s", (input, want) => {
    expect(scrubSecrets(input)).toBe(want);
  });

  it("finds a pair after a pair whose name is not a secret's, on the same line or the next", () => {
    expect(scrubSecrets("Summary: token: abc")).toBe("Summary: token=[REDACTED]");
    expect(scrubSecrets("Note:\npassword: x")).toBe("Note:\npassword=[REDACTED]");
    expect(scrubSecrets('{"note": "rotate it", "token": "t1"}')).toBe('{"note": "rotate it", "token": "[REDACTED]"}');
  });

  it("0.5.7 missed every one of these (the fixture is 0.5.7's scrubber)", async () => {
    const { scrubSecrets: scrub057 } = await import("./fixtures/scrub-0.5.7/scrub.js");
    for (const t of ["PGPASSWORD=hunter2", "apikey: abc", 'DB_PASSWORD="two words"', '{"password": "hunter2"}', '{"DB_PASSWORD": "x"}', "SECRET_KEY_BASE=abc", "X-Api-Key: abc123"]) {
      expect(scrub057(t), t).not.toBe(scrubSecrets(t));
      expect(scrubSecrets(t), t).not.toMatch(/hunter2|abc|words|x"/);
    }
    expect(scrub057("PGPASSWORD=hunter2")).toBe("PGPASSWORD=hunter2");
    expect(scrub057('{"password": "hunter2"}')).toBe('{"password": "hunter2"}');
    expect(scrub057('DB_PASSWORD="two words"')).toBe('DB_PASSWORD=[REDACTED] words"');
  });
});

describe("near misses stay as they are", () => {
  it.each([
    "keyboard=us",
    "keyboard: us",
    '"keyboard": "us"',
    "KEYBOARD_LAYOUT=de",
    "tokenizer=bpe",
    "tokenizer: cl100k",
    '"tokenizer": "bpe"',
    "monkey=1",
    "monkey: george",
    '"monkey": "george"',
    "MONKEY_PATCH=1",
    "hotkey: ctrl+k",
    '{"turkey": "roast", "hockey": "ice"}',
    "MAX_TOKENS=4000",
    '"max_tokens": 4000',
    "input_tokens: 812",
    "KEYCLOAK_URL=http://localhost:8080",
    "passport: valid",
    "bypass: true",
    "We moved the keyboard shortcuts into the tokenizer module; the monkey test passes.",
    "if (key === expected) return token;",
    "items.map((key) => key.id)",
    "let k = SigningKey::generate(&mut rng);",
    "https://example.com/docs",
  ])("%s", (input) => {
    expect(scrubSecrets(input)).toBe(input);
  });

  it("the 0.5.7 fixture is the v0.5.7 tag's src/scrub.ts", () => {
    let tagged: string;
    try {
      tagged = execFileSync("git", ["show", "v0.5.7:src/scrub.ts"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return; // no tags in this checkout
    }
    expect(fs.readFileSync("test/fixtures/scrub-0.5.7/scrub.ts", "utf8").split("\n").slice(2).join("\n")).toBe(tagged);
  });
});

describe("documented limits (SECURITY.md 'Not caught')", () => {
  it("does not claim to catch phone numbers, 15-digit Amex numbers, names, plural names, names with a space, or a short 'is' value", () => {
    for (const t of ["call 555-123-4567", "amex 378282246310005", "John Smith, 12 Main St", "mysql -phunter2", "passphrase=x", "credentials=x", "API_KEYS=abc,def", '"api key": "abc"', "the password is hunter2", 'password => "x"']) expect(scrubSecrets(t)).toBe(t);
  });
  it("is over-eager on names with a secret word, as documented", () => {
    expect(scrubSecrets("primary_key: id")).toBe("primary_key=[REDACTED]");
    expect(scrubSecrets("api_key: 'abc'")).toBe("api_key=[REDACTED]");
    expect(scrubSecrets("token_ttl: 3600")).toBe("token_ttl=[REDACTED]");
    expect(scrubSecrets("function f(token: string) {}")).toBe("function f(token=[REDACTED] {}");
    expect(scrubSecrets("const token = await fetchToken();")).toBe("const token=[REDACTED] fetchToken();");
    expect(scrubSecrets("curl http://token-service:3000/health")).toBe("curl http://token-service=[REDACTED]");
  });
});

describe("scrubbing a Jev request's state", () => {
  it("scrubs each string, so a KEY=value at the end of a string cannot eat its closing quote", async () => {
    const { scrubState } = await import("../src/jev.js");
    const state = { tool_call: { content: "timeout: 30s\nmaps_api_key: AIzaSyD4k9ZqQ7w2Xc8vB1nM3lK5jH6gF0dS9aP" }, list: ["DB_PASSWORD=hunter2", 3, null], n: 1 };
    const out = scrubState(state) as any;
    expect(out).toEqual({ tool_call: { content: "timeout: 30s\nmaps_api_key=[REDACTED]" }, list: ["DB_PASSWORD=[REDACTED]", 3, null], n: 1 });
    // The old way (scrubbing the JSON text) broke exactly this state.
    expect(() => JSON.parse(scrubSecrets(JSON.stringify(state)))).toThrow();
    expect(scrubState("token: abcdefgh12345678")).toBe("token=[REDACTED]");
    expect(scrubState(null)).toBeNull();
  });
});
