"""README graphics for jevmem, five of them: how it works, the guard, the A/B results, how it decides, the benchmark.
Light and dark of each.
usage: python3 make_svgs.py <outdir>   (writes docs/img/*.svg under it)
Every measured number drawn here is from README.md at commit 471bc41 (v0.6.3), and the README has had the same
numbers since. The benchmark's times are that README's milliseconds drawn as seconds, to two places."""
import sys, os
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
b.append(text(x + 22, top + 185, "about 0.3 s, in the", 15, 400, "muted"))
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
cw, ch, gap, top = 190, 230, 30, 20
W, H = 20 + 5 * cw + 4 * gap, 270
xs = [10 + i * (cw + gap) for i in range(5)]
steps = [
    ("Scrub", ["Secrets, emails and", "card-shaped numbers", "are removed before", "the turn leaves your", "machine."]),
    ("Ask Jev", ["A decision? A rule?", "A bug? Small talk?", "An injection?", "Which saved line", "does it change?"]),
    ("Thresholds", ["Plain rules over the", "probabilities decide", "save or skip, in", "jevmem.config.json,", "not in a prompt."]),
    ("Write a line", ["At most 200", "characters, from the", "sentence with the fact", "and the one with", "its reason."]),
    ("Supersede", ["The old line is", "tagged [superseded]", "and stays in the", "file, for history."]),
]
b = []
for i, (x, (t, body)) in enumerate(zip(xs, steps)):
    b.append(card(x, top, cw, ch))
    b.append(step(x + 30, top + 34, i + 1))
    b.append(text(x + 54, top + 40, t, 18, 700))
    for k, ln in enumerate(body):
        b.append(text(x + 18, top + 88 + k * 26, ln, 15, 400, "ink"))
    if i < 4:
        b.append(arrow(x + cw + gap / 2 - 6, top + ch / 2))
write("how-it-decides", W, H, "".join(b), "How jevmem decides: scrub secrets, ask Jev typed questions, apply thresholds in code, write one line, supersede the old line.")

# ------------------------------------------------------------------ 5. the benchmark
rows = [("jevmem 0.6.0", 276, "98.5%", "$0.000157", True), ("Claude Opus 5.5", 2784, "97.0%", "$0.005186", False),
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
    b.append(text(BX + BW + 12, y + 17, f"{ms / 1000:.2f} s", 16, w8))
    b.append(text(C1, y + 17, acc, 16, w8, "ink", "end"))
    b.append(text(C2 + 110, y + 17, cost, 16, w8, "ink", "end"))
    y += 38
b.append(text(10, y + 14, "Each row is a single run: the LLM rows on 2026-09-23, jevmem's on 2026-09-30. Two LLMs were better at picking the kind of line.", 14, 400, "muted"))
H = y + 30
write("benchmark", W, H, "".join(b), "Median time to decide one message on 66 held-out turns: jevmem 0.28 s, six current LLMs 2.78 to 4.29 s; save/skip accuracy and cost per decision alongside.")
print("ok2", sorted(os.listdir(OUT)))
