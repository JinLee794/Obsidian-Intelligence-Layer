// Dependency-free SVG charts. Colours come from CSS variables (--c1…--c8, --accent, …).
import { h, s, n, ms, compact } from "./dom.js";

export const PALETTE = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c7)", "var(--c8)"];

// ── Tooltip ─────────────────────────────────────────────────────────────

let tipEl = null;
function tipNode() {
    if (!tipEl) {
        tipEl = h("div", { class: "chart-tip", role: "tooltip" });
        document.body.append(tipEl);
    }
    return tipEl;
}

/** Show a tooltip for `el` built by `content()` (string, Node or array) while the pointer is over it. */
export function tip(el, content) {
    el.addEventListener("pointerenter", () => {
        const t = tipNode();
        const c = typeof content === "function" ? content() : content;
        t.replaceChildren(...[c].flat().filter(Boolean).map((x) => (x instanceof Node ? x : document.createTextNode(String(x)))));
        t.classList.add("on");
    });
    el.addEventListener("pointermove", (e) => {
        const t = tipNode();
        const pad = 14;
        const w = t.offsetWidth;
        const hgt = t.offsetHeight;
        let x = e.clientX + pad;
        let y = e.clientY + pad;
        if (x + w > innerWidth - 6) x = e.clientX - w - pad;
        if (y + hgt > innerHeight - 6) y = e.clientY - hgt - pad;
        t.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
    });
    el.addEventListener("pointerleave", () => tipNode().classList.remove("on"));
    return el;
}

export function hideTip() {
    tipEl?.classList.remove("on");
}

const tipRow = (color, label, value) => h("div", { class: "tip-row" }, color ? h("i", { style: { background: color } }) : null, h("span", null, label), h("b", null, value));
const tipHead = (text) => h("div", { class: "tip-head" }, text);

// ── Helpers ─────────────────────────────────────────────────────────────

function niceMax(v) {
    if (v <= 0) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    const m = v / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

const dayKey = (d) => d.toISOString().slice(0, 10);

/** Fill gaps so every calendar day between first and last is present. */
export function fillDays(byDay, minDays = 0) {
    if (!byDay.length && !minDays) return [];
    const map = new Map(byDay.map((d) => [d.day, d]));
    const end = new Date(`${byDay.length ? byDay[byDay.length - 1].day : dayKey(new Date())}T00:00:00Z`);
    let start = new Date(`${byDay.length ? byDay[0].day : dayKey(end)}T00:00:00Z`);
    if (minDays) {
        const floor = new Date(end.getTime() - (minDays - 1) * 86400000);
        if (floor < start) start = floor;
    }
    const out = [];
    for (let t = start.getTime(); t <= end.getTime() && out.length < 800; t += 86400000) {
        const k = dayKey(new Date(t));
        out.push(map.get(k) || { day: k, calls: 0, writes: 0, errors: 0 });
    }
    return out;
}

function smoothPath(pts) {
    if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : "";
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i - 1] || pts[i];
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[i + 1];
        const [x3, y3] = pts[i + 2] || pts[i + 1];
        const t = 0.18;
        const c1x = x1 + (x2 - x0) * t;
        const c2x = x2 - (x3 - x1) * t;
        // Clamp control points vertically to avoid overshoot below the baseline.
        const c1y = Math.min(Math.max(y1 + (y2 - y0) * t, Math.min(y1, y2)), Math.max(y1, y2));
        const c2y = Math.min(Math.max(y2 - (y3 - y1) * t, Math.min(y1, y2)), Math.max(y1, y2));
        d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
    }
    return d;
}

let gid = 0;
const uid = (p) => `${p}${++gid}`;

// ── Area chart ──────────────────────────────────────────────────────────

/**
 * Stacked-looking multi-series area chart over days.
 * series: [{ key, label, color }], rows: [{ day, [key]: number }]
 */
