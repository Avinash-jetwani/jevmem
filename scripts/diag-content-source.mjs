#!/usr/bin/env node
// Why does Jev say content_source "none" for plain statements? (v0.6 part 2c.) Dev turns only, never the 66-turn
// benchmark: the plain statements and the questions and proposals of eval/dead-ends-dev-v3.jsonl, the questions with no
// content of eval/dead-ends-dev-v2.jsonl, and, to check a rewording keeps what only Claude's reply says, every dev turn
// whose memory comes from the reply (a dead end Claude found, or a bug or structure fact Claude answered with).
//
//   node scripts/diag-content-source.mjs [path/to/dist/index.js] [--conditions asSent,alone,…] [--wording current|…] [--out results/…json]
//
// Every condition asks Jev about the same turns and records the content_source choice (and its probabilities) and the
// kind choice, in tier 1 and tier 2, with the question sets decide sends:
// - asSent: the state decide builds (the reply is in it: the plain statements start with When/Do/How/What/Can't or
//   have bug-report words), the full question set of each tier;
// - alone: the same state, the content_source question asked on its own (is it answered independently of the rest?);
// - emptyReply: the reply is an empty string (the reply adds nothing at all, rather than "Okay.");
// - noReply: no assistant_reply in the state, content_source still asked;
// - noMemories: no existing memories listed;
// - wording:<name>: the content_source question reworded (WORDINGS below), asked on its own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { choice } from "@typesafe-ai/sdk";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const distArg = args[0] && !args[0].startsWith("--") ? args[0] : path.resolve("dist/index.js");
const lib = await import(pathToFileURL(path.resolve(distArg)).href);
const OUT = opt("--out", null);
const CONDITIONS = opt("--conditions", "asSent,alone,emptyReply,noReply,noMemories").split(",");
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");

const read = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const SIDES = opt("--sides", "statement,question,reply,both,worksNow,user").split(",");
const fromReply = (r) => r.deadEnd?.source === "assistant" || (r.tag === "ordinary" && ["bug", "architecture"].includes(r.label.kind) && /\?\s*$|^(why|how|what|where|which)\b/i.test(r.user.trim()));
const rows = [
  ...read("eval/dead-ends-dev-v3.jsonl").filter((r) => r.tag === "plain-statement" || r.tag === "question-proposal"),
  ...read("eval/dead-ends-dev-v2.jsonl").filter((r) => r.tag === "question-no-content"),
].map((r) => ({ ...r, side: r.tag === "plain-statement" ? "statement" : "question" }))
  .concat(["eval/dead-ends-dev.jsonl", "eval/dead-ends-dev-v2.jsonl", "eval/dead-ends-dev-v3.jsonl"].flatMap((f) => read(f).filter(fromReply).map((r) => ({ ...r, side: "reply" }))))
  // Dead ends told across both sides ("Try X" → "I tried X; it failed because …") and dead ends Claude made work.
  .concat(["eval/dead-ends-dev.jsonl", "eval/dead-ends-dev-v2.jsonl", "eval/dead-ends-dev-v3.jsonl"].flatMap((f) => read(f).filter((r) => r.deadEnd?.source === "both").map((r) => ({ ...r, side: "both" }))))
  .concat(read("eval/dead-ends-dev-v2.jsonl").filter((r) => r.tag === "supersede-by-reply").map((r) => ({ ...r, side: "worksNow" })))
  // Turns whose memory is the user's, with the reply in the state: dev v1/v2 turns labelled decision, constraint,
  // preference or todo, and dead ends the user told.
  .concat(["eval/dead-ends-dev.jsonl", "eval/dead-ends-dev-v2.jsonl", "eval/dead-ends-dev-v3.jsonl"].flatMap((f) => read(f).filter((r) => (r.deadEnd?.source === "user" || (r.tag === "ordinary" && ["decision", "constraint", "preference", "todo"].includes(r.label.kind))) && lib.buildDecideState({ userMessage: r.user, assistantReply: r.assistant, existingMemories: r.existing }).assistantIncluded).map((r) => ({ ...r, side: "user" }))))
  .filter((r) => SIDES.includes(r.side));

