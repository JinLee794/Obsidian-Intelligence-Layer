---
name: showrunner-video
description: 'Generate Showrunner storyboard JSON for rendering animated MP4 videos. Use when asked to create a video, render a presentation, build an animated recap, or produce visual content from data. Covers scene type selection, animation overrides, asset references, branding, and storyboard structure. Triggers: create video, render video, make a video, video recap, animated presentation, showrunner, storyboard, render MP4, video from data.'
argument-hint: 'Describe what the video should contain — topic, data, audience, tone'
allowed-tools: mcp_showrunner_*
---

# Showrunner Video Generation

Generate well-structured storyboard JSON that the Showrunner MCP server renders into polished MP4 videos with GSAP-powered animations.

> **MANDATORY**: Before executing any workflow step, read the corresponding reference document listed below. Do not call MCP tools without following the workflow. Reference docs contain required schemas, validation rules, and anti-patterns.

## When to Use

- User asks to create, render, or produce a video
- User wants an animated recap, briefing, or presentation
- User has data (KPIs, charts, timelines) they want visualized
- User mentions Showrunner, storyboard, or render_video

## Reference Documents

Load these on demand — do NOT read all at once. Read only the reference needed for the current workflow step.

| Reference | When to Read | Content |
|-----------|-------------|---------|
| [storyboard-schema](references/storyboard-schema.md) | Step 2 — building storyboard JSON | Top-level fields, scene object structure, assets, branding |
| [scene-types](references/scene-types.md) | Step 2 — choosing scene types and populating `data` | All 18+ scene types with full data schemas and examples |
| [animation-guide](references/animation-guide.md) | Step 3 — adding animation overrides | Easing types, text effects, pacing strategies, scene×animation pairings |
| [guardrails](references/guardrails.md) | Always — review before calling render | Duration limits, anti-patterns, error handling, common mistakes |

## Workflow

Follow these steps in order for every video generation request.

### Step 1: Gather Requirements

Determine from the user's request:
- **Content**: What data, message, or story should the video convey?
- **Audience/tone**: Corporate, casual, technical, cinematic?
- **Branding**: Logo URL, accent color, theme preference?
- **Output**: MP4 (default), GIF, or HTML preview?

If the request is ambiguous, ask one clarifying question — do not guess at data the user hasn't provided.

### Step 2: Build the Storyboard

1. Read [storyboard-schema](references/storyboard-schema.md) for the JSON envelope structure.
2. Read [scene-types](references/scene-types.md) to select appropriate types and populate `data` fields.
3. Call `mcp_showrunner_list_scene_types` if you need to confirm available types or their exact data schemas.
4. Construct the storyboard JSON. Use the scene routing table below to pick types.

### Step 3: Add Animation (Optional)

Read [animation-guide](references/animation-guide.md) for easing, text effects, and pacing recommendations. Only add `animation` overrides when the user requests specific motion, or when default animations would be inadequate for the content. The built-in defaults are good for most cases.

### Step 4: Validate

**ALWAYS call `mcp_showrunner_validate_storyboard` before rendering.** This catches schema errors, missing required fields, and invalid references without the cost of a full render. Fix any reported issues before proceeding.

### Step 5: Render

Read [guardrails](references/guardrails.md) before calling render tools.

| Tool | Purpose | When |
|------|---------|------|
| `mcp_showrunner_render_video` | Full render → MP4 | Default final output |
| `mcp_showrunner_render_scene` | Render a single scene → MP4 | Testing one scene type |
| `mcp_showrunner_render_gif` | Render → animated GIF | Previews, docs, lightweight sharing |
| `mcp_showrunner_preview_storyboard` | Instant HTML preview | Quick iteration, no ffmpeg needed |

For storyboards with >10 scenes or >60s total duration, use `mcp_showrunner_preview_storyboard` first for a quick check, then render the final MP4.

## Scene Type Routing

Use this table to select scene types. For full data schemas, read [scene-types](references/scene-types.md).

| Category | Type | Use For |
|----------|------|---------|
| **Narrative** | `title-card` | Opening slide with logo |
| | `section-header` | Chapter dividers |
| | `closing` | Closing slide with CTA |
| | `text-reveal` | Dramatic text moments |
| | `quote-highlight` | Pull quotes |
| **Data** | `chart-bar` | Bar charts (multi-dataset) |
| | `chart-line` | Line charts with area fills |
| | `chart-donut` | Donut/pie charts |
| | `kpi-scorecard` | Metric cards with trends |
| | `stat-counter` | Large animated counters |
| **Lists** | `bullet-list` | Bulleted items with icons |
| | `action-items` | Checklist with owners |
| | `comparison` | Side-by-side pro/con |
| | `table` | Data tables with highlights |
| **Visual** | `pipeline-funnel` | Sales/conversion funnels |
| | `milestone-timeline` | Project timelines |
| | `code-terminal` | Code walkthroughs |
| | `image-card` | Full-bleed images |
| | `scene-showcase` | Card grids |
| **Technical** | `tool-call` | API/tool call request→response |
| | `logic-flow` | Flowcharts and decision trees |

## Critical Rules

