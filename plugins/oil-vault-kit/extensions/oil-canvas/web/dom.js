// Shared DOM, fetch and formatting helpers. All dynamic text goes through textContent.

export const params = new URLSearchParams(location.search);
export const TOKEN = params.get("t") || "";
const SVG_NS = "http://www.w3.org/2000/svg";

export function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    applyAttrs(el, attrs);
    append(el, children);
    return el;
}

/** SVG element builder (attributes are set verbatim). */
export function s(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    applyAttrs(el, attrs, true);
    append(el, children);
    return el;
}

function applyAttrs(el, attrs, svg = false) {
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null || v === false) continue;
        if (k === "class") svg ? el.setAttribute("class", v) : (el.className = v);
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (k === "style" && typeof v === "object") {
            for (const [sk, sv] of Object.entries(v)) {
                if (sv == null) continue;
                if (sk.startsWith("--")) el.style.setProperty(sk, String(sv));
                else el.style[sk] = sv;
            }
        }
        else if (k === "ref" && typeof v === "function") v(el);
        else el.setAttribute(k, v === true ? "" : v);
    }
}

function append(el, children) {
    for (const c of children.flat(Infinity)) {
        if (c == null || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
}

/** View builders return arrays that may contain null placeholders for empty sections. */
export function nodes(list) {
    return list.flat(Infinity).filter((c) => c != null && c !== false);
}

export async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(path, {
        method,
        headers: { "x-oil-token": TOKEN, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { status: res.status, data });
    return data;
}

const fmt = new Intl.NumberFormat();
export const n = (v) => fmt.format(v || 0);
export const compact = (v) => (Math.abs(v) >= 10_000 ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(v) : n(v));

export function ago(iso) {
    if (!iso) return "";
    const t = typeof iso === "number" ? iso : Date.parse(iso);
    const sec = Math.max(0, (Date.now() - t) / 1000);
    if (sec < 60) return "just now";
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}d ago`;
    return new Date(t).toLocaleDateString();
}

export function clock(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function ms(v) {
    if (v == null) return "–";
    return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`;
}

export const noteName = (p) => String(p).split("/").pop().replace(/\.md$/i, "");
export const noteFolder = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const isMd = (p) => /\.md$/i.test(p);
export const WRITE_TOOLS = new Set(["atomic_append", "atomic_replace", "atomic_replace_section", "create_note"]);

export function hostIsDark() {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
    if (!m || (m.length === 4 && Number(m[3]) === 0)) return matchMedia("(prefers-color-scheme: dark)").matches;
    const [r, g, b] = m.map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

export function debounce(fn, wait) {
    let t = null;
    const d = (...a) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...a), wait);
    };
    d.cancel = () => clearTimeout(t);
    return d;
}

/** Fuzzy subsequence match. Returns { score, idx } or null; higher is better. */
export function fuzzy(query, text) {
    const q = query.toLowerCase().replace(/\s+/g, "");
    if (!q) return { score: 0, idx: [] };
    const t = text.toLowerCase();
    const base = t.lastIndexOf("/") + 1;
    const sub = t.indexOf(q, base) >= 0 ? t.indexOf(q, base) : t.indexOf(q);
    if (sub >= 0) {
        const idx = Array.from({ length: q.length }, (_, i) => sub + i);
        return { score: 1000 + (sub >= base ? 400 : 0) + (sub === base ? 300 : 0) - sub - t.length * 0.2, idx };
    }
    let from = 0;
    let prev = -2;
    let score = 0;
    const idx = [];
    for (const ch of q) {
        const f = t.indexOf(ch, from);
        if (f < 0) return null;
        idx.push(f);
        score += f === prev + 1 ? 8 : 1;
        if (f === 0 || /[\s/_\-.]/.test(t[f - 1])) score += 6;
        if (f >= base) score += 2;
        prev = f;
        from = f + 1;
    }
    return { score: score - t.length * 0.05, idx };
}

/** Text with matched character indexes wrapped in <mark>. */
export function markText(text, idx = []) {
    if (!idx.length) return [text];
    const set = new Set(idx);
    const out = [];
    let buf = "";
    let on = false;
    for (let i = 0; i <= text.length; i++) {
        const m = set.has(i);
        if (i === text.length || m !== on) {
            if (buf) out.push(on ? h("mark", null, buf) : buf);
            buf = "";
            on = m;
        }
        if (i < text.length) buf += text[i];
    }
    return out;
}

// ── Toasts ──────────────────────────────────────────────────────────────

let toastHost = null;
export function toast(message, kind = "info", timeout = 3200) {
    if (!toastHost) {
        toastHost = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
        document.body.append(toastHost);
    }
    const el = h("div", { class: `toast ${kind}` }, icon(kind === "error" ? "alert" : kind === "success" ? "check" : "sparkle", 15), h("span", null, message));
    toastHost.append(el);
    setTimeout(() => {
        el.classList.add("out");
        setTimeout(() => el.remove(), 300);
    }, timeout);
}

// ── Icons (24×24 stroke paths) ──────────────────────────────────────────

