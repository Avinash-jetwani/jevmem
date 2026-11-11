"""README graphics for jevmem, five of them: how it works, the guard, the A/B results, how it decides, the benchmark.
Light and dark of each.
usage: python3 make_svgs.py <outdir>   (writes docs/img/*.svg under it)
Every measured number drawn here is from README.md: the A/B results and the guard as at commit 471bc41 (v0.6.3), the
same since; the benchmark's jevmem row is the 0.7.7 build's run of 2026-11-08 (results/eval-heldout-2026-11-08-v077.json) and
its LLM rows v0.4.2's run of 2026-09-23 (results/bench-heldout-2026-09-23-v042.json). The benchmark's times are the
results files' milliseconds drawn as seconds, to two places, rounded half up (160 ms is 0.16 s, as the README says)."""
import sys, os
from decimal import Decimal, ROUND_HALF_UP
from xml.sax.saxutils import escape as esc

OUT = os.path.join(sys.argv[1] if len(sys.argv) > 1 else ".", "docs", "img")
os.makedirs(OUT, exist_ok=True)
FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

THEMES = {
    "light": dict(ink="#1f2328", muted="#59636e", card="#ffffff", line="#d1d9e0", soft="#f6f8fa",
                  orange="#E0692A", gray1="#c8ccd2", gray2="#8c9097", struck="#8c9097", btn="#eef1f4", btnInk="#1f2328"),
    "dark": dict(ink="#e6edf3", muted="#9198a1", card="#151b23", line="#3d444d", soft="#0d1117",
                 orange="#F08A4B", gray1="#4d5561", gray2="#8b949e", struck="#6e7681", btn="#262c36", btnInk="#e6edf3"),
}

def text(x, y, s, size=17, weight=400, fill="ink", anchor="start", font=FONT, extra=""):
    return f'<text x="{x}" y="{y}" font-family="{font}" font-size="{size}" font-weight="{weight}" fill="{{{fill}}}" text-anchor="{anchor}" {extra}>{esc(s)}</text>'

def svg(w, h, body, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{esc(title)}">'
            f'<title>{esc(title)}</title>{body}</svg>')

def card(x, y, w, h):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{{card}}" stroke="{{line}}" stroke-width="1.5"/>'

def step(x, y, n):
    return (f'<circle cx="{x}" cy="{y}" r="15" fill="{{orange}}"/>'
            + text(x, y + 6, str(n), 16, 700, "card", "middle"))

def arrow(x, y):
    return f'<path d="M{x} {y - 11} L{x + 13} {y} L{x} {y + 11}" fill="none" stroke="{{orange}}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>'

def seconds(ms):
    """Milliseconds as seconds to two places, rounded half up on the exact value (a float's 0.215 would print 0.21)."""
    return str((Decimal(ms) / Decimal(1000)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))

def write(name, w, h, body, title):
    for mode, t in THEMES.items():
        s = svg(w, h, body, title)
        for k, v in t.items():
            s = s.replace("{" + k + "}", v)
        open(os.path.join(OUT, f"{name}-{mode}.svg"), "w").write(s)

# ------------------------------------------------------------------ 1. how it works
cw, ch, gap, top = 218, 220, 36, 20
W, H = 20 + 4 * cw + 3 * gap, 300
xs = [10 + i * (cw + gap) for i in range(4)]
b = []
titles = ["You say it", "Jev decides", "jevmem writes it", "Next session"]
for i, x in enumerate(xs):
    b.append(card(x, top, cw, ch))
    b.append(step(x + 32, top + 36, i + 1))
    b.append(text(x + 56, top + 42, titles[i], 19, 700))
    if i < 3:
        b.append(arrow(x + cw + gap / 2 - 6, top + ch / 2))
