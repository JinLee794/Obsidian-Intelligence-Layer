# Animation Overrides Reference

> How to control pacing, text effects, and visual quality using the `animation` object on any scene.

---

## Animation Object Schema

Every scene accepts an optional `animation` object:

```json
{
  "type": "text-reveal",
  "duration": 6,
  "data": { "headline": "Ship faster with <em>confidence</em>" },
  "animation": {
    "easing": "spring",
    "textEffect": "word-reveal",
    "stagger": 0.1,
    "direction": "up",
    "speed": 1.0,
    "delay": 0.3,
    "exitAnimation": "fade",
    "pacing": { "entrance": 0.3, "hold": 0.5, "exit": 0.2 },
    "emphasis": [0, 2]
  }
}
```

| Field | Type | Default | Range | Purpose |
|-------|------|---------|-------|---------|
| `easing` | enum | `easeOut` | See table below | Global easing for entrance animations |
| `textEffect` | enum | none | See table below | Text display mechanism |
| `stagger` | number | varies | seconds | Delay between staggered items |
| `direction` | enum | `up` | `up`, `down`, `left`, `right` | Direction elements enter from |
| `speed` | number | 1 | 0.1–5 | Timeline speed multiplier |
| `delay` | number | 0 | 0+ | Delay before entrance begins |
| `exitAnimation` | enum | `none` | `fade`, `slide-up`, `slide-down`, `scale-down`, `none` | How scene exits |
| `pacing.entrance` | number | 0.3 | 0–1 | Fraction of duration for entrance |
| `pacing.hold` | number | 0.5 | 0–1 | Fraction showing final state |
| `pacing.exit` | number | 0.2 | 0–1 | Fraction for exit |
| `emphasis` | number[] | [] | — | Indices of items to pulse/highlight |

---

## Easing Types

| Name | Feel | Best For |
|------|------|----------|
| `linear` | Constant speed | Progress bars, loading |
| `easeOut` | Fast start, gentle stop | **Default. Safe for anything** |
| `easeInOut` | Smooth start and end | Transitions, transforms |
| `spring` | Overshoot bounce-back | Cards, buttons, general emphasis |
| `bouncy` | Elastic wobble | Playful, attention-grabbing |
| `elastic` | Tight elastic snap | Tech demos, precise data |
| `slow` | Dramatic slow-motion | Cinematic reveals |
| `snap` | Sharp decisive movement | Strong professional |
| `power1` | Gentle, subtle | Backgrounds, ambient |
| `power4` | Aggressive, punchy | Impactful stat reveals |
| `circ` | Circular arc motion | Geometric, clean |
| `expo` | Exponential acceleration | Dramatic entrances |
| `steps` | Stepped/discrete frames | Retro, technical only |

---

## Text Effects

| Effect | Description | Best For | Avoid With |
|--------|-------------|----------|------------|
| `typewriter` | Characters appear one-by-one with cursor | Code, technical content | Long text (>100 chars at <5s) |
| `word-reveal` | Words fade up individually | Headlines, key messages | Short durations (<3s) |
| `char-cascade` | Characters cascade with 3D rotation | Dramatic title reveals | Gradient text (use `word-reveal`) |
| `fade-lines` | Lines fade in sequentially | Body text, paragraphs | Single-line content |
| `highlight-sweep` | Highlight sweeps across text | Key phrases, emphasis | Multiple paragraphs |
| `counter` | Number counts up from 0 | Metrics, statistics | Non-numeric content |

---

## Pacing Strategies

Pacing controls how the scene's duration is divided between entrance animation, holding the final state, and exit animation. Values are fractions (0–1) and should sum to 1.

### Short scenes (3–4s) — Fast pace
```json
"pacing": { "entrance": 0.5, "hold": 0.5, "exit": 0 }
```
No exit animation. All motion up front, hold the rest.

### Standard scenes (5–7s) — Balanced
```json
"pacing": { "entrance": 0.3, "hold": 0.5, "exit": 0.2 }
```
Default feel. Entrance completes in first third.

