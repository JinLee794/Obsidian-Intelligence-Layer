# Scene Types Reference

Complete data schemas for all Showrunner scene types. Each scene's `data` object must conform to the schema below.

> **Tip:** Call `mcp_showrunner_list_scene_types` at runtime to get the latest schemas, which may include types added after this document was written.

---

## Narrative / Structure

### `title-card`
Full-screen branded intro. Logo fades in with scale spring, title slides up.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | **Yes** | Main title text |
| `subtitle` | string | No | Subtitle below title |
| `date` | string | No | Date string (e.g., "2026-Q2") |
| `presenter` | string | No | Presenter name |
| `image` | string | No | Logo/icon — use `$asset:key` or data URI |

```json
{
  "type": "title-card", "duration": 5,
  "data": { "title": "Q2 Business Review", "subtitle": "Engineering Excellence", "date": "2026-Q2", "image": "$asset:logo" }
}
```

### `section-header`
Transition slide between sections. Heading enters with spring, accent line draws.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `heading` | string | **Yes** | Section heading |
| `subheading` | string | No | Supporting text |
| `icon` | string | No | Emoji or icon |

```json
{
  "type": "section-header", "duration": 4,
  "data": { "heading": "Key Metrics", "subheading": "Performance at a glance" }
}
```

### `closing`
Branded outro. Logo scales in with spring. Tagline fades up.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `tagline` | string | No | Closing message |
| `timestamp` | string | No | Generation timestamp |
| `cta` | string | No | Call to action text |
| `image` | string | No | Logo/icon — use `$asset:key` or data URI |

```json
{
  "type": "closing", "duration": 4,
  "data": { "tagline": "Built with Showrunner", "cta": "Try it today", "image": "$asset:logo" }
}
```

### `text-reveal`
Cinematic text reveal. Supports `<em>`/`<strong>` in headline for gradient-colored emphasis. Best with `animation.textEffect`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `headline` | string | **Yes** | Main text. Supports `<em>`/`<strong>` for accent |
| `eyebrow` | string | No | Small uppercase label above headline |
| `body` | string | No | Supporting body text |
| `footnote` | string | No | Small monospaced note |

```json
{
  "type": "text-reveal", "duration": 6,
  "data": { "eyebrow": "Our Mission", "headline": "Ship faster with <em>confidence</em>", "body": "We measure, iterate, and improve." },
  "animation": { "textEffect": "word-reveal", "easing": "slow" }
}
```

### `quote-highlight`
Quote with attribution. Quote mark scales in with spring.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `quote` | string | **Yes** | Quote text |
| `attribution` | string | No | Source/author |
| `sentiment` | enum | No | `positive`, `negative`, `neutral` |

```json
{
  "type": "quote-highlight", "duration": 5,
  "data": { "quote": "The best way to predict the future is to invent it.", "attribution": "Alan Kay", "sentiment": "positive" }
}
```

---

## Data / Charts

### `chart-bar`
Bars grow upward with staggered spring. Values appear at bar tops.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | No | Chart title |
| `labels` | string[] | **Yes** | X-axis category labels |
| `datasets` | array | **Yes** | One or more data series |
| `datasets[].label` | string | **Yes** | Series name |
| `datasets[].values` | number[] | **Yes** | Values (must match `labels` length) |
| `datasets[].color` | string | No | Hex color for this series |
| `annotation` | string | No | Footer annotation text |

```json
{
  "type": "chart-bar", "duration": 6,
  "data": {
    "title": "Commits by Category",
    "labels": ["Features", "Docs", "Fixes", "Chores"],
    "datasets": [{ "label": "Commits", "values": [12, 8, 5, 3], "color": "#0078D4" }]
  }
}
```

### `chart-line`
Line draws left-to-right using path interpolation. Data points pop in.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | No | Chart title |
| `labels` | string[] | **Yes** | X-axis labels |
| `datasets` | array | **Yes** | One or more line series |
| `datasets[].label` | string | **Yes** | Series name |
| `datasets[].values` | number[] | **Yes** | Values per label |
| `datasets[].color` | string | No | Line/area color |
| `annotation` | string | No | Footer annotation |