# 1: a chat bubble
x = xs[0]
b.append(f'<rect x="{x + 20}" y="{top + 80}" width="{cw - 40}" height="64" rx="16" fill="{{soft}}" stroke="{{line}}"/>')
b.append(text(x + 38, top + 118, "We use Postgres.", 18, 600))
b.append(text(x + 22, top + 185, "in a Claude Code chat", 15, 400, "muted"))
# 2: the question
x = xs[1]
b.append(text(x + 22, top + 102, "Worth keeping?", 18, 600))
b.append(text(x + 22, top + 134, "Yes: a decision.", 18, 600, "orange"))
b.append(text(x + 22, top + 185, "about 0.2 s, in the", 15, 400, "muted"))
b.append(text(x + 22, top + 205, "background", 15, 400, "muted"))
# 3: the file, with the old line crossed out
x = xs[2]
b.append(text(x + 22, top + 88, "JEVMEM.md", 15, 600, "muted", font=MONO))
b.append(text(x + 22, top + 120, "We use SQLite.", 16, 400, "struck", font=MONO))
b.append(f'<line x1="{x + 20}" y1="{top + 114}" x2="{x + 160}" y2="{top + 114}" stroke="{{struck}}" stroke-width="2"/>')
b.append(text(x + 22, top + 150, "We use Postgres.", 16, 700, "ink", font=MONO))
b.append(text(x + 22, top + 185, "one line, in your repo", 15, 400, "muted"))
# 4: back to Claude
x = xs[3]
b.append(text(x + 22, top + 102, "Claude gets the", 18, 600))
b.append(text(x + 22, top + 128, "lines that matter", 18, 600))
b.append(text(x + 22, top + 154, "for your prompt.", 18, 600))
b.append(text(x + 22, top + 205, "automatically", 15, 400, "muted"))
b.append(text(W / 2, top + ch + 46, "Change your mind, and the old line is crossed out. Your team gets the file through git.", 17, 400, "muted", "middle"))
write("how-it-works", W, H, "".join(b), "How jevmem works: you say it, Jev decides, jevmem writes one line to JEVMEM.md, and next session Claude gets the lines that matter.")

# ------------------------------------------------------------------ 2. the guard
cw, ch, gap, top = 300, 200, 40, 20
W, H = 20 + 3 * cw + 2 * gap, 250
xs = [10 + i * (cw + gap) for i in range(3)]
b = []
titles = ["Claude wants to run", "jevmem checks your rules", "Claude Code asks you"]
for i, x in enumerate(xs):
    b.append(card(x, top, cw, ch))
    b.append(step(x + 32, top + 36, i + 1))
    b.append(text(x + 56, top + 42, titles[i], 19, 700))
    if i < 2:
        b.append(arrow(x + cw + gap / 2 - 6, top + ch / 2))
x = xs[0]
b.append(f'<rect x="{x + 20}" y="{top + 76}" width="{cw - 40}" height="78" rx="10" fill="#15161a"/>')
b.append(f'<text x="{x + 36}" y="{top + 108}" font-family="{MONO}" font-size="17" fill="#f6f5f1">git add -A &amp;&amp;</text>')
b.append(f'<text x="{x + 36}" y="{top + 136}" font-family="{MONO}" font-size="17" fill="#f6f5f1">git commit -m "wip"</text>')
b.append(text(x + 22, top + 182, "would commit .env", 15, 400, "muted"))
x = xs[1]
b.append(text(x + 22, top + 96, "Your rule, from an old chat:", 15, 400, "muted"))
b.append(text(x + 22, top + 128, "Never commit .env files.", 18, 700, "orange"))
b.append(text(x + 22, top + 182, "Jev: this may break it", 15, 400, "muted"))
x = xs[2]
b.append(text(x + 22, top + 96, "before the command runs", 15, 400, "muted"))
for k, (lab, dark) in enumerate((("Allow", False), ("Deny", True))):
    bx = x + 22 + k * 112
    b.append(f'<rect x="{bx}" y="{top + 116}" width="100" height="42" rx="9" fill="{{{"ink" if dark else "btn"}}}"/>')
    b.append(text(bx + 50, top + 143, lab, 17, 600, "card" if dark else "btnInk", "middle"))
b.append(text(x + 22, top + 186, "You decide.", 15, 400, "muted"))
write("guard", W, H, "".join(b), "The guard: Claude wants to run a command, jevmem checks it against your saved rules, and Claude Code asks you first.")