### Long/complex scenes (8–15s) — Deliberate
```json
"pacing": { "entrance": 0.2, "hold": 0.6, "exit": 0.2 }
```
Slower stagger so items appear gradually. More hold time to read.

### Dramatic reveal — Cinematic
```json
{
  "textEffect": "word-reveal",
  "easing": "slow",
  "delay": 0.5,
  "speed": 0.7,
  "exitAnimation": "fade"
}
```

---

## Scene Type × Animation Pairings

Recommended pairings by scene category. Use these as defaults; only override for specific creative intent.

### Data-heavy scenes (`kpi-scorecard`, `table`, `chart-*`, `stat-counter`)
- `stagger: 0.08–0.15` so items don't pile up
- `easing: "spring"` for cards, `"easeOut"` for bars/lines
- Longer hold: `pacing.hold: 0.6`
- `speed: 0.9` gives readers time to absorb numbers

### Narrative scenes (`text-reveal`, `quote-highlight`, `section-header`)
- `textEffect: "word-reveal"` or `"char-cascade"` for drama
- `easing: "slow"` or `"expo"` for cinematic feel
- `exitAnimation: "fade"` for smooth transitions
- `delay: 0.3` to let the previous scene settle

### List scenes (`bullet-list`, `action-items`, `comparison`)
- `stagger: 0.12–0.2` — enough gap to read each item
- `direction: "left"` for left-aligned lists
- `easing: "spring"` for playful, `"easeOut"` for corporate
- `emphasis: [0, 2]` to highlight key items

### Title/transition scenes (`title-card`, `section-header`, `closing`)
- `textEffect: "word-reveal"` or `"char-cascade"`
- `easing: "spring"` or `"expo"` for impact
- `exitAnimation: "slide-up"` before content scenes
- Keep `duration: 4–5s`

### Counter/metric scenes (`stat-counter`, `kpi-scorecard`)
- `easing: "power4"` makes numbers feel punchy
- `stagger: 0.15` between cards
- No text effect needed — count-up is built in
- `speed: 0.8` to savor the count-up

### Quick Pairing Table

| Scene Type | Recommended Override | Example |
|------------|---------------------|---------|
| `title-card` | `easing: "spring"` | `{ "easing": "spring" }` |
| `chart-bar` | stagger + spring | `{ "stagger": 0.1, "easing": "spring" }` |
| `chart-line` | spring | `{ "easing": "spring" }` |
| `chart-donut` | spring | `{ "easing": "spring" }` |
| `kpi-scorecard` | stagger + elastic | `{ "stagger": 0.12, "easing": "elastic" }` |
| `stat-counter` | stagger + power4 | `{ "stagger": 0.15, "easing": "power4" }` |
| `bullet-list` | stagger + direction | `{ "stagger": 0.15, "easing": "spring", "direction": "left" }` |
| `action-items` | stagger + spring | `{ "stagger": 0.12, "easing": "spring" }` |
| `comparison` | stagger + direction | `{ "stagger": 0.08, "direction": "left" }` |
| `table` | stagger + spring | `{ "stagger": 0.08, "easing": "spring" }` |
| `pipeline-funnel` | stagger + bouncy | `{ "stagger": 0.12, "easing": "bouncy" }` |
| `milestone-timeline` | stagger + up | `{ "stagger": 0.1, "easing": "spring" }` |
| `text-reveal` | textEffect + slow | `{ "textEffect": "word-reveal", "easing": "slow" }` |
| `quote-highlight` | slow + delay | `{ "easing": "slow", "delay": 0.3 }` |
| `code-terminal` | none needed | Built-in typing animation |
| `tool-call` | stagger + spring | `{ "stagger": 0.08, "easing": "spring" }` |
| `logic-flow` | none needed | Built-in topological animation |
| `section-header` | optional textEffect | `{ "textEffect": "word-reveal" }` |
| `closing` | spring + exit | `{ "easing": "spring", "exitAnimation": "fade" }` |