/** Reworded content_source questions, asked on their own. */
const WORDINGS = {
  // The wording decide sends today (src/questions.ts, SOURCE_CRITERIA; one example per side in both tiers).
  current: null,
  // The same options, with "none" saying what it is for: nothing stated on either side, or a question or proposal
  // with nothing decided; and "user_message" saying the reply may add nothing.
  scoped: {
    question: "Where does the memorable content come from?",
    options: {
      user_message: { what: "The memorable content is stated by the user; the assistant reply may only acknowledge it or add nothing.", examples: ["User: 'We'll use Postgres.' Assistant: 'Done.'"] },
      assistant_reply: { what: "The memorable content appears only in the assistant reply, such as a root cause, a structure fact, or an approach the assistant tried that failed.", examples: ["User: 'why is the test flaky?' Assistant: 'Two tests share a temp dir.'"] },
      both: { what: "Both the user message and the assistant reply carry memorable content.", examples: ["User: 'Use pg.' Assistant: 'Done; note the pool lives in db.ts.'"] },
      none: { what: "Neither states anything for the project: thanks or chatter, or a question, proposal or list of options where nothing is decided.", examples: ["User: 'thanks' Assistant: 'You're welcome.'"] },
    },
  },
  // "scoped", with a proposal as the "none" example instead of thanks, and a short acknowledgement in the user example.
  scopedProposal: {
    question: "Where does the memorable content come from?",
    options: {
      user_message: { what: "The memorable content is stated by the user; the assistant reply may only acknowledge it or add nothing.", examples: ["User: 'Never log raw card numbers.' Assistant: 'Understood.'"] },
      assistant_reply: { what: "The memorable content appears only in the assistant reply, such as a root cause, a structure fact, or an approach the assistant tried that failed.", examples: ["User: 'why is the test flaky?' Assistant: 'Two tests share a temp dir.'"] },
      both: { what: "Both the user message and the assistant reply carry memorable content.", examples: ["User: 'Use pg.' Assistant: 'Done; note the pool lives in db.ts.'"] },
      none: { what: "Neither states anything for the project: thanks or chatter, or a question, proposal or list of options where nothing is decided.", examples: ["User: 'Maybe move sessions to Redis?' Assistant: 'Redis would be faster but adds a service to run.'"] },
    },
  },
  // Ask what the turn settles instead of where "memorable content" is.
  settles: {
    question: "Which side of the turn states something settled for this project (a decision, rule, preference, bug, structure fact, failed approach, or work for later)?",
    options: {
      user_message: { what: "The user message states it; the assistant reply only acknowledges it or adds nothing new.", examples: ["User: 'Never log raw card numbers.' Assistant: 'Understood.'"] },
      assistant_reply: { what: "Only the assistant reply states it, such as a root cause, a structure fact, or an approach the assistant tried that failed.", examples: ["User: 'why is the test flaky?' Assistant: 'Two tests share a temp dir.'"] },
      both: { what: "The user message and the assistant reply each state something settled.", examples: ["User: 'Use pg.' Assistant: 'Done; note the pool lives in db.ts.'"] },
      none: { what: "Nothing is settled on either side: thanks or chatter, or a question, proposal or list of options that nobody decides.", examples: ["User: 'Maybe move sessions to Redis?' Assistant: 'Redis would be faster but adds a service to run.'"] },
    },
  },
  // "settles", with a recommendation by the assistant counted as nothing settled.
  settles2: {
    question: "Which side of the turn states something settled for this project (a decision, rule, preference, bug, structure fact, failed approach, or work for later)?",
    options: {
      user_message: { what: "The user message states it; the assistant reply only acknowledges it or adds nothing new.", examples: ["User: 'Never log raw card numbers.' Assistant: 'Understood.'"] },
      assistant_reply: { what: "Only the assistant reply states it, such as a root cause, a structure fact, or an approach the assistant tried that failed.", examples: ["User: 'why is the test flaky?' Assistant: 'Two tests share a temp dir.'"] },
      both: { what: "The user message and the assistant reply each state something settled.", examples: ["User: 'Use pg.' Assistant: 'Done; note the pool lives in db.ts.'"] },
      none: { what: "Nothing is settled on either side: thanks or chatter, or a question, proposal or list of options that nobody decides, even when the assistant recommends one.", examples: ["User: 'Maybe move sessions to Redis?' Assistant: 'Redis would be faster but adds a service to run.'"] },
    },
  },
  // "settles2", with a reply that carries out the user's request still the user's, and the reply side only when the
  // user message just asks or gives a task.
  settles3: {
    question: "Which side of the turn states something settled for this project (a decision, rule, preference, bug, structure fact, failed approach, or work for later)?",
    options: {
      user_message: { what: "The user message states it; the assistant reply only acknowledges it, carries it out, or adds nothing new.", examples: ["User: 'Never log raw card numbers.' Assistant: 'Understood.'"] },
      assistant_reply: { what: "Only the assistant reply states it, such as a root cause, a structure fact, or an approach the assistant tried that failed; the user message only asks or gives a task.", examples: ["User: 'why is the test flaky?' Assistant: 'Two tests share a temp dir.'"] },
      both: { what: "The user message and the assistant reply each state something settled of their own.", examples: ["User: 'Use pg.' Assistant: 'Done; note the pool lives in db.ts.'"] },
      none: { what: "Nothing is settled on either side: thanks or chatter, or a question, proposal or list of options that nobody decides, even when the assistant recommends one.", examples: ["User: 'Maybe move sessions to Redis?' Assistant: 'Redis would be faster but adds a service to run.'"] },
    },
  },
  // "settles2", with a request or a task from the user still the user's (a to-do the reply puts in the backlog).
  settles4: {
    question: "Which side of the turn states something settled for this project (a decision, rule, preference, bug, structure fact, failed approach, or work for later)?",
    options: {
      user_message: { what: "The user message states it, even as a request or a task; the assistant reply only acknowledges it, carries it out, or adds nothing new.", examples: ["User: 'Never log raw card numbers.' Assistant: 'Understood.'"] },
      assistant_reply: { what: "Only the assistant reply states it, such as a root cause, a structure fact, or an approach the assistant tried that failed.", examples: ["User: 'why is the test flaky?' Assistant: 'Two tests share a temp dir.'"] },
      both: { what: "The user message and the assistant reply each state something settled of their own.", examples: ["User: 'Use pg.' Assistant: 'Done; note the pool lives in db.ts.'"] },
      none: { what: "Nothing is settled on either side: thanks or chatter, or a question, proposal or list of options that nobody decides, even when the assistant recommends one.", examples: ["User: 'Maybe move sessions to Redis?' Assistant: 'Redis would be faster but adds a service to run.'"] },
    },
  },
  // "settles4", with a to-do and a reply that files it as the user example.
  settles5: {
    question: "Which side of the turn states something settled for this project (a decision, rule, preference, bug, structure fact, failed approach, or work for later)?",
    options: {
      user_message: { what: "The user message states it, even as a request or a task; the assistant reply only acknowledges it, carries it out, or adds nothing new.", examples: ["User: 'Add retries to the importer next sprint.' Assistant: 'Opened a ticket for it.'"] },
      assistant_reply: { what: "Only the assistant reply states it, such as a root cause, a structure fact, or an approach the assistant tried that failed.", examples: ["User: 'why is the test flaky?' Assistant: 'Two tests share a temp dir.'"] },
      both: { what: "The user message and the assistant reply each state something settled of their own.", examples: ["User: 'Use pg.' Assistant: 'Done; note the pool lives in db.ts.'"] },
      none: { what: "Nothing is settled on either side: thanks or chatter, or a question, proposal or list of options that nobody decides, even when the assistant recommends one.", examples: ["User: 'Maybe move sessions to Redis?' Assistant: 'Redis would be faster but adds a service to run.'"] },
    },
  },
  // Where it is stated, with each option saying where.
  settles6: {
    question: "Where is something settled for this project stated: a decision, rule, preference, bug, structure fact, failed approach, or work for later?",
    options: {
      user_message: { what: "In the user message, even as a request or a task; the assistant reply only acknowledges it, carries it out, or records it.", examples: ["User: 'Never log raw card numbers.' Assistant: 'Understood.'"] },
      assistant_reply: { what: "Only in the assistant reply, such as a root cause, a structure fact, or an approach the assistant tried that failed, when the user message only asks.", examples: ["User: 'why is the test flaky?' Assistant: 'Two tests share a temp dir.'"] },
      both: { what: "In both: the user message and the assistant reply each state something settled of their own.", examples: ["User: 'Use pg.' Assistant: 'Done; note the pool lives in db.ts.'"] },
      none: { what: "Nowhere: thanks or chatter, or a question, proposal or list of options that nobody decides, even when the assistant recommends one.", examples: ["User: 'Maybe move sessions to Redis?' Assistant: 'Redis would be faster but adds a service to run.'"] },
    },
  },
  // "settles4", with a reply that files or carries out the user's request kept off the reply side.
  settles7: {
    question: "Which side of the turn states something settled for this project (a decision, rule, preference, bug, structure fact, failed approach, or work for later)?",
    options: {
      user_message: { what: "The user message states it, even as a request or a task; the assistant reply only acknowledges it, carries it out, or adds nothing new.", examples: ["User: 'Never log raw card numbers.' Assistant: 'Understood.'"] },
      assistant_reply: { what: "Only the assistant reply states it, such as a root cause, a structure fact, or an approach the assistant tried that failed; not a reply that only records or carries out what the user asked.", examples: ["User: 'why is the test flaky?' Assistant: 'Two tests share a temp dir.'"] },
      both: { what: "The user message and the assistant reply each state something settled of their own.", examples: ["User: 'Use pg.' Assistant: 'Done; note the pool lives in db.ts.'"] },
      none: { what: "Nothing is settled on either side: thanks or chatter, or a question, proposal or list of options that nobody decides, even when the assistant recommends one.", examples: ["User: 'Maybe move sessions to Redis?' Assistant: 'Redis would be faster but adds a service to run.'"] },
    },
  },
  // Which side states something for the project (not "settled", which a request for later work is not yet).
  keeps: {
    question: "Which side of the turn states something for this project: a decision, rule, preference, bug, structure fact, failed approach, or work for later?",
    options: {
      user_message: { what: "The user message states it, even as a request or a task; the assistant reply only acknowledges it, carries it out, or records it.", examples: ["User: 'Never log raw card numbers.' Assistant: 'Understood.'"] },
      assistant_reply: { what: "Only the assistant reply states it, such as a root cause, a structure fact, or an approach the assistant tried that failed, and the user message only asks.", examples: ["User: 'why is the test flaky?' Assistant: 'Two tests share a temp dir.'"] },
      both: { what: "The user message and the assistant reply each state something of their own.", examples: ["User: 'Use pg.' Assistant: 'Done; note the pool lives in db.ts.'"] },
      none: { what: "Neither side states anything for the project: thanks or chatter, or a question, proposal or list of options that nobody decides, even when the assistant recommends one.", examples: ["User: 'Maybe move sessions to Redis?' Assistant: 'Redis would be faster but adds a service to run.'"] },
    },
  },
  // "keeps", with a to-do the reply records as the user example.
  keeps2: {
    question: "Which side of the turn states something for this project: a decision, rule, preference, bug, structure fact, failed approach, or work for later?",
    options: {
      user_message: { what: "The user message states it, even as a request or a task; the assistant reply only acknowledges it, carries it out, or records it.", examples: ["User: 'Fix the upload timeout before launch.' Assistant: 'Filed an issue for it.'"] },
      assistant_reply: { what: "Only the assistant reply states it, such as a root cause, a structure fact, or an approach the assistant tried that failed, and the user message only asks.", examples: ["User: 'why is the test flaky?' Assistant: 'Two tests share a temp dir.'"] },
      both: { what: "The user message and the assistant reply each state something of their own.", examples: ["User: 'Use pg.' Assistant: 'Done; note the pool lives in db.ts.'"] },
      none: { what: "Neither side states anything for the project: thanks or chatter, or a question, proposal or list of options that nobody decides, even when the assistant recommends one.", examples: ["User: 'Maybe move sessions to Redis?' Assistant: 'Redis would be faster but adds a service to run.'"] },
    },
  },
  // The "settles" question with the "keeps" options.
  hybrid: {
    question: "Which side of the turn states something settled for this project: a decision, rule, preference, bug, structure fact, failed approach, or work for later?",
    options: {
      user_message: { what: "The user message states it, even as a request or a task; the assistant reply only acknowledges it, carries it out, or records it.", examples: ["User: 'Never log raw card numbers.' Assistant: 'Understood.'"] },
      assistant_reply: { what: "Only the assistant reply states it, such as a root cause, a structure fact, or an approach the assistant tried that failed, and the user message only asks.", examples: ["User: 'why is the test flaky?' Assistant: 'Two tests share a temp dir.'"] },
      both: { what: "The user message and the assistant reply each state something of their own.", examples: ["User: 'Use pg.' Assistant: 'Done; note the pool lives in db.ts.'"] },
      none: { what: "Nothing is settled on either side: thanks or chatter, or a question, proposal or list of options that nobody decides, even when the assistant recommends one.", examples: ["User: 'Maybe move sessions to Redis?' Assistant: 'Redis would be faster but adds a service to run.'"] },
    },
  },
  // The current options, with "none" scoped as above, and the question saying the listed memories are not part of the
  // turn (without memories in the state, Jev never answered "none").
  turnOnly: {
    question: "Which part of this turn carries the content worth remembering? The existing memories listed in the state are not part of the turn.",
    options: {
      user_message: { what: "The memorable content is stated by the user; the assistant reply may only acknowledge it or add nothing.", examples: ["User: 'We'll use Postgres.' Assistant: 'Done.'"] },
      assistant_reply: { what: "The memorable content appears only in the assistant reply, such as a root cause, a structure fact, or an approach the assistant tried that failed.", examples: ["User: 'why is the test flaky?' Assistant: 'Two tests share a temp dir.'"] },
      both: { what: "Both the user message and the assistant reply carry memorable content.", examples: ["User: 'Use pg.' Assistant: 'Done; note the pool lives in db.ts.'"] },
      none: { what: "Neither states anything for the project: thanks or chatter, or a question, proposal or list of options where nothing is decided.", examples: ["User: 'thanks' Assistant: 'You're welcome.'"] },
    },
  },
};
for (const w of opt("--wording", "").split(",").filter(Boolean)) if (!(w in WORDINGS)) throw new Error(`unknown wording ${w}`);
const wordings = opt("--wording", "").split(",").filter(Boolean);
const conditions = [...CONDITIONS.filter(Boolean), ...wordings.map((w) => `wording:${w}`)];