# ------------------------------------------------------------------ 3. results
W = 980
LABW, BARX, BARW = 250, 270, 560
groups = [
    ("Followed the project's decision", "of 72 sessions · higher is better", 72,
     [("No project memory", 28, "gray1"), ("jevmem", 66, "orange"), ("Hand-written CLAUDE.md", 67, "gray2")]),
    ("Tried a change the project forbids", "of 18 sessions · lower is better", 18,
     [("No project memory", 10, "gray1"), ("jevmem", 0, "orange"), ("Hand-written CLAUDE.md", 0, "gray2")]),
    ("Repeated an approach that had already failed", "of 15 sessions · lower is better", 15,
     [("No project memory", 3, "gray1"), ("jevmem", 0, "orange"), ("Hand-written CLAUDE.md", 0, "gray2")]),
]
b = []; y = 10
ROW, BH = 36, 22
for title, sub, n, rows in groups:
    b.append(text(10, y + 24, title, 20, 700))
    b.append(text(10, y + 48, sub, 15, 400, "muted"))
    y += 66
    # the full-length track, so a 0 still shows where the scale ends
    for name, v, col in rows:
        b.append(text(LABW, y + 16, name, 16, 600 if name == "jevmem" else 400, "ink", "end"))
        b.append(f'<rect x="{BARX}" y="{y}" width="{BARW}" height="{BH}" rx="4" fill="{{soft}}" stroke="{{line}}" stroke-width="1"/>')
        if v:
            b.append(f'<rect x="{BARX}" y="{y}" width="{BARW * v / n:.1f}" height="{BH}" rx="4" fill="{{{col}}}"/>')
        b.append(text(BARX + BARW + 14, y + 17, f"{v} of {n}", 17, 700 if name == "jevmem" else 400, "ink"))
        y += ROW
    y += 22
b.append(text(10, y + 6, "24 tasks in three small projects, 3 runs each: real Claude Code sessions with claude-sonnet-5.", 14, 400, "muted"))
H = y + 20
write("results", W, H, "".join(b), "A/B results: followed the project's decision 28 of 72 with no project memory, 66 of 72 with jevmem, 67 of 72 with a hand-written CLAUDE.md; tried a forbidden change 10 of 18 without, 0 of 18 with jevmem and with CLAUDE.md; repeated a failed approach 3 of 15 without, 0 of 15 with jevmem and with CLAUDE.md.")
print("ok", sorted(os.listdir(OUT)))

# ------------------------------------------------------------------ 4. how it decides
# Six steps since 0.7.1: dedupe (0.7.0) is folded into "Ask Jev" and "Thresholds", and the always-on mark (0.7.1) is step 6.
cw, ch, gap, top = 180, 250, 26, 20
W, H = 20 + 6 * cw + 5 * gap, 290
xs = [10 + i * (cw + gap) for i in range(6)]
steps = [
    ("Scrub", ["Secrets, emails and", "card-shaped numbers", "are removed before", "the turn leaves", "your machine."]),
    ("Ask Jev", ["A decision? A rule?", "A bug? Small talk?", "An injection? Said", "already? A rule for", "every change? Which", "saved line does it", "change?"]),
    ("Thresholds", ["Plain rules over the", "probabilities decide", "save or skip, in", "jevmem.config.json,", "not in a prompt.", "A restated line is", "not saved again."]),
    ("Write a line", ["The sentence with", "the fact and the one", "with its reason,", "whole up to 300", "characters."]),
    ("Supersede", ["The old line is", "tagged [superseded]", "and stays in the", "file, for history."]),
    ("Always-on", ["A rule every change", "must follow is", "marked, and reaches", "Claude at the start", "of every session,", "whatever the prompt."]),
]
b = []
for i, (x, (t, body)) in enumerate(zip(xs, steps)):
    b.append(card(x, top, cw, ch))
    b.append(step(x + 30, top + 34, i + 1))
    b.append(text(x + 54, top + 40, t, 18, 700))
    for k, ln in enumerate(body):
        b.append(text(x + 18, top + 84 + k * 24, ln, 15, 400, "ink"))
    if i < 5:
        b.append(arrow(x + cw + gap / 2 - 6, top + ch / 2))
write("how-it-decides", W, H, "".join(b), "How jevmem decides: scrub secrets, ask Jev typed questions, apply thresholds in code (a restated line is not saved again), write one line, supersede the old line, and mark a rule for every change always-on.")

# ------------------------------------------------------------------ 5. the benchmark
rows = [("jevmem 0.7.7", 160, "98.5%", "$0.000189", True), ("Claude Opus 5.5", 2784, "97.0%", "$0.005186", False),
        ("Gemini 3.8 Flash", 2850, "92.4%", "$0.001174", False), ("GPT-6 Luna", 2927, "93.9%", "$0.000089", False),
        ("Grok 4.7", 3320, "90.9%", "$0.004602", False), ("GPT-6 Astra", 3469, "98.5%", "$0.007489", False),
        ("Claude Fable 5.1", 4290, "95.5%", "$0.013256", False)]