```json
{
  "type": "chart-line", "duration": 7,
  "data": {
    "title": "Monthly Revenue",
    "labels": ["Jan", "Feb", "Mar", "Apr", "May", "Jun"],
    "datasets": [{ "label": "Revenue", "values": [120, 135, 142, 168, 190, 215], "color": "#0078D4" }]
  }
}
```

### `chart-donut`
Segments fill clockwise with easeInOut. Center label counts up.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | No | Chart title |
| `labels` | string[] | **Yes** | Segment labels |
| `datasets` | array | **Yes** | Data (typically one dataset) |
| `datasets[].label` | string | **Yes** | Dataset name |
| `datasets[].values` | number[] | **Yes** | Values per segment |
| `datasets[].color` | string | No | Color |
| `annotation` | string | No | Footer annotation |

```json
{
  "type": "chart-donut", "duration": 6,
  "data": {
    "title": "Deals by Stage",
    "labels": ["Discovery", "Proposal", "Negotiation", "Closed"],
    "datasets": [{ "label": "Deals", "values": [15, 8, 5, 3] }]
  }
}
```

### `kpi-scorecard`
Grid of KPI cards with count-up number animation and trend arrows.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `kpis` | array | **Yes** | Array of KPI objects |
| `kpis[].label` | string | **Yes** | Metric name |
| `kpis[].value` | string\|number | **Yes** | Metric value |
| `kpis[].unit` | string | No | Unit suffix (e.g., "%", "ms") |
| `kpis[].trend` | enum | No | `up`, `down`, `flat` |
| `kpis[].target` | string | No | Target value string |
| `kpis[].animateCount` | boolean | No | Count up from 0 (default: true) |

```json
{
  "type": "kpi-scorecard", "duration": 6,
  "data": {
    "kpis": [
      { "label": "Revenue", "value": "$4.2M", "trend": "up", "target": "$5M" },
      { "label": "Uptime", "value": 99.97, "unit": "%", "trend": "flat" },
      { "label": "NPS", "value": 72, "trend": "up" }
    ]
  }
}
```

### `stat-counter`
Big animated numbers that count up from 0. Cards with optional progress bars and change indicators.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | No | Section title |
| `stats` | array | **Yes** | Array of stat objects |
| `stats[].value` | string\|number | **Yes** | Number to count up to |
| `stats[].label` | string | **Yes** | Metric label |
| `stats[].prefix` | string | No | e.g., "$" |
| `stats[].suffix` | string | No | e.g., "%", "ms" |
| `stats[].icon` | string | No | Emoji icon |
| `stats[].description` | string | No | Supporting text |
| `stats[].change` | string | No | e.g., "+12%" |
| `stats[].changeDirection` | enum | No | `up`, `down` |
| `stats[].progress` | number | No | 0–100, renders a progress bar |

```json
{
  "type": "stat-counter", "duration": 7,
  "data": {
    "stats": [
      { "value": 2847, "label": "Deployments", "suffix": "+", "change": "+34%", "changeDirection": "up", "progress": 85 },
      { "value": 99.97, "label": "Uptime", "suffix": "%", "progress": 99 }
    ]
  }
}
```

---

## Lists / Comparisons

### `bullet-list`
Animated bullet list with staggered entrance. Supports icons, highlight borders, and sub-text.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | No | List heading |
| `subtitle` | string | No | Subheading text |
| `items` | array | **Yes** | Array of bullet items |
| `items[].text` | string | **Yes** | Primary text |
| `items[].sub` | string | No | Secondary description |
| `items[].icon` | string | No | Emoji or HTML icon |
| `items[].highlight` | boolean | No | Add accent left border |

```json
{
  "type": "bullet-list", "duration": 6,
  "data": {
    "title": "Top Priorities",
    "items": [
      { "text": "Zero-downtime migration", "sub": "Target: August 2026", "highlight": true },
      { "text": "Reduce P50 latency", "sub": "Currently: 73ms" },
      { "text": "Ship mobile SDK beta", "icon": "📱" }
    ]
  }
}
```

