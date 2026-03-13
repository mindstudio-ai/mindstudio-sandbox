---
name: Visual Identity
---

# Visual Identity

## Aesthetic

White and black. Stark, quiet, editorial. The feel of a meditation app
crossed with Co-Star — mystic minimalism. Nothing competes with the
poetry. Every element earns its place through restraint.

## Color Palette

| Token      | Value                      | Usage                     |
| ---------- | -------------------------- | ------------------------- |
| Background | `#fff`                     | Page background           |
| Text       | `#000`                     | Haiku text                |
| Muted      | `rgba(0, 0, 0, 0.35)`     | Headings, labels          |
| Dim        | `rgba(0, 0, 0, 0.25)`     | Placeholders, empty state |
| Ghost      | `rgba(0, 0, 0, 0.15)`     | Delete button, faint UI   |
| Divider    | `rgba(0, 0, 0, 0.06)`     | Section dividers          |

No accent color. No color at all. Only black at varying opacity on white.

## Typography

- **Primary font**: Cormorant Garamond (Google Fonts) — elegant,
  high-contrast serif. Used everywhere: haiku text, input, buttons, labels.
- **Fallback**: Georgia, Times New Roman, serif
- **Haiku text**: 22px, weight 300 (light), line-height 1.9, centered
- **Input**: 20px, weight 300, italic
- **Labels & buttons**: 12px, weight 400, uppercase, tracked (0.1–0.2em)
- **Title**: 14px, uppercase, tracked, muted — not prominent

## Spacing

Generous. The page breathes. 80px top padding. 72px between input and
content. 56px between haiku entries. The density is low on purpose —
each haiku should feel like its own moment.

## Interaction

- No borders on cards — haikus float in space
- Streaming text appears at 40% opacity, centered, then resolves into
  the final entry with a gentle fade-in (translateY 8px, 0.6s ease)
- Delete link is near-invisible (15% opacity), reveals on hover (50%)
- Input has only a bottom border that darkens on focus
- Generate button is lowercase, tracked, faint — not a loud CTA

## Anti-patterns

- No card borders or backgrounds
- No shadows
- No color accents
- No bold weights (nothing heavier than 500)
- No loud hover states
- Nothing that draws attention away from the words