const sourceQuestion = (w) => (w ? choice(w.question, w.options) : null);
const jev = lib.createJev({ noLogFile: true, cache: false, timeoutMs: 30000 });
let commit = null;
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain src", { encoding: "utf8" }).trim() ? "+dirty" : "");
} catch {}

async function ask(state, questions, tier) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await jev.call(state, questions, { label: "diag", tier });
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
const pick = (a) => (a ? { choice: a.choice, none: a.probabilities?.none ?? null, user: a.probabilities?.user_message ?? null, assistant: a.probabilities?.assistant_reply ?? null, both: a.probabilities?.both ?? null } : null);

const out = [];
let tokens = 0;
for (const r of rows) {
  const { state, candidates, assistantIncluded } = lib.buildDecideState({ userMessage: r.user, assistantReply: r.assistant, existingMemories: r.existing });
  const res = { id: r.id, side: r.side, tag: r.tag, user: r.user, assistant: r.assistant, assistantIncluded, by: {} };
  for (const c of conditions) {
    let s = state;
    let cands = candidates;
    if (c === "emptyReply") s = { ...state, assistant_reply: "" };
    if (c === "noReply") {
      s = { ...state };
      delete s.assistant_reply;
    }
    if (c === "noMemories") {
      s = { ...state, existing_memories: [] };
      cands = [];
    }
    const t1q = lib.buildTier1Questions(cands, { withAssistant: true });
    const t2q = lib.buildDecideQuestions(cands, { examplesPerSide: 1, withAssistant: true });
    if (c === "alone" || c.startsWith("wording:")) {
      const w = c.startsWith("wording:") ? WORDINGS[c.slice(8)] : null;
      const q = { content_source: w ? sourceQuestion(w) : t1q.content_source };
      const a = await ask(s, q, 1);
      tokens += a.usage.input_tokens;
      res.by[c] = { source: pick(a.answers.content_source) };
    } else {
      const a1 = await ask(s, t1q, 1);
      const a2 = await ask(s, t2q, 2);
      tokens += a1.usage.input_tokens + a2.usage.input_tokens;
      res.by[c] = { tier1: { source: pick(a1.answers.content_source), kind: a1.answers.kind?.choice }, tier2: { source: pick(a2.answers.content_source), kind: a2.answers.kind?.choice } };
    }
  }
  out.push(res);
  process.stderr.write(".");
}
process.stderr.write("\n");