1. **ALWAYS validate before rendering** — `validate_storyboard` is fast; render is slow and expensive.
2. **Total duration should be 30–90s** for most videos. Under 15s feels rushed; over 120s loses attention.
3. **3–10 scenes is the sweet spot.** 1–2 scenes is a slide, not a video. >15 scenes is a marathon.
4. **Each scene needs 3–8s duration.** Under 2s is unreadable; over 12s is boring.
5. **Do not over-animate.** Save dramatic effects (`textEffect`, custom easing, exit animations) for 1–2 key moments. Defaults are good.
6. **Use `$asset:key` references** for images used in multiple scenes — never duplicate URLs.
7. **Confirm output path with the user** before rendering if not obvious from context.

### Image-Card Effects

When using `image-card`, set the `effect` field for motion:

| Effect | Description |
|--------|-------------|
| `ken-burns` | Slow zoom + pan (default, cinematic) |
| `zoom-in` | Gradual zoom into center |
| `pan-left` | Slow horizontal pan left |
| `pan-right` | Slow horizontal pan right |
| `static` | No motion |

## Procedure

### 1. Understand the Request
- What data/content needs to be in the video?
- What's the audience? (executive → `slow`/`expo` easing; team → `spring`/`bouncy`)
- How long should it be? (30s quick recap vs 3min deep-dive)

### 2. Call `list_scene_types`
Get the latest scene types and schemas. Don't assume — verify.

### 3. Build the Storyboard

Follow this scene flow pattern:

```
title-card (5s) → [content scenes] → closing (5s)
```

For longer videos, add `section-header` (2-3s) between topic groups.

**Duration guidelines:**
- Title/closing: 4–5s
- Section headers: 2–3s
- Data scenes (charts, KPIs, tables): 6–8s
- Code terminals: 8–12s (need time to read)
- Text/quotes: 4–6s
- Comparisons: 6–7s

**Transition guidelines:**
- Use `fade` between same-topic scenes
- Use `slide-left` or `slide-up` for section changes
- Use `fade` for title and closing

### 4. Add Animation Variety
- Don't use the same easing on every scene
- Use `textEffect` sparingly — 1-2 key moments, not every scene
- Add `exitAnimation: "fade"` before major section changes
- Vary `stagger` values: 0.08 for data, 0.12-0.18 for lists

### 5. Validate First
Call `validate_storyboard` before rendering. Fix any errors.

### 6. Render
Call `render_video` with quality `medium` (default) or `fast` (for iteration).

## Anti-Patterns

1. **Don't use `char-cascade` on gradient text** — it breaks `background-clip: text`. Use `word-reveal` instead.
2. **Don't use `bouncy` on data scenes** — elastic wobble on charts looks unprofessional.
3. **Don't set `speed` below 0.5** — timeline gets sluggish.
4. **Don't use `typewriter` with short durations** — characters fly by too fast at <4s with long text.
5. **Don't create >15 scenes without section headers** — viewer loses orientation.
6. **Don't set stagger > 0.3** unless you have very few items.
7. **Don't skip `validate_storyboard`** — rendering is slow; catch errors early.
8. **Don't hardcode base64 images** — use the `assets` map with `$asset:key` references to keep the storyboard small.

## Example: Sprint Recap Video

```json
{
  "title": "Sprint 25 Recap",
  "theme": "microsoft",
  "branding": { "logo": "$asset:logo" },
  "assets": { "logo": "https://cdn.example.com/team-logo.png" },
  "scenes": [
    {
      "type": "title-card",
      "duration": 5,
      "transition": "fade",
      "data": { "title": "Sprint 25 Recap", "subtitle": "Platform Engineering", "date": "April 2026", "image": "$asset:logo" },
      "animation": { "easing": "spring" }
    },
    {
      "type": "kpi-scorecard",
      "duration": 7,
      "transition": "fade",
      "data": {
        "kpis": [
          { "label": "Velocity", "value": 67, "unit": "pts", "trend": "up", "animateCount": true },
          { "label": "Cycle Time", "value": 3.2, "unit": "days", "trend": "down", "animateCount": true },
          { "label": "Deploys", "value": 14, "unit": "/wk", "trend": "up", "animateCount": true }
        ]
      },
      "animation": { "stagger": 0.15, "easing": "power4" }
    },
    {
      "type": "chart-bar",
      "duration": 7,
      "transition": "fade",
      "data": {
        "title": "Commits by Category",
        "labels": ["Features", "Fixes", "Docs", "Chores"],
        "datasets": [{ "label": "Commits", "values": [34, 15, 8, 6], "color": "#0078D4" }]
      },
      "animation": { "stagger": 0.1, "easing": "spring" }
    },
    {
      "type": "action-items",
      "duration": 6,
      "transition": "slide-left",
      "data": {
        "items": [
          { "text": "Ship v3 API migration", "owner": "Backend", "priority": "high" },
          { "text": "Fix flaky E2E tests", "owner": "QA", "priority": "high" },
          { "text": "Update runbook for on-call", "owner": "SRE", "priority": "normal" }
        ]
      },
      "animation": { "stagger": 0.12, "easing": "spring", "direction": "left" }
    },
    {
      "type": "closing",
      "duration": 5,
      "transition": "fade",
      "data": { "tagline": "Ship with confidence.", "cta": "Next sprint planning: Monday 9am", "image": "$asset:logo" },
      "animation": { "easing": "spring" }
    }
  ]
}
```