LABW, BX, BW, MAXMS = 190, 205, 430, 4500
C1, C2 = BX + BW + 170, BX + BW + 220
W = C2 + 140
b = [text(10, 30, "Time to decide one message", 20, 700),
     text(10, 54, "median, on 66 held-out turns · each decider given the same turns", 15, 400, "muted"),
     text(C1, 92, "save/skip", 15, 600, "muted", "end"), text(C2 + 110, 92, "cost per decision", 15, 600, "muted", "end")]
y = 108
for name, ms, acc, cost, me in rows:
    w8 = 700 if me else 400
    b.append(text(LABW, y + 17, name, 16, 600 if me else 400, "ink", "end"))
    b.append(f'<rect x="{BX}" y="{y}" width="{BW}" height="22" rx="4" fill="{{soft}}" stroke="{{line}}" stroke-width="1"/>')
    b.append(f'<rect x="{BX}" y="{y}" width="{max(6, BW * ms / MAXMS):.1f}" height="22" rx="4" fill="{{{"orange" if me else "gray2"}}}"/>')
    b.append(text(BX + BW + 12, y + 17, f"{seconds(ms)} s", 16, w8))
    b.append(text(C1, y + 17, acc, 16, w8, "ink", "end"))
    b.append(text(C2 + 110, y + 17, cost, 16, w8, "ink", "end"))
    y += 38
b.append(text(10, y + 14, "Each row is a single run: the LLM rows on 2026-09-23, jevmem's on 2026-11-08. Three LLMs were better at picking the kind of line.", 14, 400, "muted"))
H = y + 30
write("benchmark", W, H, "".join(b), "Median time to decide one message on 66 held-out turns: jevmem 0.16 s, six current LLMs 2.78 to 4.29 s; save/skip accuracy and cost per decision alongside.")
print("ok2", sorted(os.listdir(OUT)))

# ------------------------------------------------------------------ 6. the rulebook: one file in the repo, read by your agents (0.7.7 README)
def mono(x, y, s, size=14, weight=400, fill="ink"):
    return text(x, y, s, size, weight, fill, font=MONO)

def bubble(x, y, w, s, size=16):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="44" rx="14" fill="{{soft}}" stroke="{{line}}"/>'
            + text(x + 16, y + 28, s, size, 600))

W, H = 1000, 372
b = []
# left: your chats
b.append(card(10, 20, 250, 250)); b.append(step(42, 56, 1)); b.append(text(66, 62, "You chat as usual", 19, 700))
b.append(bubble(28, 92, 214, "We use pnpm, not npm.", 15))
b.append(bubble(28, 146, 214, "Don't hand-edit migrations.", 15))
b.append(text(30, 226, "in Claude Code, Cursor", 15, 400, "muted"))
b.append(text(30, 246, "or Codex", 15, 400, "muted"))
b.append(arrow(274, 145))
# centre: the file
b.append(card(300, 20, 400, 250)); b.append(step(332, 56, 2)); b.append(mono(356, 62, "JEVMEM.md", 18, 700))
b.append(text(356, 84, "one file in your repo, shared through git", 14, 400, "muted"))
lines = [("[decision]", "We use pnpm, not npm."), ("[constraint]", "Don't hand-edit migrations."),
         ("[dead-end]", "In-memory cache broke the"), ("", "build: keep Redis.")]
yy = 128
for tag, body in lines:
    if tag:
        b.append(mono(320, yy, tag, 14, 700, "orange"))
    b.append(mono(320 + (len(tag) + 1) * 8.4 if tag else 320 + 11 * 8.4, yy, body, 14))
    yy += 30
b.append(arrow(714, 145))
# right: your agents
b.append(card(740, 20, 250, 250)); b.append(step(772, 56, 3)); b.append(text(796, 62, "Your agents read it", 19, 700))
agents = [("Claude Code", "every prompt"), ("Cursor", "the jevmem plugin"), ("Codex", "over MCP"), ("Claude Desktop", "over MCP")]
for k, (name, how) in enumerate(agents):
    b.append(text(760, 108 + k * 42, name, 17, 700))
    b.append(text(760, 127 + k * 42, how, 14, 400, "muted"))