export function areaChart(rows, series, { height = 190 } = {}) {
    const W = 640;
    const H = height;
    const pad = { l: 34, r: 10, t: 12, b: 24 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const max = niceMax(Math.max(1, ...rows.flatMap((r) => series.map((sr) => r[sr.key] || 0))));
    const x = (i) => pad.l + (rows.length <= 1 ? iw / 2 : (i * iw) / (rows.length - 1));
    const y = (v) => pad.t + ih - (v / max) * ih;
    const svg = s("svg", { class: "chart area-chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Activity over time" });
    const defs = s("defs");
    svg.append(defs);
    // Grid
    for (let i = 0; i <= 4; i++) {
        const v = (max * i) / 4;
        svg.append(s("line", { class: "grid", x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }), s("text", { class: "axis", x: pad.l - 6, y: y(v) + 3, "text-anchor": "end" }, compact(v)));
    }
    const ticks = Math.min(6, rows.length);
    for (let i = 0; i < ticks; i++) {
        const idx = Math.round((i * (rows.length - 1)) / Math.max(1, ticks - 1));
        const d = new Date(`${rows[idx].day}T00:00:00Z`);
        svg.append(s("text", { class: "axis", x: x(idx), y: H - 6, "text-anchor": i === 0 ? "start" : i === ticks - 1 ? "end" : "middle" }, d.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" })));
    }
    for (const sr of series) {
        const pts = rows.map((r, i) => [x(i), y(r[sr.key] || 0)]);
        const id = uid("ag");
        defs.append(
            s(
                "linearGradient",
                { id, x1: 0, x2: 0, y1: 0, y2: 1 },
                s("stop", { offset: "0%", style: `stop-color:${sr.color};stop-opacity:.42` }),
                s("stop", { offset: "100%", style: `stop-color:${sr.color};stop-opacity:0` }),
            ),
        );
        const line = smoothPath(pts);
        if (pts.length > 1) svg.append(s("path", { class: "area-fill", d: `${line} L${pts[pts.length - 1][0]},${y(0)} L${pts[0][0]},${y(0)} Z`, fill: `url(#${id})` }));
        svg.append(s("path", { class: "area-line", d: line, style: `stroke:${sr.color}` }));
        if (pts.length === 1) svg.append(s("circle", { cx: pts[0][0], cy: pts[0][1], r: 4, style: `fill:${sr.color}` }));
    }
    // Hover column
    const cursor = s("line", { class: "cursor", x1: 0, x2: 0, y1: pad.t, y2: pad.t + ih, opacity: 0 });
    const dots = series.map((sr) => s("circle", { class: "cursor-dot", r: 4, opacity: 0, style: `fill:${sr.color}` }));
    svg.append(cursor, ...dots);
    const hit = s("rect", { x: pad.l, y: pad.t, width: iw, height: ih, fill: "transparent" });
    svg.append(hit);
    let idx = -1;
    const locate = (e) => {
        const r = svg.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        idx = rows.length <= 1 ? 0 : Math.max(0, Math.min(rows.length - 1, Math.round(((px - pad.l) / iw) * (rows.length - 1))));
        cursor.setAttribute("x1", x(idx));
        cursor.setAttribute("x2", x(idx));
        cursor.setAttribute("opacity", 1);
        series.forEach((sr, i) => {
            dots[i].setAttribute("cx", x(idx));
            dots[i].setAttribute("cy", y(rows[idx][sr.key] || 0));
            dots[i].setAttribute("opacity", 1);
        });
    };
    hit.addEventListener("pointermove", locate);
    hit.addEventListener("pointerleave", () => {
        cursor.setAttribute("opacity", 0);
        dots.forEach((d) => d.setAttribute("opacity", 0));
    });
    tip(hit, () => {
        const r = rows[Math.max(0, idx)];
        if (!r) return "";
        return [tipHead(new Date(`${r.day}T00:00:00Z`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })), ...series.map((sr) => tipRow(sr.color, sr.label, n(r[sr.key])))];
    });
    return svg;
}

// ── Donut ───────────────────────────────────────────────────────────────

/** items: [{ label, value, color? }] → donut with legend. */
export function donut(items, { center, sub, size = 150, thickness = 22 } = {}) {
    const total = items.reduce((a, b) => a + (b.value || 0), 0);
    const R = size / 2;
    const r = R - thickness / 2 - 2;
    const C = 2 * Math.PI * r;
    const svg = s("svg", { class: "chart donut", viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: "img" });
    svg.append(s("circle", { class: "donut-track", cx: R, cy: R, r, "stroke-width": thickness }));
    let acc = 0;
    const gap = items.filter((x) => x.value).length > 1 ? 2 : 0;
    items.forEach((it, i) => {
        if (!it.value) return;
        const len = (it.value / total) * C;
        const color = it.color || PALETTE[i % PALETTE.length];
        const seg = s("circle", {
            class: "donut-seg",
            cx: R,
            cy: R,
            r,
            "stroke-width": thickness,
            "stroke-dasharray": `${Math.max(0.01, len - gap)} ${C}`,
            "stroke-dashoffset": -acc,
            transform: `rotate(-90 ${R} ${R})`,
            style: `stroke:${color};--len:${len}`,
        });
        tip(seg, () => [tipRow(color, it.label, `${n(it.value)} · ${Math.round((100 * it.value) / total)}%`)]);
        svg.append(seg);
        acc += len;
    });
    svg.append(s("text", { class: "donut-center", x: R, y: R + (sub ? 2 : 6), "text-anchor": "middle" }, center ?? compact(total)));
    if (sub) svg.append(s("text", { class: "donut-sub", x: R, y: R + 18, "text-anchor": "middle" }, sub));
    const legend = h(
        "ul",
        { class: "donut-legend" },
        items.map((it, i) =>
            h(
                "li",
                null,
                h("i", { style: { background: it.color || PALETTE[i % PALETTE.length] } }),
                h("span", { class: "ellipsis", title: it.label }, it.label),
                h("b", null, n(it.value)),
                h("span", { class: "muted" }, total ? `${Math.round((100 * it.value) / total)}%` : ""),
            ),
        ),
    );
    return h("div", { class: "donut-wrap" }, svg, legend);
}

// ── Calendar heatmap ────────────────────────────────────────────────────

export function calendarHeatmap(byDay, { weeks = 26, key = "calls", label = "calls" } = {}) {
    const map = new Map(byDay.map((d) => [d.day, d]));
    const today = new Date(`${dayKey(new Date())}T00:00:00Z`);
    const end = new Date(today.getTime() + (6 - today.getUTCDay()) * 86400000);
    const start = new Date(end.getTime() - (weeks * 7 - 1) * 86400000);
    const values = byDay.map((d) => d[key] || 0).filter((v) => v > 0).sort((a, b) => a - b);
    const q = (p) => values[Math.min(values.length - 1, Math.floor(p * values.length))] || 1;
    const thresholds = [q(0.25), q(0.5), q(0.75)];
    const level = (v) => (!v ? 0 : v <= thresholds[0] ? 1 : v <= thresholds[1] ? 2 : v <= thresholds[2] ? 3 : 4);
    const cell = 11;
    const gapPx = 3;
    const left = 26;
    const top = 16;
    const W = left + weeks * (cell + gapPx);
    const H = top + 7 * (cell + gapPx);
    const svg = s("svg", { class: "chart heatmap", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Daily activity heatmap" });
    ["Mon", "Wed", "Fri"].forEach((d, i) => svg.append(s("text", { class: "axis", x: 0, y: top + (1 + i * 2) * (cell + gapPx) + 9 }, d)));
    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
        for (let dow = 0; dow < 7; dow++) {
            const t = new Date(start.getTime() + (w * 7 + dow) * 86400000);
            if (t > today) continue;
            const k = dayKey(t);
            const row = map.get(k);
            const v = row?.[key] || 0;
            if (dow === 0 && t.getUTCMonth() !== lastMonth) {
                lastMonth = t.getUTCMonth();
                if (w < weeks - 2) svg.append(s("text", { class: "axis", x: left + w * (cell + gapPx), y: 10 }, t.toLocaleDateString([], { month: "short", timeZone: "UTC" })));
            }
            const r = s("rect", { class: `hm l${level(v)}`, x: left + w * (cell + gapPx), y: top + dow * (cell + gapPx), width: cell, height: cell, rx: 2.5, style: `--d:${w * 12}ms` });
            tip(r, () => [tipHead(t.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })), tipRow(null, label, n(v)), row?.writes ? tipRow(null, "writes", n(row.writes)) : null]);
            svg.append(r);
        }
    }
    const legend = h("div", { class: "hm-legend" }, "Less", [0, 1, 2, 3, 4].map((l) => s("svg", { width: 11, height: 11 }, s("rect", { class: `hm l${l}`, width: 11, height: 11, rx: 2.5 }))), "More");
    return h("div", { class: "heatmap-wrap" }, svg, legend);
}

// ── Punchcard (weekday × hour) ──────────────────────────────────────────

export function punchcard(matrix) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const order = [1, 2, 3, 4, 5, 6, 0];
    const max = Math.max(1, ...matrix.flat());
    const cw = 24;
    const ch = 22;
    const left = 32;
    const top = 6;
    const W = left + 24 * cw;
    const H = top + 7 * ch + 18;
    const svg = s("svg", { class: "chart punchcard", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Activity by weekday and hour" });
    order.forEach((d, row) => {
        svg.append(s("text", { class: "axis", x: 0, y: top + row * ch + ch / 2 + 4 }, days[d]));
        svg.append(s("line", { class: "grid faint", x1: left, x2: W, y1: top + row * ch + ch / 2, y2: top + row * ch + ch / 2 }));
        for (let hr = 0; hr < 24; hr++) {
            const v = matrix[d]?.[hr] || 0;
            if (!v) continue;
            const r = 2 + Math.sqrt(v / max) * (Math.min(cw, ch) / 2 - 2);
            const c = s("circle", { class: "punch", cx: left + hr * cw + cw / 2, cy: top + row * ch + ch / 2, r, style: `--o:${0.35 + 0.65 * (v / max)}` });
            tip(c, () => [tipHead(`${days[d]} ${String(hr).padStart(2, "0")}:00–${String((hr + 1) % 24).padStart(2, "0")}:00`), tipRow(null, "calls", n(v))]);
            svg.append(c);
        }
    });
    for (let hr = 0; hr < 24; hr += 3) svg.append(s("text", { class: "axis", x: left + hr * cw + cw / 2, y: H - 2, "text-anchor": "middle" }, hr === 0 ? "12a" : hr === 12 ? "12p" : hr < 12 ? `${hr}a` : `${hr - 12}p`));
    return svg;
}

// ── Histogram ───────────────────────────────────────────────────────────

export function histogram(buckets, { p50, p95 } = {}) {
    const W = 360;
    const H = 150;
    const pad = { l: 8, r: 8, t: 12, b: 30 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const max = Math.max(1, ...buckets.map((b) => b.count));
    const bw = iw / buckets.length;
    const svg = s("svg", { class: "chart histogram", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Latency distribution" });
    const id = uid("hg");
    svg.append(s("defs", null, s("linearGradient", { id, x1: 0, x2: 0, y1: 0, y2: 1 }, s("stop", { offset: "0%", style: "stop-color:var(--c2)" }), s("stop", { offset: "100%", style: "stop-color:var(--c1)" }))));
    const label = (v) => (v == null ? "∞" : v >= 1000 ? `${v / 1000}s` : `${v}`);
    const inBucket = (v, b) => v != null && v >= b.lo && (b.hi == null || v < b.hi);
    buckets.forEach((b, i) => {
        const bh = (b.count / max) * ih;
        const marker = inBucket(p95, b) ? "p95" : inBucket(p50, b) ? "p50" : null;
        const g = s("g", { class: "hbar" });
        g.append(s("rect", { class: "hist-bar", x: pad.l + i * bw + 3, y: pad.t + ih - bh, width: bw - 6, height: Math.max(b.count ? 2 : 0, bh), rx: 4, fill: `url(#${id})`, style: `--i:${i}` }));
        g.append(s("rect", { x: pad.l + i * bw, y: pad.t, width: bw, height: ih, fill: "transparent" }));
        if (b.count) g.append(s("text", { class: "axis strong", x: pad.l + i * bw + bw / 2, y: pad.t + ih - bh - 4, "text-anchor": "middle" }, compact(b.count)));
        if (marker) g.append(s("text", { class: `marker ${marker}`, x: pad.l + i * bw + bw / 2, y: H - 2, "text-anchor": "middle" }, marker));
        g.append(s("text", { class: "axis", x: pad.l + i * bw + bw / 2, y: pad.t + ih + 13, "text-anchor": "middle" }, `<${label(b.hi)}`));
        tip(g, () => [tipHead(b.hi == null ? `≥ ${ms(b.lo)}` : `${ms(b.lo)} – ${ms(b.hi)}`), tipRow(null, "calls", n(b.count))]);
        svg.append(g);
    });
    return svg;
}

// ── Latency ranges (p50 → p95 → max per tool) ───────────────────────────

export function latencyRanges(rows, { limit = 10 } = {}) {
    const list = rows.slice(0, limit);
    const max = Math.max(1, ...list.map((r) => r.p95 || 0));
    const scale = (v) => (Math.log10(1 + v) / Math.log10(1 + max)) * 100;
    return h(
        "div",
        { class: "ranges" },
        list.map((r) =>
            tip(
                h(
                    "div",
                    { class: "range-row" },
                    h("span", { class: "mono small ellipsis", title: r.tool }, r.tool),
                    h(
                        "div",
                        { class: "range-track" },
                        h("div", { class: "range-bar", style: { left: `${scale(r.p50)}%`, width: `${Math.max(0.8, scale(r.p95) - scale(r.p50))}%` } }),
                        h("div", { class: "range-dot p50", style: { left: `${scale(r.p50)}%` } }),
                        h("div", { class: "range-dot p95", style: { left: `${scale(r.p95)}%` } }),
                    ),
                    h("span", { class: "num" }, ms(r.p95)),
                ),
                () => [tipHead(r.tool), tipRow("var(--c1)", "p50", ms(r.p50)), tipRow("var(--c4)", "p95", ms(r.p95)), tipRow(null, "max", ms(r.max)), tipRow(null, "samples", n(r.n))],
            ),
        ),
    );
}

// ── Squarified treemap ──────────────────────────────────────────────────

export function treemap(items, { onClick, height = 220 } = {}) {
    const W = 640;
    const H = height;
    const data = items.filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
    const total = data.reduce((a, b) => a + b.value, 0) || 1;
    const scaled = data.map((d) => ({ ...d, area: (d.value / total) * W * H }));
    const rects = [];
    let box = { x: 0, y: 0, w: W, h: H };
    let row = [];
    const worst = (r, side) => {
        const sum = r.reduce((a, b) => a + b.area, 0);
        const mx = Math.max(...r.map((x) => x.area));
        const mn = Math.min(...r.map((x) => x.area));
        return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
    };
    const layout = (r) => {
        const sum = r.reduce((a, b) => a + b.area, 0);
        if (box.w >= box.h) {
            const cw = sum / box.h;
            let y = box.y;
            for (const it of r) {
                const hh = it.area / cw;
                rects.push({ ...it, x: box.x, y, w: cw, h: hh });
                y += hh;
            }
            box = { x: box.x + cw, y: box.y, w: box.w - cw, h: box.h };
        } else {
            const rh = sum / box.w;
            let x = box.x;
            for (const it of r) {
                const ww = it.area / rh;
                rects.push({ ...it, x, y: box.y, w: ww, h: rh });
                x += ww;
            }
            box = { x: box.x, y: box.y + rh, w: box.w, h: box.h - rh };
        }
    };
    for (const it of scaled) {
        const side = Math.min(box.w, box.h);
        if (!row.length || worst([...row, it], side) <= worst(row, side)) row.push(it);
        else {
            layout(row);
            row = [it];
        }
    }
    if (row.length) layout(row);
    const svg = s("svg", { class: "chart treemap", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Folders by activity" });
    rects.forEach((r, i) => {
        const color = PALETTE[i % PALETTE.length];
        const g = s("g", { class: `tm${onClick ? " clickable" : ""}`, style: `--i:${i}` });
        g.append(s("rect", { x: r.x + 1.5, y: r.y + 1.5, width: Math.max(0, r.w - 3), height: Math.max(0, r.h - 3), rx: 6, style: `fill:${color}` }));
        if (r.w > 54 && r.h > 30) {
            const maxChars = Math.floor((r.w - 14) / 6.6);
            const lab = r.label.length > maxChars ? `${r.label.slice(0, Math.max(1, maxChars - 1))}…` : r.label;
            g.append(s("text", { class: "tm-label", x: r.x + 9, y: r.y + 19 }, lab));
            if (r.h > 46) g.append(s("text", { class: "tm-value", x: r.x + 9, y: r.y + 35 }, r.sub || compact(r.value)));
        }
        tip(g, () => [tipHead(r.label), tipRow(color, "touches", n(r.value)), r.notes != null ? tipRow(null, "notes", n(r.notes)) : null, r.writes ? tipRow(null, "writes", n(r.writes)) : null]);
        if (onClick) g.addEventListener("click", () => onClick(r));
        svg.append(g);
    });
    return svg;
}

// ── Radial gauge ────────────────────────────────────────────────────────

export function gauge(value, { max = 100, label = "", suffix = "%", size = 132, color } = {}) {
    const v = Math.max(0, Math.min(max, value || 0));
    const R = size / 2;
    const r = R - 12;
    const start = Math.PI * 0.75;
    const sweep = Math.PI * 1.5;
    const pt = (a) => [R + r * Math.cos(a), R + r * Math.sin(a)];
    const arc = (a0, a1) => {
        const [x0, y0] = pt(a0);
        const [x1, y1] = pt(a1);
        return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
    };
    const ratio = v / max;
    const col = color || (ratio >= 0.8 ? "var(--green)" : ratio >= 0.55 ? "var(--amber)" : "var(--red)");
    const id = uid("gg");
    const len = sweep * r;
    const svg = s(
        "svg",
        { class: "chart gauge", viewBox: `0 0 ${size} ${size * 0.86}`, width: size, height: size * 0.86, role: "img", "aria-label": `${label} ${Math.round(v)}${suffix}` },
        s("defs", null, s("linearGradient", { id, x1: 0, x2: 1, y1: 0, y2: 0 }, s("stop", { offset: "0%", style: `stop-color:${col};stop-opacity:.55` }), s("stop", { offset: "100%", style: `stop-color:${col}` }))),
        s("path", { class: "gauge-track", d: arc(start, start + sweep) }),
        s("path", { class: "gauge-val", d: arc(start, start + sweep), stroke: `url(#${id})`, "stroke-dasharray": `${len * ratio} ${len}`, style: `--len:${len}` }),
        s("text", { class: "gauge-num", x: R, y: R + 6, "text-anchor": "middle" }, `${Math.round(v)}`, s("tspan", { class: "gauge-suffix" }, suffix)),
        label ? s("text", { class: "gauge-label", x: R, y: R + 24, "text-anchor": "middle" }, label) : null,
    );
    return svg;
}

// ── Sparkline ───────────────────────────────────────────────────────────

export function sparkline(values, { color = "var(--accent)", width = 96, height = 28 } = {}) {
    const vals = values.length ? values : [0];
    const max = Math.max(1, ...vals);
    const pts = vals.map((v, i) => [vals.length === 1 ? width / 2 : (i * width) / (vals.length - 1), height - 3 - (v / max) * (height - 6)]);
    const id = uid("sp");
    const line = smoothPath(pts);
    return s(
        "svg",
        { class: "spark", viewBox: `0 0 ${width} ${height}`, width, height, "aria-hidden": "true", preserveAspectRatio: "none" },
        s("defs", null, s("linearGradient", { id, x1: 0, x2: 0, y1: 0, y2: 1 }, s("stop", { offset: "0%", style: `stop-color:${color};stop-opacity:.35` }), s("stop", { offset: "100%", style: `stop-color:${color};stop-opacity:0` }))),
        pts.length > 1 ? s("path", { d: `${line} L${width},${height} L0,${height} Z`, fill: `url(#${id})` }) : null,
        s("path", { d: line, style: `stroke:${color}`, class: "spark-line" }),
    );
}

// ── Ranked list with gradient bars ──────────────────────────────────────

export function rankList(items, { max, color = "var(--c1)", accent = "var(--c4)" } = {}) {
    const top = max ?? Math.max(1, ...items.map((x) => x.value));
    return h(
        "ol",
        { class: "rank" },
        items.map((x, i) =>
            h(
                "li",
                { style: { "--i": i } },
                h("span", { class: "rank-n" }, i + 1),
                h(
                    "div",
                    { class: "rank-main" },
                    h("div", { class: "rank-label" }, x.label, h("span", { class: "rank-val" }, x.valueText ?? n(x.value))),
                    h(
                        "div",
                        { class: "rank-track" },
                        h("div", { class: "rank-fill", style: { width: `${(100 * x.value) / top}%`, background: `linear-gradient(90deg, ${color}, color-mix(in srgb, ${color} 55%, transparent))` } }),
                        x.accent ? h("div", { class: "rank-fill acc", style: { width: `${(100 * x.accent) / top}%`, background: accent } }) : null,
                    ),
                ),
            ),
        ),
    );
}

// ── Force-directed graph ────────────────────────────────────────────────

/**
 * Interactive local graph. graph: { nodes: [{id, label, kind, hop}], edges: [{source, target}] }
 * Drag nodes, pan the background, wheel to zoom, click a note to open it.
 */
export function forceGraph(graph, { onOpen, height = 300, highlight } = {}) {
    const W = 600;
    const H = height;
    const nodes = graph.nodes.map((nd, i) => {
        const a = (i / Math.max(1, graph.nodes.length)) * Math.PI * 2;
        const rad = nd.kind === "center" ? 0 : 60 + (nd.hop || 1) * 55;
        return { ...nd, x: W / 2 + Math.cos(a) * rad + (Math.random() - 0.5) * 10, y: H / 2 + Math.sin(a) * rad + (Math.random() - 0.5) * 10, vx: 0, vy: 0, deg: 0 };
    });
    const byId = new Map(nodes.map((nd) => [nd.id, nd]));
    const edges = graph.edges.map((e) => ({ s: byId.get(e.source), t: byId.get(e.target) })).filter((e) => e.s && e.t && e.s !== e.t);
    for (const e of edges) {
        e.s.deg++;
        e.t.deg++;
    }
    const neighbors = new Map(nodes.map((nd) => [nd.id, new Set()]));
    for (const e of edges) {
        neighbors.get(e.s.id).add(e.t.id);
        neighbors.get(e.t.id).add(e.s.id);
    }
    const radius = (nd) => (nd.kind === "center" ? 9 : nd.kind === "unresolved" ? 3.5 : 4 + Math.min(6, Math.sqrt(nd.deg) * 1.4));

    const svg = s("svg", { class: "chart force", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Local graph" });
    const view = s("g");
    const edgeLayer = s("g", { class: "edges" });
    const nodeLayer = s("g", { class: "nodes" });
    view.append(edgeLayer, nodeLayer);
    svg.append(view);
    const lines = edges.map((e) => {
        const l = s("line", { class: "edge" });
        edgeLayer.append(l);
        return l;
    });
    const groups = nodes.map((nd) => {
        const g = s("g", { class: `node ${nd.kind}${highlight?.has(nd.id) ? " hl" : ""}` });
        g.append(s("circle", { r: radius(nd) }));
        g.append(s("text", { class: "node-label", y: radius(nd) + 11, "text-anchor": "middle" }, nd.label.length > 26 ? `${nd.label.slice(0, 25)}…` : nd.label));
        nodeLayer.append(g);
        return g;
    });

    let zoom = 1;
    let panX = 0;
    let panY = 0;
    const applyView = () => view.setAttribute("transform", `translate(${panX},${panY}) scale(${zoom})`);
    const draw = () => {
        edges.forEach((e, i) => {
            lines[i].setAttribute("x1", e.s.x.toFixed(1));
            lines[i].setAttribute("y1", e.s.y.toFixed(1));
            lines[i].setAttribute("x2", e.t.x.toFixed(1));
            lines[i].setAttribute("y2", e.t.y.toFixed(1));
        });
        nodes.forEach((nd, i) => groups[i].setAttribute("transform", `translate(${nd.x.toFixed(1)},${nd.y.toFixed(1)})`));
    };

    let alpha = 1;
    let raf = 0;
    const tick = () => {
        const k = Math.sqrt((W * H) / Math.max(1, nodes.length)) * 0.55;
        for (let i = 0; i < nodes.length; i++) {
            const a = nodes[i];
            for (let j = i + 1; j < nodes.length; j++) {
                const b = nodes[j];
                let dx = a.x - b.x;
                let dy = a.y - b.y;
                let d2 = dx * dx + dy * dy;
                if (d2 < 0.01) {
                    dx = Math.random() - 0.5;
                    dy = Math.random() - 0.5;
                    d2 = 0.25;
                }
                const f = Math.min(40, (k * k) / d2) * 0.9;
                const d = Math.sqrt(d2);
                a.vx += (dx / d) * f;
                a.vy += (dy / d) * f;
                b.vx -= (dx / d) * f;
                b.vy -= (dy / d) * f;
            }
        }
        for (const e of edges) {
            const dx = e.t.x - e.s.x;
            const dy = e.t.y - e.s.y;
            const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
            const f = ((d - k * 0.9) / d) * 0.06;
            e.s.vx += dx * f;
            e.s.vy += dy * f;
            e.t.vx -= dx * f;
            e.t.vy -= dy * f;
        }
        for (const nd of nodes) {
            nd.vx += (W / 2 - nd.x) * 0.012;
            nd.vy += (H / 2 - nd.y) * 0.012;
            if (nd.kind === "center" && !nd.fixed) {
                nd.vx += (W / 2 - nd.x) * 0.1;
                nd.vy += (H / 2 - nd.y) * 0.1;
            }
            if (nd.fixed) {
                nd.vx = nd.vy = 0;
                continue;
            }
            nd.x += Math.max(-12, Math.min(12, nd.vx * alpha));
            nd.y += Math.max(-12, Math.min(12, nd.vy * alpha));
            nd.vx *= 0.55;
            nd.vy *= 0.55;
        }
    };
    const run = () => {
        cancelAnimationFrame(raf);
        const step = () => {
            tick();
            draw();
            alpha *= 0.985;
            if (alpha > 0.02 && svg.isConnected) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
    };
    // Pre-settle so the first paint isn't a tangle.
    for (let i = 0; i < 120; i++) {
        tick();
        alpha *= 0.99;
    }
    draw();
    // Fit to view
    const xs = nodes.map((nd) => nd.x);
    const ys = nodes.map((nd) => nd.y);
    if (nodes.length > 1) {
        const bw = Math.max(...xs) - Math.min(...xs) + 80;
        const bh = Math.max(...ys) - Math.min(...ys) + 60;
        zoom = Math.max(0.35, Math.min(1.6, Math.min(W / bw, H / bh)));
        panX = W / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * zoom;
        panY = H / 2 - ((Math.max(...ys) + Math.min(...ys)) / 2) * zoom;
    }
    applyView();
    requestAnimationFrame(() => svg.isConnected && run());

    const toLocal = (e) => {
        const r = svg.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        const py = ((e.clientY - r.top) / r.height) * H;
        return [(px - panX) / zoom, (py - panY) / zoom];
    };
    // Hover highlighting
    const focus = (nd) => {
        svg.classList.toggle("focusing", Boolean(nd));
        const near = nd ? neighbors.get(nd.id) : null;
        nodes.forEach((m, i) => groups[i].classList.toggle("near", Boolean(nd && (m === nd || near.has(m.id)))));
        edges.forEach((e, i) => lines[i].classList.toggle("near", Boolean(nd && (e.s === nd || e.t === nd))));
    };
    let drag = null;
    nodes.forEach((nd, i) => {
        const g = groups[i];
        g.addEventListener("pointerenter", () => !drag && focus(nd));
        g.addEventListener("pointerleave", () => !drag && focus(null));
        tip(g, () => [tipHead(nd.label), h("div", { class: "muted small" }, nd.kind === "unresolved" ? "Unresolved link — note doesn't exist" : nd.id), nd.kind !== "unresolved" ? tipRow(null, "links here", n(nd.deg)) : null]);
        g.addEventListener("pointerdown", (e) => {
            e.stopPropagation();
            g.setPointerCapture(e.pointerId);
            drag = { nd, moved: false, x0: e.clientX, y0: e.clientY };
            nd.fixed = true;
        });
        g.addEventListener("pointermove", (e) => {
            if (!drag || drag.nd !== nd) return;
            if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 3) drag.moved = true;
            if (!drag.moved) return;
            hideTip();
            [nd.x, nd.y] = toLocal(e);
            alpha = Math.max(alpha, 0.35);
            draw();
            if (!raf || alpha < 0.03) run();
        });
        g.addEventListener("pointerup", () => {
            if (!drag) return;
            const clicked = !drag.moved;
            nd.fixed = nd.kind === "center" ? false : drag.moved;
            drag = null;
            if (!clicked) run();
            if (clicked && nd.kind !== "unresolved" && onOpen) {
                hideTip();
                onOpen(nd.id);
            }
        });
    });
    let pan = null;
    svg.addEventListener("pointerdown", (e) => {
        pan = { x: e.clientX, y: e.clientY, px: panX, py: panY };
        svg.setPointerCapture(e.pointerId);
        svg.classList.add("panning");
    });
    svg.addEventListener("pointermove", (e) => {
        if (!pan) return;
        const r = svg.getBoundingClientRect();
        panX = pan.px + ((e.clientX - pan.x) / r.width) * W;
        panY = pan.py + ((e.clientY - pan.y) / r.height) * H;
        applyView();
    });
    const endPan = () => {
        pan = null;
        svg.classList.remove("panning");
    };
    svg.addEventListener("pointerup", endPan);
    svg.addEventListener("pointercancel", endPan);
    svg.addEventListener(
        "wheel",
        (e) => {
            e.preventDefault();
            const r = svg.getBoundingClientRect();
            const px = ((e.clientX - r.left) / r.width) * W;
            const py = ((e.clientY - r.top) / r.height) * H;
            const nz = Math.max(0.25, Math.min(4, zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
            panX = px - ((px - panX) * nz) / zoom;
            panY = py - ((py - panY) * nz) / zoom;
            zoom = nz;
            applyView();
        },
        { passive: false },
    );
    return svg;
}

// ── Column chart (labelled buckets) ─────────────────────────────────────

/** buckets: [{ label, count, color? }] — vertical bars with value labels and a share-of-total tooltip. */
export function columnChart(buckets, { unit = "", tipLabel = (b) => b.label, height = 160 } = {}) {
    const W = 360;
    const H = height;
    const pad = { l: 8, r: 8, t: 16, b: 22 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const max = Math.max(1, ...buckets.map((b) => b.count));
    const total = buckets.reduce((a, b) => a + b.count, 0);
    const bw = iw / Math.max(1, buckets.length);
    const svg = s("svg", { class: "chart histogram", viewBox: `0 0 ${W} ${H}`, role: "img" });
    buckets.forEach((b, i) => {
        const bh = (b.count / max) * ih;
        const color = b.color || PALETTE[i % PALETTE.length];
        const g = s("g", { class: "hbar" });
        g.append(s("rect", { class: "hist-bar", x: pad.l + i * bw + 3, y: pad.t + ih - bh, width: bw - 6, height: Math.max(b.count ? 2 : 0, bh), rx: 4, style: `fill:${color};--i:${i}` }));
        g.append(s("rect", { x: pad.l + i * bw, y: pad.t, width: bw, height: ih, fill: "transparent" }));
        if (b.count) g.append(s("text", { class: "axis strong", x: pad.l + i * bw + bw / 2, y: pad.t + ih - bh - 4, "text-anchor": "middle" }, compact(b.count)));
        g.append(s("text", { class: "axis", x: pad.l + i * bw + bw / 2, y: pad.t + ih + 14, "text-anchor": "middle" }, b.label));
        tip(g, () => [tipHead(tipLabel(b)), tipRow(color, unit || "count", n(b.count)), total ? tipRow(null, "share", `${Math.round((100 * b.count) / total)}%`) : null]);
        svg.append(g);
    });
    return svg;
}

// ── Percent lines over categories (with volume bars behind) ─────────────

/**
 * rows: [{ [labelKey], [barKey], ...series keys (0–100) }], series: [{ key, label, color }].
 * Faint bars show volume per category on their own scale; lines show rates on 0–100%.
 */
export function percentLines(rows, series, { labelKey = "label", barKey = null, barLabel = "calls", height = 180, xTitle = null } = {}) {
    const W = 420;
    const H = height;
    const pad = { l: 34, r: 12, t: 14, b: xTitle ? 34 : 22 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const cw = iw / Math.max(1, rows.length);
    const x = (i) => pad.l + cw * i + cw / 2;
    const y = (v) => pad.t + ih - (Math.max(0, Math.min(100, v)) / 100) * ih;
    const svg = s("svg", { class: "chart pct-lines", viewBox: `0 0 ${W} ${H}`, role: "img" });
    for (let i = 0; i <= 4; i++) svg.append(s("line", { class: "grid", x1: pad.l, x2: W - pad.r, y1: y(i * 25), y2: y(i * 25) }), s("text", { class: "axis", x: pad.l - 6, y: y(i * 25) + 3, "text-anchor": "end" }, `${i * 25}%`));
    if (barKey) {
        const bmax = Math.max(1, ...rows.map((r) => r[barKey] || 0));
        rows.forEach((r, i) => {
            const bh = ((r[barKey] || 0) / bmax) * ih * 0.9;
            svg.append(s("rect", { class: "vol-bar hist-bar", x: x(i) - cw * 0.32, y: pad.t + ih - bh, width: cw * 0.64, height: bh, rx: 4, style: `--i:${i}` }));
        });
    }
    rows.forEach((r, i) => svg.append(s("text", { class: "axis", x: x(i), y: pad.t + ih + 14, "text-anchor": "middle" }, String(r[labelKey]))));
    if (xTitle) svg.append(s("text", { class: "axis", x: pad.l + iw / 2, y: H - 2, "text-anchor": "middle" }, xTitle));
    for (const sr of series) {
        const pts = rows.map((r, i) => (r[sr.key] == null ? null : [x(i), y(r[sr.key])])).filter(Boolean);
        if (pts.length > 1) svg.append(s("path", { class: "area-line", d: smoothPath(pts), style: `stroke:${sr.color}` }));
        rows.forEach((r, i) => r[sr.key] != null && svg.append(s("circle", { class: "line-dot", cx: x(i), cy: y(r[sr.key]), r: 3.6, style: `fill:${sr.color}` })));
    }
    rows.forEach((r, i) => {
        const hit = s("rect", { x: x(i) - cw / 2, y: pad.t, width: cw, height: ih, fill: "transparent" });
        tip(hit, () => [tipHead(`${xTitle ? `${xTitle} ` : ""}${r[labelKey]}`), ...series.map((sr) => tipRow(sr.color, sr.label, r[sr.key] == null ? "–" : `${r[sr.key]}%`)), barKey ? tipRow("var(--muted-fill)", barLabel, n(r[barKey])) : null]);
        svg.append(hit);
    });
    return svg;
}

// ── Bubble scatter (log-x latency × rate) ───────────────────────────────

/**
 * points: [{ label, x, y (0–100), size, color, sub? }] — x on a log scale (e.g. ms),
 * bubble area ∝ size. The top-left quadrant (fast, high y) is highlighted as the sweet spot.
 */
export function bubbleScatter(points, { xLabel = "", yLabel = "", xFmt = ms, height = 240, labels = 6 } = {}) {
    const W = 520;
    const H = height;
    const pad = { l: 40, r: 16, t: 14, b: 34 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const pts = points.filter((p) => p.x != null && p.y != null);
    const lx = (v) => Math.log10(Math.max(1, v));
    const xs = pts.map((p) => lx(p.x));
    const lo = Math.floor(Math.min(...xs, 1));
    const hi = Math.max(lo + 1, Math.ceil(Math.max(...xs, 2)));
    const X = (v) => pad.l + ((lx(v) - lo) / (hi - lo)) * iw;
    const Y = (v) => pad.t + ih - (Math.max(0, Math.min(100, v)) / 100) * ih;
    const smax = Math.max(1, ...pts.map((p) => p.size || 0));
    const R = (v) => 5 + Math.sqrt((v || 0) / smax) * 20;
    const svg = s("svg", { class: "chart bubbles", viewBox: `0 0 ${W} ${H}`, role: "img" });
    const midX = pad.l + iw / 2;
    svg.append(s("rect", { class: "sweet", x: pad.l, y: pad.t, width: midX - pad.l, height: ih / 2, rx: 6 }));
    svg.append(s("text", { class: "axis sweet-label", x: pad.l + 6, y: pad.t + 13 }, "fast & useful"));
    for (let i = 0; i <= 4; i++) svg.append(s("line", { class: "grid", x1: pad.l, x2: W - pad.r, y1: Y(i * 25), y2: Y(i * 25) }), s("text", { class: "axis", x: pad.l - 6, y: Y(i * 25) + 3, "text-anchor": "end" }, `${i * 25}%`));
    for (let e = lo; e <= hi; e++) {
        const v = 10 ** e;
        svg.append(s("line", { class: "grid faint", x1: X(v), x2: X(v), y1: pad.t, y2: pad.t + ih }), s("text", { class: "axis", x: X(v), y: pad.t + ih + 14, "text-anchor": "middle" }, xFmt(v)));
    }
    if (xLabel) svg.append(s("text", { class: "axis", x: pad.l + iw / 2, y: H - 3, "text-anchor": "middle" }, xLabel));
    if (yLabel) svg.append(s("text", { class: "axis", x: 10, y: pad.t + ih / 2, transform: `rotate(-90 10 ${pad.t + ih / 2})`, "text-anchor": "middle" }, yLabel));
    const order = [...pts].sort((a, b) => (b.size || 0) - (a.size || 0));
    const labelled = new Set(order.slice(0, labels));
    // Place labels above the bubble, else below, else stacked further down — never overlapping
    // each other or leaving the plot area (bubbles at 100% would otherwise label off the top).
    const placed = [];
    const LH = 12;
    const fits = (x1, x2, y) => y - LH + 2 >= pad.t && y <= pad.t + ih && !placed.some((b) => x1 < b.x2 && x2 > b.x1 && Math.abs(y - b.y) < LH);
    const placeLabel = (p) => {
        const cx = X(p.x);
        const half = (p.label.length * 6.2) / 2 + 2;
        const x = Math.max(pad.l + half, Math.min(W - pad.r - half, cx));
        const r = R(p.size);
        const cands = [Y(p.y) - r - 4, Y(p.y) + r + LH];
        for (let k = 1; k <= 8; k++) cands.push(Y(p.y) + r + LH * (k + 1));
        const y = cands.find((c) => fits(x - half, x + half, c)) ?? cands[1];
        placed.push({ x1: x - half, x2: x + half, y });
        return { x, y };
    };
    order.forEach((p, i) => {
        const g = s("g", { class: "bubble", style: `--i:${i}` });
        g.append(s("circle", { cx: X(p.x), cy: Y(p.y), r: R(p.size), style: `fill:${p.color};stroke:${p.color}` }));
        if (labelled.has(p)) {
            const at = placeLabel(p);
            g.append(s("text", { class: "bubble-label", x: at.x, y: at.y, "text-anchor": "middle" }, p.label));
        }
        tip(g, () => [tipHead(p.label), tipRow(p.color, yLabel || "y", `${p.y}%`), tipRow(null, xLabel || "x", xFmt(p.x)), tipRow(null, "calls", n(p.size)), ...(p.sub || []).map(([k, v]) => tipRow(null, k, v))]);
        svg.append(g);
    });
    return svg;
}

// ── 100% stacked bars ───────────────────────────────────────────────────

/** rows: [{ label, parts: { key: number } }], keys: [{ key, label, color }]. */
export function stackedBars(rows, keys) {
    return h(
        "div",
        { class: "stacks" },
        rows.map((r, ri) => {
            const total = keys.reduce((a, k) => a + (r.parts[k.key] || 0), 0);
            return h(
                "div",
                { class: "stack-row" },
                h("span", { class: "mono small ellipsis", title: r.label }, r.label),
                h(
                    "div",
                    { class: "stack-track", style: { "--i": ri } },
                    keys.map((k) => {
                        const v = r.parts[k.key] || 0;
                        if (!v || !total) return null;
                        return tip(h("div", { class: "stack-seg", style: { width: `${(100 * v) / total}%`, background: k.color } }), () => [tipHead(r.label), tipRow(k.color, k.label, `${n(v)} · ${Math.round((100 * v) / total)}%`)]);
                    }),
                ),
                h("span", { class: "num" }, n(total)),
            );
        }),
    );
}

// ── Funnel ──────────────────────────────────────────────────────────────

/** steps: [{ label, value, color?, hint? }] — each bar is sized against the first step. */
export function funnel(steps) {
    const top = Math.max(1, steps[0]?.value || 0);
    return h(
        "div",
        { class: "funnel" },
        steps.map((st, i) => {
            const pct = (100 * (st.value || 0)) / top;
            const color = st.color || PALETTE[i % PALETTE.length];
            return tip(
                h(
                    "div",
                    { class: "fn-row", style: { "--i": i } },
                    h("div", { class: "fn-bar", style: { width: `${Math.max(pct, 2)}%`, background: `linear-gradient(90deg, ${color}, color-mix(in srgb, ${color} 55%, transparent))` } }),
                    h("div", { class: "fn-text" }, h("b", null, n(st.value)), h("span", null, st.label), i ? h("span", { class: "fn-pct" }, `${Math.round(pct)}%`) : null),
                ),
                () => [tipHead(st.label), tipRow(color, "count", n(st.value)), i ? tipRow(null, `of ${steps[0].label.toLowerCase()}`, `${Math.round(pct)}%`) : null, st.hint ? h("div", { class: "muted small", style: { marginTop: "4px" } }, st.hint) : null],
            );
        }),
    );
}