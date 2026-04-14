# Guardrails & Error Handling

Rules, limits, and common mistakes to avoid when generating Showrunner storyboards.

## Hard Limits

| Constraint | Limit | What Happens |
|------------|-------|--------------|
| Scene duration | 0.5–120s | Zod validation rejects out-of-range values |
| Minimum scenes | 1 | Validation error if `scenes` array is empty |
| FPS values | 24, 30, 60 | Validation error on other values |
| Animation speed | 0.1–5.0 | Clamped by schema |
| Pacing fractions | 0–1 each | Must sum to ≤ 1 |

## Recommended Limits

| Constraint | Guideline | Why |
|------------|-----------|-----|
| Total duration | 30–90s | Under 15s feels like a slide; over 120s loses attention |
| Scene count | 3–10 | 1–2 is a slide, >15 is exhausting |
| Per-scene duration | 3–8s | Under 2s is unreadable; over 12s is boring |
| Data items per scene | ≤ 8 | More items need longer duration or feel rushed |
| Stagger value | 0.05–0.25 | >0.3 with many items delays entrance too long |

## Mandatory Workflow Rules

1. **ALWAYS call `validate_storyboard` before `render_video`**. Validation is instant; rendering takes minutes and consumes resources. Never skip this step.

2. **Confirm output path** before rendering if the user hasn't specified one. Default paths may overwrite existing files.

3. **Use `preview_storyboard`** for storyboards with >10 scenes or >60s total duration to do a quick visual check before committing to a full render.

4. **Do not render repeatedly** to iterate. Use preview for layout checks and only render the final version.

## Common Mistakes

### Wrong data fields for scene type
**Symptom:** Scene renders as blank or missing content.
**Fix:** Check `data` fields against [scene-types](scene-types.md). Call `mcp_showrunner_list_scene_types` to confirm the exact schema.

Common confusions:
- `chart-line` uses `datasets` (not `series`) — same schema as `chart-bar`
- `kpi-scorecard` uses `kpis[]` (not `metrics[]` or `stats[]`)
- `stat-counter` uses `stats[]` (not `kpis[]`)
- `pipeline-funnel` requires `stages[].value` as a **string** (formatted, e.g. "$2.1M")
- `milestone-timeline` requires `milestones[].status` to be one of: `on-track`, `at-risk`, `overdue`, `completed`

### Asset references not declared
**Symptom:** Validation passes but images render as broken.
**Fix:** Every `$asset:key` reference must have a matching entry in the top-level `assets` map.

```json
// ❌ Wrong — $asset:logo used but not declared
{
  "branding": { "logo": "$asset:logo" },
  "scenes": [{ "data": { "image": "$asset:logo" } }]
}

// ✅ Correct
{
  "assets": { "logo": "https://cdn.example.com/logo.png" },
  "branding": { "logo": "$asset:logo" },
  "scenes": [{ "data": { "image": "$asset:logo" } }]
}
```

### Duration too short for content
**Symptom:** Text or animations feel frantic and unreadable.
**Rules of thumb:**
- Bullet lists: ~1.5s per item minimum (4 items → 6s)
- Chart scenes: 5–7s for readers to absorb data
- Text reveals with `word-reveal`: 1s per 8–10 words minimum
- Code terminal: ~1s per line

### Over-animation
**Symptom:** Video feels chaotic, every scene bouncing and sliding differently.
**Fix:** Use default animations for most scenes. Reserve custom `animation` overrides for 1–2 emphasis moments (e.g., the title card and a key stat reveal). Consistency > novelty.

### Pacing fractions > 1
**Symptom:** Animations overlap or scene ends abruptly.
**Fix:** Ensure `entrance + hold + exit ≤ 1.0`. If exit is 0, the scene holds its final state without exit animation.

## Animation Anti-Patterns

| Anti-Pattern | Why It's Bad | Do Instead |
|-------------|-------------|-----------|
| `bouncy` on data scenes (charts, tables) | Elastic wobble undermines data credibility | `spring` or `easeOut` |
| `speed` below 0.5 | Sluggish, wastes render time | 0.7 minimum for slow-mo |
| `typewriter` on short durations (<3s) | Characters fly by unreadably fast | `word-reveal` or no effect |
| `steps` on smooth animations | Jerky/broken appearance | Only for retro/technical effects |
| `stagger > 0.3` with many items | 8 items × 0.3s = 2.4s just for entrance | 0.08–0.15 for 6+ items |
| Every scene with custom animation | No visual rhythm, chaotic | Animate 2–3 key scenes, skip rest |
| `char-cascade` on gradient text | Visual conflict with emphasis styling | Use `word-reveal` instead |

## Error Recovery

### Validation fails
1. Read the error messages — they include field paths (e.g., `Scene "chart-bar" data.labels: Required`)
2. Fix the specific fields mentioned
3. Re-validate before attempting render

### Render fails
1. Check if ffmpeg is available (`which ffmpeg`)
2. Verify the output directory exists and is writable
3. Check that asset URLs are accessible (not behind auth/VPN)
4. Try rendering a single scene with `render_scene` to isolate the problem
5. Reduce quality to `fast` for faster debugging iterations

### Preview works but render doesn't
- Preview doesn't use ffmpeg — this confirms an ffmpeg/encoding issue
- Check `quality` setting: `high` uses more memory
- Try `medium` or `fast` quality first
