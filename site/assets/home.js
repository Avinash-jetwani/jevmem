// jevmem docs site, home page: the copy button, Figure 1's squares and the terminal example. The light and dark
// switch is site.js's. No request leaves this site, and every text the page shows is in its HTML before this runs.
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Copy the install commands.
  const copy = document.getElementById("copy");
  const cmds = document.getElementById("cmds");
  if (copy && cmds) {
    copy.addEventListener("click", () => {
      const select = () => {
        const range = document.createRange();
        range.selectNodeContents(cmds);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      };
      try {
        navigator.clipboard.writeText("npm install -g jevmem\njevmem setup").then(() => {
          copy.textContent = "COPIED";
          setTimeout(() => (copy.textContent = "COPY"), 1500);
        }, select);
      } catch {
        select();
      }
    });
  }

  // Figure 1: fifteen squares a row, one per session; the sessions that left the change in fill one by one.
  const rows = [...document.querySelectorAll(".srow")];
  for (const r of rows) {
    const cells = r.querySelector(".cells");
    for (let i = 0; i < 15; i++) {
      const c = document.createElement("i");
      c.className = "c";
      cells.appendChild(c);
    }
  }
  let timers = [];
  const fill = (animate) => {
    timers.forEach(clearTimeout);
    timers = [];
    for (const r of rows) {
      const n = Number(r.dataset.n);
      const us = r.classList.contains("us");
      r.querySelectorAll(".c").forEach((c, i) => {
        c.classList.remove("on", "ok");
        const cls = us ? "ok" : i < n ? "on" : null;
        if (!cls) return;
        if (!animate) c.classList.add(cls);
        else timers.push(setTimeout(() => c.classList.add(cls), (us ? 1300 : 0) + i * 90));
      });
    }
  };
  fill(false);
  const fig = document.getElementById("sessions");
  if (!reduce && fig && "IntersectionObserver" in window) {
    // Replay once when the figure first comes into view; it is complete before that.
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        fill(true);
      }
    });
    io.observe(fig);
  }
  const replay = document.getElementById("replay");
  if (replay) replay.addEventListener("click", () => fill(!reduce));

  // The terminal: three scenes of one rule, typed out in turn; a click on a step replays it.
  const screen = document.getElementById("screen");
  if (!screen) return;
  const buttons = [...document.querySelectorAll(".term .ctl button")];
  const scenes = [
    [
      ["d", "# monday, in a chat"],
      ["u", "> Don't hand-edit db/migrations/. Those files are generated."],
      ["t", "  Got it. I'll generate migrations instead of editing them."],
      ["d", ""],
      ["d", "  jevmem asks Jev if it's worth keeping, then writes one line:"],
      ["o", "  + JEVMEM.md"],
      ["o", "  - [constraint] Don't hand-edit db/migrations/: those files are generated."],
      ["d", ""],
      ["d", '$ git add JEVMEM.md && git commit -m "Save project rules"'],
    ],
    [
      ["d", "# three weeks later, a fresh session"],
      ["u", "> Add a phone column to the users table."],
      ["d", ""],
      ["d", "  jevmem sends the matching line back with the prompt:"],
      ["o", "  [constraint] Don't hand-edit db/migrations/: those files are generated."],
      ["d", ""],
      ["t", "  I'll create a new migration with the generator, since files"],
      ["t", "  in db/migrations/ are generated."],
    ],
    [
      ["d", "# if Claude is about to break the rule anyway"],
      ["t", "  Edit  db/migrations/0042_users.sql"],
      ["d", ""],
      ["w", "jevmem: this may break a saved rule:"],
      ["w", '"Don\'t hand-edit db/migrations/: those files are generated."'],
      ["w", "(JEVMEM.md)"],
      ["d", ""],
      ["t", "  Allow   [Deny]"],
      ["d", "  Claude Code stops and asks you first."],
    ],
  ];
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const render = (lines, upto) => {
    let html = "";
    for (const [kind, full] of lines) {
      let text = full;
      if (upto != null) {
        if (upto <= 0) break;
        if (text.length > upto) text = text.slice(0, upto);
        upto -= full.length + 1;
      }
      html += (kind === "t" ? esc(text) : `<span class="${kind}">${esc(text)}</span>`) + "\n";
    }
    return html + '<span class="caret"></span>';
  };
  let scene = 0;
  let typer = null;
  let next = null;
  let auto = !reduce;
  const play = (i, animate) => {
    scene = i;
    clearInterval(typer);
    clearTimeout(next);
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.go) === i)));
    const lines = scenes[i];
    if (!animate) {
      screen.innerHTML = render(lines);
      return;
    }
    const total = lines.reduce((a, l) => a + l[1].length + 1, 0);
    let c = 0;
    typer = setInterval(() => {
      c += 3;
      screen.innerHTML = render(lines, c);
      if (c >= total) {
        clearInterval(typer);
        if (auto) next = setTimeout(() => play((scene + 1) % 3, true), 2800);
      }
    }, 16);
  };
  buttons.forEach((b) =>
    b.addEventListener("click", () => {
      auto = false;
      play(Number(b.dataset.go), true);
    }),
  );
  if (auto) next = setTimeout(() => play(0, true), 900);
})();