### `action-items`
Numbered list. Each item slides up with spring easing, staggered 100ms.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `items` | array | **Yes** | Array of action items |
| `items[].text` | string | **Yes** | Action description |
| `items[].owner` | string | No | Assigned person |
| `items[].due` | string | No | Due date |
| `items[].priority` | enum | No | `high`, `normal` |

```json
{
  "type": "action-items", "duration": 6,
  "data": {
    "items": [
      { "text": "Finalize API design", "owner": "Alice", "due": "Apr 15", "priority": "high" },
      { "text": "Update documentation", "owner": "Bob", "due": "Apr 20" }
    ]
  }
}
```

### `comparison`
Side-by-side comparison with center divider. Items slide in from opposite sides.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | No | Comparison heading |
| `left` | object | **Yes** | Left column |
| `left.label` | string | **Yes** | Column header |
| `left.items` | string[] | **Yes** | List of items |
| `right` | object | **Yes** | Right column |
| `right.label` | string | **Yes** | Column header |
| `right.items` | string[] | **Yes** | List of items |

```json
{
  "type": "comparison", "duration": 6,
  "data": {
    "title": "Before vs After",
    "left": { "label": "Before", "items": ["Manual deploys", "4-hour rollbacks", "No monitoring"] },
    "right": { "label": "After", "items": ["CI/CD pipeline", "5-min rollbacks", "Full observability"] }
  }
}
```

### `table`
Data table with staggered row entrance. Highlighted rows get accent background.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | No | Table title |
| `columns` | array | **Yes** | Column definitions |
| `columns[].key` | string | **Yes** | Data key in row objects |
| `columns[].label` | string | **Yes** | Column header text |
| `columns[].width` | string | No | CSS width (e.g., "30%") |
| `rows` | object[] | **Yes** | Array of row data objects |
| `highlightRows` | number[] | No | Row indices (0-based) to highlight |

```json
{
  "type": "table", "duration": 7,
  "data": {
    "title": "Team Performance",
    "columns": [{ "key": "name", "label": "Name" }, { "key": "score", "label": "Score" }],
    "rows": [{ "name": "Alice", "score": "98" }, { "name": "Bob", "score": "92" }],
    "highlightRows": [0]
  }
}
```

---

## Visual / Technical

### `pipeline-funnel`
Horizontal bars grow left-to-right with staggered spring. Values count up from 0.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `stages` | array | **Yes** | Funnel stages |
| `stages[].name` | string | **Yes** | Stage name |
| `stages[].count` | number | **Yes** | Count at this stage |
| `stages[].value` | string | **Yes** | Formatted currency/value |
| `stages[].highlight` | boolean | No | Highlight this stage |

```json
{
  "type": "pipeline-funnel", "duration": 7,
  "data": {
    "stages": [
      { "name": "Prospect", "count": 1200, "value": "$24M" },
      { "name": "Qualified", "count": 450, "value": "$12M" },
      { "name": "Proposal", "count": 120, "value": "$6M", "highlight": true },
      { "name": "Closed", "count": 35, "value": "$2.1M" }
    ]
  }
}
```

### `milestone-timeline`
Vertical timeline draws downward. Status dots appear with spring scale-in.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `milestones` | array | **Yes** | Array of milestones |
| `milestones[].name` | string | **Yes** | Milestone name |
| `milestones[].due` | string | **Yes** | ISO date string |
| `milestones[].status` | enum | **Yes** | `on-track`, `at-risk`, `overdue`, `completed` |
| `milestones[].owner` | string | **Yes** | Responsible person |
| `milestones[].note` | string | No | Additional context |

```json
{
  "type": "milestone-timeline", "duration": 8,
  "data": {
    "milestones": [
      { "name": "Design Complete", "due": "2026-04-01", "status": "completed", "owner": "Alice" },
      { "name": "Beta Launch", "due": "2026-06-15", "status": "on-track", "owner": "Bob" },
      { "name": "GA Release", "due": "2026-08-01", "status": "at-risk", "owner": "Carol", "note": "Blocked on compliance" }
    ]
  }
}
```

