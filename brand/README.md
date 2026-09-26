# jevmem brand kit (v1, September 2026)

The mark is a lowercase **j** whose dot is a **database**: every project remembers.
See `jevmem-brand-guide.pdf` (or `.png`) for the one-page guide.

## Which file for what

| Need | Use |
|---|---|
| Claude plugin icon | `plugin/icon.svg` → copy to `plugin/.claude-plugin/icon.svg` in the repo |
| X / GitHub / LinkedIn profile picture | `social/jevmem-avatar-400-ink.png` (or `-orange`) |
| GitHub repo social preview | `social/jevmem-github-social-1280x640-light.png` |
| Link preview (website, blog) | `social/jevmem-og-1200x630-*.png` |
| X header | `social/jevmem-x-header-1500x500-*.png` |
| LinkedIn banner | `social/jevmem-linkedin-banner-1584x396-*.png` |
| Feed post | `social/jevmem-square-post-1080x1080-*.png` |
| Story / Reel / Short cover | `social/jevmem-story-1080x1920-*.png` |
| Video intro / outro | `video/jevmem-logo-sting-1920x1080-*.mp4` (3.5 s, 60 fps) |
| Video title / end card | `video/jevmem-title-card-*`, `video/jevmem-end-card-*`, `video/jevmem-vertical-end-card-*` |
| Animate the logo yourself | `video/layers/` (icon base and the dot as separate SVGs, same 128 box) |
| README header, docs, slides | `lockup/svg/jevmem-lockup-horizontal-light.svg` (dark version for dark backgrounds) |
| Logo over a photo or video | `mark/png/jevmem-mark-white-2048h.png` (transparent) |
| Website favicon | `icon/favicon.ico` |
| App icon at any size | `icon/png/jevmem-icon-ink-{16…1024}.png` |

Folders: `icon/`, `mark/`, `wordmark/`, `lockup/` each have `svg/` (use these when you can; they scale to any size) and `png/` (transparent backgrounds).

## Colours
- Orange `#E0692A`, the accent
- Orange light `#F08A4B`, for the dot on dark backgrounds
- Ink `#111214`
- Paper `#F6F5F1`
- Grey `#62656C`, for secondary text

## Type
- Inter: Bold for headlines, SemiBold for taglines, Medium for body text.
- JetBrains Mono for commands.

Both fonts are free (SIL Open Font License), from rsms.me/inter and jetbrains.com/lp/mono.

## Rules
- Use the ink icon by default, and the orange icon for launches and promos.
- Keep backgrounds flat. Never add glows, shadows or outlines to the logo.
- Don't redraw, stretch or recolour the logo.
- Don't put Claude, Anthropic, Cursor or Codex logos next to it.
- Tagline: "Automatic project memory for Claude Code." with "Also works with Cursor and Codex." Any number you use must come from the README.