const ICONS = {
    activity: "M3 12h4l3-8 4 16 3-8h4",
    chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
    pulse: "M12 3a9 9 0 1 0 9 9M12 7v5l3 2M17 3l4 4-4 4",
    shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4",
    vault: "M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0 M12 9V7 M4 8H2 M4 16H2",
    folder: "M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    folderOpen: "M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1H7.5a2 2 0 0 0-1.9 1.4L3 19z M3 19l2.6-7.6A2 2 0 0 1 7.5 10H21l-2.6 7.6a2 2 0 0 1-1.9 1.4z",
    file: "M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M14 3v5h5 M8 13h8 M8 17h5",
    image: "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M4 16l5-5 4 4 2-2 5 5 M15.5 8.5m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0",
    chevron: "M9 6l6 6-6 6",
    back: "M15 6l-6 6 6 6",
    fwd: "M9 6l6 6-6 6",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    backlink: "M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3",
    graph: "M6 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M18 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M12 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M7.5 7.5l3.5 8.5 M16.5 7.5L13 16 M8 6h8",
    list: "M9 6h11 M9 12h11 M9 18h11 M4 6h.01 M4 12h.01 M4 18h.01",
    history: "M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5 M12 7v5l3 3",
    edit: "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z M13.5 6.5l4 4",
    eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
    diff: "M6 3v12 M18 9v12 M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M10 6h4a4 4 0 0 1 4 4 M14 18h-4a4 4 0 0 1-4-4",
    external: "M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
    sparkle: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
    search: "M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0 M20 20l-4-4",
    plus: "M12 5v14 M5 12h14",
    check: "M5 12l5 5L20 7",
    alert: "M12 4l9 16H3z M12 10v4 M12 17h.01",
    x: "M6 6l12 12 M18 6L6 18",
    refresh: "M20 11a8 8 0 0 0-14.9-3.9L3 9 M3 4v5h5 M4 13a8 8 0 0 0 14.9 3.9L21 15 M21 20v-5h-5",
    sidebar: "M4 4h16v16H4z M15 4v16",
    sidebarL: "M4 4h16v16H4z M9 4v16",
    split: "M4 4h16v16H4z M12 4v16",
    save: "M5 3h11l3 3v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z M8 3v5h7 M8 21v-7h8v7",
    bold: "M7 5h6a3.5 3.5 0 0 1 0 7H7z M7 12h7a3.5 3.5 0 0 1 0 7H7z",
    italic: "M10 5h8 M6 19h8 M14 5l-4 14",
    heading: "M6 4v16 M18 4v16 M6 12h12",
    quote: "M7 7h4v4c0 3-2 5-4 6 M15 7h4v4c0 3-2 5-4 6",
    code: "M8 8l-5 4 5 4 M16 8l5 4-5 4",
    task: "M4 5h6v6H4z M5.5 8l1.5 1.5L9.5 6.5 M14 8h7 M4 15h6v6H4z M14 18h7",
    bullet: "M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01",
    callout: "M4 5h16v11H9l-5 4z M8 9h8 M8 12h5",
    tag: "M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z M8 8h.01",
    clock: "M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0 M12 7v5l3 2",
    zap: "M13 2L4 14h7l-1 8 9-12h-7z",
    unlink: "M10 14a4 4 0 0 0 5.7 0l1-1 M14 10a4 4 0 0 0-5.7 0l-1 1 M4 4l16 16 M17 7l2-2 M5 19l2-2",
    ghost: "M6 20V10a6 6 0 0 1 12 0v10l-2-2-2 2-2-2-2 2-2-2z M10 10h.01 M14 10h.01",
    copy: "M9 9h11v11H9z M5 15H4V4h11v1",
    empty: "M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M9 14h6",
    calendar: "M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4",
    paperclip: "M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7L9.2 17.2a1.7 1.7 0 0 1-2.4-2.4L14.5 7",
    weight: "M6 7h12l2 13H4z M9 7a3 3 0 0 1 6 0",
    hash: "M5 9h14 M5 15h14 M10 4L8 20 M16 4l-2 16",
    target: "M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0 M12 12m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0 M12 12h.01",
    layers: "M12 3l9 5-9 5-9-5z M3 13l9 5 9-5",
    wand: "M15 4V2 M15 10V8 M19 6h2 M9 6h2 M18 3l1-1 M18 9l1 1 M12 3l-1-1 M3 21l11-11 M12 9l3 3",
    send: "M4 12l16-8-6 16-3-7z M11 13l9-9",
    globe: "M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0 M3 12h18 M12 3a14 14 0 0 1 0 18 M12 3a14 14 0 0 0 0 18",
    book: "M4 19.5V5a2 2 0 0 1 2-2h14v15H6.5A2.5 2.5 0 0 0 4 20.5 2.5 2.5 0 0 0 6.5 23H20v-5 M8 7h8 M8 11h6",
    slides: "M3 4h18v12H3z M12 16v4 M8 20h8 M7 8h6 M7 12h10",
    doc: "M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M14 3v5h5 M8 12l1.5 5 2.5-4 2.5 4 1.5-5",
    table: "M4 5h16v14H4z M4 10h16 M4 15h16 M10 5v14",
    music: "M9 18V5l11-2v13 M6 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0 M17 16m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
    film: "M4 4h16v16H4z M8 4v16 M16 4v16 M4 8h4 M4 12h4 M4 16h4 M16 8h4 M16 12h4 M16 16h4",
    app: "M4 4h16v16H4z M4 9h16 M7.5 6.5h.01 M10.5 6.5h.01",
    notes: "M5 4h14v12l-4 4H5z M15 20v-4h4 M8 8h8 M8 12h5",
};

export function icon(name, size = 16, attrs = {}) {
    const d = ICONS[name] || ICONS.file;
    return s(
        "svg",
        { class: `icon icon-${name}`, width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", ...attrs },
        s("path", { d }),
    );
}
