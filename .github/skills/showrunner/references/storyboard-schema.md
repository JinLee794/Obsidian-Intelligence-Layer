# Storyboard Schema Reference

Complete JSON schema for storyboard objects passed to Showrunner MCP tools.

## Top-Level Structure

```json
{
  "title": "Video Title",
  "theme": "microsoft",
  "fps": 30,
  "resolution": [1920, 1080],
  "branding": {
    "logo": "$asset:logo",
    "accent": "#0078D4",
    "font": "Segoe UI"
  },
  "assets": {
    "logo": "https://example.com/logo.png",
    "hero": "docs/assets/hero.jpg"
  },
  "scenes": [ /* ... */ ]
}
```

## Field Reference

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `title` | string | **Yes** | — | Video title (metadata, not rendered as scene) |
| `theme` | enum | No | `corporate-dark` | `corporate-dark`, `corporate-light`, `minimal`, `microsoft`, `custom` |
| `fps` | number | No | `30` | `24`, `30`, or `60` only |
| `resolution` | [w, h] | No | `[1920, 1080]` | Also supports `[1280, 720]` |
| `branding` | object | No | — | Persistent watermark/styling on every scene |
| `branding.logo` | string | No | — | Image for bottom-right logo watermark. Use `$asset:key` |
| `branding.accent` | string | No | — | Hex color for accent elements |
| `branding.font` | string | No | — | Font family name |
| `assets` | object | No | — | Map of `key` → URL/path. Referenced as `$asset:key` in scene data |
| `scenes` | array | **Yes** | — | Array of scene objects (minimum 1) |

## Scene Object

```json
{
  "type": "title-card",
  "duration": 5,
  "transition": "fade",
  "data": { "title": "Hello World", "subtitle": "A demo" },
  "animation": { "easing": "spring" },
  "notes": "Agent-only note, not rendered"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | enum | **Yes** | One of the 20+ scene types. See [scene-types](scene-types.md) |
| `duration` | number | **Yes** | Seconds. Range: 0.5–120. Recommended: 3–8 |
| `transition` | enum | No | `cut` (default), `fade`, `slide-left`, `slide-up`, `zoom` |
| `data` | object | **Yes** | Scene-specific data fields. Varies by type |
| `animation` | object | No | Override default animation. See [animation-guide](animation-guide.md) |
| `notes` | string | No | Agent notes — not rendered in video |

## Asset References

Declare assets once in the top-level `assets` map, then reference with `$asset:key` anywhere a scene expects an image/URL:

```json
{
  "assets": {
    "logo": "https://cdn.example.com/logo.png",
    "hero": "docs/assets/hero.jpg"
  },
  "branding": { "logo": "$asset:logo" },
  "scenes": [{
    "type": "title-card",
    "data": { "image": "$asset:logo" }
  }, {
    "type": "image-card",
    "data": { "image": "$asset:hero" }
  }]
}
```

**Supported sources:**
- `https://` URLs (fetched at render time)
- Local file paths (relative to workspace root)
- `data:` URIs (inline base64)

**Supported formats:** PNG, JPG, GIF, WebP, SVG

## Animation Overrides Object

See [animation-guide](animation-guide.md) for full details. Quick reference:

```json
"animation": {
  "easing": "spring",
  "textEffect": "word-reveal",
  "stagger": 0.12,
  "direction": "up",
  "speed": 1.0,
  "delay": 0.3,
  "exitAnimation": "fade",
  "pacing": { "entrance": 0.3, "hold": 0.5, "exit": 0.2 }
}
```

| Field | Type | Default | Range/Values |
|-------|------|---------|--------------|
| `easing` | enum | `easeOut` | `linear`, `easeOut`, `easeInOut`, `spring`, `bouncy`, `elastic`, `slow`, `snap`, `power1`, `power4`, `circ`, `expo`, `steps` |
| `textEffect` | enum | none | `typewriter`, `word-reveal`, `char-cascade`, `fade-lines`, `highlight-sweep`, `counter` |
| `stagger` | number | varies | Seconds between staggered items |
| `direction` | enum | `up` | `up`, `down`, `left`, `right` |
| `speed` | number | 1 | 0.1–5 (timeline multiplier) |
| `delay` | number | 0 | Seconds before entrance begins |
| `exitAnimation` | enum | `none` | `fade`, `slide-up`, `slide-down`, `scale-down`, `none` |
| `pacing.entrance` | number | 0.3 | 0–1 (fraction of duration) |
| `pacing.hold` | number | 0.5 | 0–1 (fraction of duration) |
| `pacing.exit` | number | 0.2 | 0–1 (fraction of duration) |
| `emphasis` | number[] | [] | Indices of items to emphasize |

## Minimal Valid Storyboard

```json
{
  "title": "Quick Demo",
  "scenes": [
    {
      "type": "title-card",
      "duration": 5,
      "data": { "title": "Hello World" }
    }
  ]
}
```