# bottom: the guard
b.append(f'<rect x="10" y="292" width="980" height="64" rx="14" fill="{{card}}" stroke="{{orange}}" stroke-width="2"/>')
b.append(text(34, 331, "The guard", 19, 700, "orange"))
b.append(text(140, 331, "In Claude Code, each command and file edit is checked against these rules before it runs.", 17, 500))
write("rulebook", W, H, "".join(b), "jevmem: you chat as usual in Claude Code, Cursor or Codex; decisions, rules and failed approaches go to JEVMEM.md in your repo, shared through git; your agents read it; and the guard checks Claude's commands and edits against the rules before they run.")

# ------------------------------------------------------------------ 7. scenario 1: the guard on an edit
cw, ch, gap, top = 300, 200, 40, 20
W, H = 20 + 3 * cw + 2 * gap, 250
xs = [10 + i * (cw + gap) for i in range(3)]
b = []
titles = ["Claude wants to edit", "jevmem checks it", "Claude Code asks you"]
for i, x in enumerate(xs):
    b.append(card(x, top, cw, ch)); b.append(step(x + 32, top + 36, i + 1)); b.append(text(x + 56, top + 42, titles[i], 19, 700))
    if i < 2:
        b.append(arrow(x + cw + gap / 2 - 6, top + ch / 2))
x = xs[0]
b.append(f'<rect x="{x + 20}" y="{top + 76}" width="{cw - 40}" height="78" rx="10" fill="#15161a"/>')
b.append(f'<text x="{x + 36}" y="{top + 108}" font-family="{MONO}" font-size="17" fill="#f6f5f1">Edit db/migrations/</text>')
b.append(f'<text x="{x + 36}" y="{top + 136}" font-family="{MONO}" font-size="17" fill="#f6f5f1">  0042_users.sql</text>')
b.append(text(x + 22, top + 182, "three weeks later, a fresh session", 15, 400, "muted"))
x = xs[1]
b.append(text(x + 22, top + 96, "Your team's rule, in JEVMEM.md:", 15, 400, "muted"))
b.append(text(x + 22, top + 128, "Don't hand-edit migrations.", 18, 700, "orange"))
b.append(text(x + 22, top + 182, "Jev: this may break it", 15, 400, "muted"))
x = xs[2]
b.append(text(x + 22, top + 96, "before the edit runs", 15, 400, "muted"))
for k, (lab, dark) in enumerate((("Allow", False), ("Deny", True))):
    bx = x + 22 + k * 112
    b.append(f'<rect x="{bx}" y="{top + 116}" width="100" height="42" rx="9" fill="{{{"ink" if dark else "btn"}}}"/>')
    b.append(text(bx + 50, top + 143, lab, 17, 600, "card" if dark else "btnInk", "middle"))
b.append(text(x + 22, top + 186, "You decide.", 15, 400, "muted"))
write("guard-edit", W, H, "".join(b), "The guard on an edit: Claude wants to edit a generated migration, jevmem finds the team's rule in JEVMEM.md, and Claude Code asks you before the edit runs.")

# ------------------------------------------------------------------ 8. scenario 2: the team, through git
b = []
titles = ["Monday", "Through git", "Tuesday"]
for i, x in enumerate(xs):
    b.append(card(x, top, cw, ch)); b.append(step(x + 32, top + 36, i + 1)); b.append(text(x + 56, top + 42, titles[i], 19, 700))
    if i < 2:
        b.append(arrow(x + cw + gap / 2 - 6, top + ch / 2))
x = xs[0]
b.append(bubble(x + 20, top + 80, cw - 40, "We use pnpm, not npm.", 17))
b.append(text(x + 22, top + 160, "You, in Claude Code.", 15, 400, "muted"))
b.append(text(x + 22, top + 182, "jevmem saves the line.", 15, 400, "muted"))
x = xs[1]
b.append(mono(x + 22, top + 92, "JEVMEM.md", 15, 600, "muted"))
b.append(mono(x + 22, top + 122, "[decision]", 15, 700, "orange"))
b.append(mono(x + 22, top + 146, "We use pnpm, not npm.", 15, 700))
b.append(text(x + 22, top + 182, "committed with your code", 15, 400, "muted"))
x = xs[2]
b.append(text(x + 22, top + 96, "Your teammate, in Cursor:", 15, 400, "muted"))
b.append(text(x + 22, top + 128, "the agent looks up the", 18, 600))
b.append(text(x + 22, top + 152, "rules and uses pnpm.", 18, 600, "orange"))
b.append(text(x + 22, top + 182, "with the jevmem plugin", 15, 400, "muted"))
write("team", W, H, "".join(b), "The team: on Monday you tell Claude Code we use pnpm, not npm; jevmem saves it to JEVMEM.md, committed with your code; on Tuesday your teammate's Cursor agent looks up the rules and finds it.")