// Per condition and side: how often "none" is chosen, and the mean P(none).
const summary = {};
for (const c of conditions) {
  for (const side of SIDES) {
    const xs = out.filter((o) => o.side === side);
    const answers = xs.flatMap((o) => (o.by[c].source ? [o.by[c].source] : [o.by[c].tier1.source, o.by[c].tier2.source]));
    const none = answers.filter((a) => a.choice === "none").length;
    const mean = answers.reduce((s, a) => s + (a.none ?? 0), 0) / Math.max(1, answers.length);
    const fromTheReply = answers.filter((a) => a.choice === "assistant_reply" || a.choice === "both").length;
    (summary[c] ??= {})[side] = { answers: answers.length, none, noneRate: answers.length ? none / answers.length : null, meanPNone: mean, assistantOrBoth: fromTheReply };
  }
}
const report = {
  kind: "content-source-diagnosis",
  date: new Date().toISOString().slice(0, 10),
  commit,
  dist: path.relative(process.cwd(), path.resolve(distArg)),
  sets: ["eval/dead-ends-dev-v3.jsonl (plain-statement, question-proposal)", "eval/dead-ends-dev-v2.jsonl (question-no-content)", "reply: dev v1, v2 and v3 turns whose memory is in Claude's reply (a dead end Claude found; a bug or architecture answer to a question)"],
  turns: Object.fromEntries(SIDES.map((side) => [side, out.filter((o) => o.side === side).length])),
  machine: `${process.platform} ${process.arch}, node ${process.version}, ${os.cpus()[0]?.model ?? "cpu"}`,
  method: "Each condition asks the real Jev (cache off) about the same dev turns and records the content_source choice and its probabilities; asSent, emptyReply, noReply and noMemories ask the full tier-1 and tier-2 question sets (both answers counted), alone and wording:* ask the content_source question on its own.",
  inputTokens: tokens,
  costUsd: (tokens / 1e6) * 0.042,
  wordings: Object.fromEntries(wordings.map((w) => [w, WORDINGS[w]])),
  summary,
  rows: out,
};
for (const [c, v] of Object.entries(summary)) console.log(`${c.padEnd(24)} ${Object.entries(v).map(([side, x]) => `${side}: none ${x.none}/${x.answers} (mean P(none) ${x.meanPNone.toFixed(2)})${side === "reply" || side === "both" || side === "worksNow" || side === "user" ? `, reply or both ${x.assistantOrBoth}/${x.answers}` : ""}`).join("   ")}`);
for (const o of out) {
  const cells = conditions.map((c) => {
    const b = o.by[c];
    const f = (s) => `${s.choice === "none" ? "NONE" : s.choice.replace("_message", "").replace("_reply", "")}:${(s.none ?? 0).toFixed(2)}`;
    return b.source ? f(b.source) : `${f(b.tier1.source)}/${f(b.tier2.source)}`;
  });
  console.log(`  ${o.side.padEnd(9)} ${o.id.padEnd(24)} ${cells.join("  ")}`);
}
console.log(`input tokens ${tokens}, $${report.costUsd.toFixed(4)}`);
if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
  console.log(`written ${OUT}`);
}
