# Usage plugin design system: "All clear"

The single source of truth for the Usage page's look. Every colour, size, radius and
duration in `app.tsx` and `tokens.css` comes from here.

## Theses (validated)

**Visual.** A calm monochrome page in bb's own ink and ground until something needs you:
the hero is one large Inter Variable 700 sentence ("Room for a big task.") with the window
figures below it; colour appears only as state, an amber `#F2B33D` or red `#F0524F` wash on the
window that needs attention; airy spacing (48px between groups); flat pill-shaped chips and
28px-radius tiles, no borders, no cards.

**Interaction.** Calm motion (200-300ms ease-out): the status sentence fades in when it changes;
a window that turns tight fades its wash in over 300ms with one 2px nudge, once; chips darken on
hover in 200ms; no scroll effects, nothing loops. The earlier polish thesis stays inside this
range: numbers roll and the trend line reshapes in 280ms on `cubic-bezier(0.2, 0, 0, 1)`.

**Allowed patterns:** the large status sentence, colour only as state, pill chips, the single
nudge when a window turns tight, rolling numbers, tabular figures, the activity heatmap, and
**model rank colours on model bars** (the user's amendment: the one place colour is not state, so
sessions that mix models stay readable).

**Amendment after the build (user, 2026-11-06):** "I like the colour theming of Classic and the
design of All clear." All clear keeps its layout, type, shapes and motion, but its data colour is
Classic's: the terracotta `--cu-accent` for the trend line, the terracotta heatmap steps, the
terracotta model ranks and Classic's cost-by-type colours. "Monochrome" in the visual thesis now
means the surfaces and text only. Amber and red stay as the state washes.

**Amendments at the design-system gate (user):** the window tiles keep the classic projection
line ("On pace to use 26% before it resets") and the Session tile keeps the block cost; model
bars keep `--cu-m0..m3`. All clear ships as an opt-in style next to Classic (header switch,
remembered per browser), so the user can switch back at any time.

**Mode:** redesign of the page's visual layer, inside bb's rules: the ground, ink, muted text
and overlay colours stay bb's tokens, so the page follows the user's bb theme (light and dark).

## Where it lives

`tokens.css` keeps the Classic tokens at `:root` and scopes every All clear token and rule under
`.cu-ac`, which `app.tsx` sets on the page root when the style is All clear.

## Colour

| Token | Value | Use |
|---|---|---|
| ground | bb `--background` | page |
| ink | bb `--foreground` | all text and data ink: the trend line, bars, heatmap |
| muted ink | bb `--muted-foreground` | labels, meta lines |
| `--cu-tile` | `color-mix(in oklab, var(--foreground) 5%, transparent)` | a calm tile or row |
| `--cu-tile-hover` | `color-mix(in oklab, var(--foreground) 9%, transparent)` | hovered row or chip |
| `--cu-tight` | `#F2B33D` | state: a window that is tight |
| `--cu-out` | `#F0524F` | state: a window that runs out before it resets |
| `--cu-tight-wash`, `--cu-out-wash` | state at 22% over transparent | tile wash |
| `--cu-tight-ink`, `--cu-out-ink` | amber 45% / red 70% mixed with bb ink | state-coloured text on the plain ground only |
| `--cu-m0` to `--cu-m3` | the classic terracotta rank steps | model bars (allowed exception) |
| `--cu-line` | `--cu-accent` (terracotta) | the trend line and its area |
| `--cu-h0` to `--cu-h4` | Classic's terracotta steps | heatmap, empty to full |

Data is drawn in Classic's terracotta palette; surfaces and text stay monochrome; amber and red mark state.

### Measured contrast (bb dark `#060606` / bb light `#f5f5f3`)

| Pair | Dark | Light |
|---|---|---|
| ink on ground | 18.1:1 | 15.6:1 |
| muted ink on ground | 7.8:1 | 6.9:1 |
| ink on a tile | 16.7:1 | 14.1:1 |
| ink on the tight wash | 12.1:1 | 13.8:1 |
| ink on the out wash | 14.3:1 | 12.1:1 |
| tight ink on ground | 14.6:1 | 5.9:1 |
| out ink on ground | 8.5:1 | 5.3:1 |

## Type

bb's own faces only: **Inter Variable** (chosen because it is bb's UI face: the page reads as part
of bb, and its tabular figures keep columns of numbers still while they roll) and **JetBrains Mono**
(model names and session ids only, because they are identifiers).

| Step | Size / line | Weight | Tracking | Use |
|---|---|---|---|---|
| status | 52px / 1.05 (36px under 768px) | 700 | -0.03em | the hero sentence |
| figure | 40px / 1 | 700 | -0.03em | window % left, the spend total |
| title | 15px / 1.4 | 600 | 0 | section titles |
| body | 14px / 1.5 | 400 | 0 | rows, verdicts |
| meta | 12px / 1.4 | 400 | 0 | resets in, labels |

All figures use `font-variant-numeric: tabular-nums`.

## Space

4px base. Scale: 4, 8, 12, 16, 24, 32, 48, 64. Groups are 48px apart; items inside a group
12 to 16px; a tile pads 24px.

## Shape and depth

| Token | Value | Use |
|---|---|---|
| `--cu-r-tile` | 28px | window tiles, the spend panel |
| `--cu-r-row` | 16px | list rows, expanded details |
| pill | 9999px | chips, segmented controls, the provider button, the search field |

No borders and no shadows on the page. Overlays (the provider menu, the chart tooltip) keep bb's
popover surface and shadow, because they float above the page.

## Motion

| Token | Value | Use |
|---|---|---|
| `--cu-calm` | 300ms ease-out | status sentence fade, state wash fade |
| `--cu-nudge` | 2px, inside the 300ms wash, once | a window turning tight |
| `--cu-chip` | 200ms ease-out | chip and row hover |
| `--cu-move` | 280ms `cubic-bezier(0.2, 0, 0, 1)` | rolling numbers, trend line reshape |
| `--cu-draw` | 300ms ease-out | trend line drawing in when the days change |
| `--cu-detail` / `--cu-detail-out` | 200ms ease-out / 120ms ease-in | row details |
| `--cu-menu-in` / `--cu-menu-out` | 160ms ease-out / 120ms ease-in | provider menu |
| `--cu-cross` | 90ms ease-out | chart crosshair |

Under `prefers-reduced-motion: reduce` every one of these is instant.

## Components

- **Window tile**: 28px radius, `--cu-tile` ground, or the state wash; label (meta), figure,
  verdict (body), projection line (meta), block cost on the Session tile (meta), "Resets in" (meta). Text on a wash stays bb ink: red ink on the red wash is
  4.1:1 in the light theme, under 4.5.
- **Chip**: pill, `--cu-tile` ground, body text, `--cu-tile-hover` on hover.
- **Segmented control**: pill track in `--cu-tile`, the selected option a pill in bb's ground with ink.
- **Row**: 16px radius, transparent, `--cu-tile` on hover and while open; 4px between rows.
- **States** on every control: default, hover (`--cu-tile-hover`), focus (bb's ring), active
  (`scale(0.98)`), disabled (50% opacity).