# ------------------------------------------------------------------ 9. scenario 3: a failed approach, not tried twice
b = []
titles = ["You try it", "jevmem saves why", "Next month"]
for i, x in enumerate(xs):
    b.append(card(x, top, cw, ch)); b.append(step(x + 32, top + 36, i + 1)); b.append(text(x + 56, top + 42, titles[i], 19, 700))
    if i < 2:
        b.append(arrow(x + cw + gap / 2 - 6, top + ch / 2))
x = xs[0]
b.append(bubble(x + 20, top + 80, cw - 40, "Cache the API in memory?", 17))
b.append(text(x + 22, top + 160, "It broke the build.", 15, 600, "ink"))
b.append(text(x + 22, top + 182, "You keep Redis.", 15, 400, "muted"))
x = xs[1]
b.append(mono(x + 22, top + 92, "JEVMEM.md", 15, 600, "muted"))
b.append(mono(x + 22, top + 122, "[dead-end]", 15, 700, "orange"))
b.append(mono(x + 22, top + 146, "In-memory cache broke", 15, 700))
b.append(mono(x + 22, top + 168, "the build: keep Redis.", 15, 700))
x = xs[2]
b.append(text(x + 22, top + 96, "A prompt comes near it:", 15, 400, "muted"))
b.append(text(x + 22, top + 128, "Already tried:", 18, 700, "orange"))
b.append(text(x + 22, top + 152, "in-memory cache broke…", 18, 600))
b.append(text(x + 22, top + 182, "the reason comes back too", 15, 400, "muted"))
write("dead-end", W, H, "".join(b), "No repeated mistakes: an in-memory cache broke the build, jevmem saves it as a failed approach with the reason, and next month Claude gets it back as Already tried.")

# ------------------------------------------------------------------ 10. beside Claude Code's auto memory (0.7.7, by hand)
# Numbers: README's 0.7.7 table, the "after reading every miss by hand" and "left a change a rule forbids" rows
# (results/ab-automem-2026-11-02-audit.json).
W = 980
LABW, BARX, BARW = 250, 270, 560
arms = ["No memory", "Auto memory", "jevmem", "Both", "Same line in CLAUDE.md"]
on = {"jevmem", "Both"}
groups = [
    ("Followed a line taught in an earlier session", "of 54 sessions, every miss read by hand · higher is better", 54, [17, 49, 40, 48, 46]),
    ("Left a change a rule forbids in the code", "of 15 sessions, checked by hand · lower is better", 15, [9, 1, 0, 0, 2]),
]
b = []; y = 10
for title, sub, n, vals in groups:
    b.append(text(10, y + 24, title, 20, 700)); b.append(text(10, y + 48, sub, 15, 400, "muted"))
    y += 66
    for name, v in zip(arms, vals):
        me = name in on
        b.append(text(LABW, y + 16, name, 16, 600 if me else 400, "ink", "end"))
        b.append(f'<rect x="{BARX}" y="{y}" width="{BARW}" height="22" rx="4" fill="{{soft}}" stroke="{{line}}" stroke-width="1"/>')
        if v:
            b.append(f'<rect x="{BARX}" y="{y}" width="{BARW * v / n:.1f}" height="22" rx="4" fill="{{{"orange" if me else "gray2"}}}"/>')
        b.append(text(BARX + BARW + 14, y + 17, f"{v} of {n}", 17, 700 if me else 400))
        y += 36
    y += 22
b.append(text(10, y + 6, "558 real Claude Code sessions on three new projects, claude-fable-5-1 and Claude Code 2.1.306, three runs (0.7.7).", 14, 400, "muted"))
H = y + 20
write("beside-auto-memory", W, H, "".join(b), "Beside Claude Code's auto memory (0.7.7, by hand): a line taught earlier was followed in 17 of 54 sessions with no memory, 49 with auto memory, 40 with jevmem, 48 with both and 46 with the line in CLAUDE.md; a change a rule forbids was left in the code in 9, 1, 0, 0 and 2 of 15.")
print("ok3", sorted(os.listdir(OUT)))