### `code-terminal`
Code walkthrough with terminal-style typing animation. Built-in typing effect — does not need `animation.textEffect`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | No | Terminal title bar text |
| `shell` | string | No | Shell indicator (e.g., "bash", "zsh") |
| `lines` | array | **Yes** | Array of terminal lines |
| `lines[].kind` | enum | **Yes** | `prompt`, `output`, `comment`, `success`, `error`, `highlight`, `blank` |
| `lines[].text` | string | No | Line content |

```json
{
  "type": "code-terminal", "duration": 8,
  "data": {
    "title": "Deploy Pipeline",
    "shell": "bash",
    "lines": [
      { "kind": "prompt", "text": "git push origin main" },
      { "kind": "output", "text": "Enumerating objects: 42, done." },
      { "kind": "success", "text": "✅ Deployed to production" },
      { "kind": "comment", "text": "# Zero-downtime rollout complete" }
    ]
  }
}
```

### `image-card`
Full-bleed image with optional caption overlay. Image fades in with subtle zoom.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `image` | string | **Yes** | Image source — `$asset:key`, HTTPS URL, or data URI |
| `caption` | string | No | Overlay caption text |
| `title` | string | No | Title overlay |
| `subtitle` | string | No | Subtitle overlay |
| `fit` | enum | No | `cover` (default), `contain`, `fill` |
| `position` | enum | No | `center` (default), `top`, `bottom` |
| `overlay` | enum | No | `none` (default), `gradient`, `dark` |
| `effect` | enum | No | `ken-burns`, `zoom-in`, `pan-left`, `pan-right`, `static` |

```json
{
  "type": "image-card", "duration": 5,
  "data": { "image": "$asset:hero", "caption": "Our team at Build 2026", "overlay": "gradient", "effect": "ken-burns" }
}
```

### `scene-showcase`
Grid of cards. Each card scales in with staggered spring.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | No | Grid title |
| `subtitle` | string | No | Grid subtitle |
| `cards` | array | **Yes** | Array of card objects |
| `cards[].name` | string | **Yes** | Card title |
| `cards[].description` | string | No | Card description |
| `cards[].icon` | string | No | Emoji icon |
| `cards[].style` | string | No | CSS style string |

```json
{
  "type": "scene-showcase", "duration": 6,
  "data": {
    "title": "Scene Types",
    "cards": [
      { "name": "Charts", "description": "Bar, line, donut", "icon": "📊" },
      { "name": "Data", "description": "Tables, KPIs, stats", "icon": "📈" },
      { "name": "Narrative", "description": "Text, quotes, titles", "icon": "✍️" }
    ]
  }
}
```

---

## Special-Purpose

### `risk-callout`
Risk cards slide in from right with spring. Severity stripe animates color.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `risks` | array | **Yes** | Array of risk objects |
| `risks[].signal` | string | **Yes** | Risk description |
| `risks[].severity` | enum | **Yes** | `critical`, `high`, `medium`, `low` |
| `risks[].context` | string | No | Additional context |

```json
{
  "type": "risk-callout", "duration": 6,
  "data": {
    "risks": [
      { "signal": "Competitor launched similar feature", "severity": "high", "context": "Announced at Build" },
      { "signal": "Key engineer on leave", "severity": "medium" }
    ]
  }
}
```

### `deal-team`
Grid of avatar circles. Each scales in with bouncy spring.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `members` | array | **Yes** | Team members |
| `members[].name` | string | **Yes** | Full name |
| `members[].role` | string | **Yes** | Role title |
| `members[].initials` | string | **Yes** | 2-letter initials |
| `members[].avatar` | string | No | Avatar image URL |
| `members[].highlight` | boolean | No | Highlight this member |

```json
{
  "type": "deal-team", "duration": 5,
  "data": {
    "members": [
      { "name": "Alice Chen", "role": "Account Executive", "initials": "AC", "highlight": true },
      { "name": "Bob Park", "role": "Solution Architect", "initials": "BP" }
    ]
  }
}
```
