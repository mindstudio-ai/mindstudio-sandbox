---
name: Web Interface
type: web
tooling:
  framework: react
  bundler: vite
  language: typescript
  styling: styled-components
  animation: framer-motion (page transitions, carousel, tap feedback)
  fonts: Cormorant Garamond (Google Fonts, weights 300 and 400)
  file structure: single App.tsx — no router, no pages directory
  avoid: tailwind, css modules, component libraries, sans-serif fonts, color, loud UI, scrolling
  prefer: serif typography, black-and-white palette, full-viewport layouts, generous whitespace, opacity for hierarchy
---

# Web Interface

A full-viewport app with three modes: browse, compose, and streaming.
No scrolling — every mode fills the screen. Transitions between modes
are smooth full-page crossfades.

## Browse Mode

One haiku fills the entire viewport. Giant centered serif text
(clamp 24–36px) with generous line-height (1.8). The topic appears
below as a tiny uppercase label. Navigate between haikus with
prev/next text links and a dot indicator at the bottom.

A floating black circular "+" button (bottom-right) opens compose mode.
A "remove" link (top-right, near-invisible) deletes the current haiku.

Keyboard: arrow keys navigate between haikus.

~~~
When there are no haikus, the browse mode shows an empty state:
"no haikus yet" in italic with "tap + to write one" below it.
The + button is still visible.
~~~

## Compose Mode

The page transitions to a centered input field. A small "new haiku"
label at top, a large italic input field in the middle, and two
text links below: "cancel" (returns to browse) and "generate"
(starts generation). Enter key also triggers generate.

The input auto-focuses on enter.

## Streaming Mode

While the AI writes, the page shows the haiku materializing in
real time — centered, large serif text at reduced opacity. A small
"writing..." label at the bottom. When complete, the page transitions
back to browse mode with the new haiku as the first card.

## Empty State

"no haikus yet" — italic, dim, centered. "tap + to write one" as
a tiny uppercase hint below.

## Navigation

Dot indicators are capped at 7 visible, centered around the current
index, so the nav doesn't get unwieldy with many haikus.
