// Lightweight previews for non-markdown vault files: web pages, PDFs, Office documents,
// audio/video, CSV and code/text. Each viewer is built once per file (and rebuilt only when
// the file's mtime changes) and fills itself in asynchronously, so global re-renders don't
// reload frames, reset scroll or restart playback.
import { h, api, icon, n, ago, TOKEN } from "./dom.js";
import { A } from "./state.js";
import { emptyState, skeletonList } from "./panels.js";
import { fileExt, KIND_META } from "./filetypes.js";

const enc = encodeURIComponent;
const V = { path: null, mtime: null, el: null, media: null };
const MAX_CSV_ROWS = 1000;

export const PREVIEWABLE = new Set(["html", "pdf", "slides", "doc", "sheet", "audio", "video", "csv", "text"]);

const fileUrl = (path, query = "") => `/file/${TOKEN}/${path.split("/").map(enc).join("/")}${query}`;
const officeImg = (path, entry, alt = "") => h("img", { src: `/office-media?t=${enc(TOKEN)}&path=${enc(path)}&entry=${enc(entry)}`, alt, loading: "lazy" });

export function bytes(v) {
    if (v == null) return "–";
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

/** The (cached) viewer element for a non-markdown file. */
export function fileViewer(note) {
    const mtime = note.info?.mtime ?? null;
    if (V.path === note.path && V.el) {
        if (!(mtime && V.mtime && mtime !== V.mtime)) {
            if (mtime) V.mtime = mtime;
            return V.el;
        }
    }
    parkMedia(true);
    V.path = note.path;
    V.mtime = mtime;
    V.media = null;
    V.el = build(note);
    return V.el;
}

/** Pause audio/video that is no longer on screen (or always, when `force`). */
export function parkMedia(force = false) {
    if (V.media && (force || !V.media.isConnected) && !V.media.paused) V.media.pause();
}

/** Fallback card offering Obsidian and the OS default app. */
export function unsupported(note, reason = "This file type can't be previewed here.") {
    const kind = KIND_META[note.kind] || KIND_META.other;
    return h(
        "div",
        { class: "pad-lg" },
        emptyState(
            kind.icon,
            note.path.split("/").pop(),
            `${note.info?.size ? `${bytes(note.info.size)} · ` : ""}${reason}`,
            h("button", { class: "btn primary", onclick: () => A.openFile(note.path) }, icon("app", 14), "Open in default app"),
            h("button", { class: "btn", onclick: () => A.openInObsidian(note.path) }, icon("external", 14), "Open in Obsidian"),
        ),
    );
}

function build(note) {
    switch (note.kind) {
        case "html":
            return htmlViewer(note);
        case "pdf":
            return navigator.pdfViewerEnabled === false ? unsupported(note, "This app has no built-in PDF viewer.") : frameViewer(note, "pdf");
        case "audio":
        case "video":
            return mediaViewer(note);
        case "slides":
        case "doc":
        case "sheet":
            return asyncViewer(note, `/api/office?path=${enc(note.path)}`, officeView);
        case "csv":
            return asyncViewer(note, `/api/text?path=${enc(note.path)}`, csvView);
        case "text":
            return asyncViewer(note, `/api/text?path=${enc(note.path)}`, textView);
        default:
            return unsupported(note);
    }
}

function asyncViewer(note, url, view) {
    const box = h("div", { class: "fv fv-scroll" }, h("div", { class: "pad-lg" }, skeletonList(8)));
    api(url)
        .then((data) => box.replaceChildren(...[view(note, data)].flat().filter((c) => c != null && c !== false)))
        .catch((err) => box.replaceChildren(unsupported(note, err.message)));
    return box;
}

function strip(note, ...parts) {
    return h("div", { class: "fv-strip" }, icon(KIND_META[note.kind].icon, 14), h("span", { class: "fv-kind" }, KIND_META[note.kind].label), ...parts, h("span", { class: "grow" }), h("button", { class: "btn sm ghost", title: "Open in the default app for this file type", onclick: () => A.openFile(note.path) }, icon("app", 13), "Open externally"));
}

// ── Frames (HTML, PDF) ──────────────────────────────────────────────────

function frameViewer(note, kind) {
    const frame = h("iframe", { class: "fv-frame", src: fileUrl(note.path), referrerpolicy: "no-referrer", title: note.path.split("/").pop() });
    return h("div", { class: `fv fv-${kind}` }, strip(note, note.info?.size ? h("span", { class: "muted" }, bytes(note.info.size)) : null), frame);
}

function htmlViewer(note) {
    let remote = false;
    // Empty sandbox: no scripts, forms, popups or same-origin access, on top of the server's CSP sandbox.
    const frame = h("iframe", { class: "fv-frame light", sandbox: "", src: fileUrl(note.path), referrerpolicy: "no-referrer", title: note.path.split("/").pop() });
    const label = h("span", null, "Load remote images & styles");
    const toggle = h(
        "button",
        {
            class: "btn sm ghost",
            "aria-pressed": "false",
            title: "Allow https: images, stylesheets and fonts (scripts always stay blocked)",
            onclick: () => {
                remote = !remote;
                toggle.setAttribute("aria-pressed", String(remote));
                label.textContent = remote ? "Remote content on" : "Load remote images & styles";
                frame.src = fileUrl(note.path, remote ? "?remote=1" : "");
            },
        },
        icon("globe", 13),
        label,
    );
    return h("div", { class: "fv fv-html" }, strip(note, h("span", { class: "fv-chip", title: "Scripts, forms and popups are disabled" }, icon("shield", 11), "scripts off"), toggle), frame);
}

// ── Audio / video ───────────────────────────────────────────────────────

function mediaViewer(note) {
    const video = note.kind === "video";
    const media = h(video ? "video" : "audio", { class: "fv-media", controls: true, preload: "metadata", src: fileUrl(note.path) });
    V.media = media;
    const box = h("div", { class: `fv fv-media-wrap${video ? " is-video" : ""}` });
    media.addEventListener("error", () => {
        if (V.media === media) V.media = null;
        box.replaceChildren(unsupported(note, `This ${video ? "video" : "audio"} format (.${fileExt(note.path)}) can't be played here.`));
    });
    const name = note.path.split("/").pop();
    box.append(
        strip(note, note.info?.size ? h("span", { class: "muted" }, bytes(note.info.size)) : null),
        video
            ? h("div", { class: "fv-stage" }, media)
            : h("div", { class: "fv-stage audio" }, h("div", { class: "fv-disc" }, icon("music", 34)), h("div", { class: "fv-title ellipsis", title: name }, name), media),
    );
    return box;
}

// ── Text & CSV ──────────────────────────────────────────────────────────

function truncNote(d) {
    return d.truncated ? h("div", { class: "fv-note" }, icon("alert", 13), `Showing the first ${bytes(Math.min(d.size, 1024 * 1024))} of ${bytes(d.size)}.`) : null;
}

function textView(note, d) {
    if (d.binary) return unsupported(note, "This looks like a binary file.");
    let text = d.text;
    if (!d.truncated && /^(json|canvas|excalidraw)$/.test(fileExt(note.path))) {
        try {
            text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {}
    }
    const lines = text.split("\n").length;
    return [strip(note, h("span", { class: "muted" }, `${n(lines)} lines · ${bytes(d.size)}`)), truncNote(d), h("pre", { class: "fv-code" }, h("code", null, text))];
}

/** RFC 4180-ish CSV/TSV parser (quoted fields, escaped quotes, CRLF). */
export function parseDelimited(text, delim, maxRows = MAX_CSV_ROWS) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    let total = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else quoted = false;
            } else field += c;
        } else if (c === '"' && field === "") quoted = true;
        else if (c === delim) {
            row.push(field);
            field = "";
        } else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            row.push(field);
            field = "";
            total++;
            if (rows.length < maxRows) rows.push(row);
            row = [];
        } else field += c;
    }
    if (field !== "" || row.length) {
        row.push(field);
        total++;
        if (rows.length < maxRows) rows.push(row);
    }
    return { rows, total };
}

function csvView(note, d) {
    if (d.binary) return unsupported(note, "This looks like a binary file.");
    const { rows, total } = parseDelimited(d.text, fileExt(note.path) === "tsv" ? "\t" : ",");
    if (!rows.length) return [strip(note), h("div", { class: "pad-lg" }, emptyState("table", "Empty table", null))];
    const [head, ...body] = rows;
    const cols = Math.max(...rows.map((r) => r.length));
    const pad = (r) => Array.from({ length: cols }, (_, i) => r[i] ?? "");
    return [
        strip(note, h("span", { class: "muted" }, `${n(total - 1)} rows · ${cols} columns`)),
        truncNote(d),
        total > rows.length ? h("div", { class: "fv-note" }, icon("alert", 13), `Showing the first ${n(rows.length - 1)} rows.`) : null,
        h("div", { class: "fv-table-wrap" }, h("table", { class: "fv-table" }, h("thead", null, h("tr", null, h("th", { class: "rn" }, ""), pad(head).map((c) => h("th", null, c)))), h("tbody", null, body.map((r, i) => h("tr", null, h("td", { class: "rn" }, i + 1), pad(r).map((c) => h("td", null, c))))))),
    ];
}

// ── Office ──────────────────────────────────────────────────────────────

function metaLine(meta, extra) {
    const bits = [meta?.title && h("strong", null, meta.title), meta?.author && `by ${meta.author}`, meta?.modified && `edited ${ago(meta.modified)}${meta.modifiedBy ? ` by ${meta.modifiedBy}` : ""}`, extra].filter(Boolean);
    return bits.length ? h("div", { class: "fv-meta" }, bits.flatMap((b, i) => (i ? [h("span", { class: "dot" }, "·"), b] : [b]))) : null;
}

function officeView(note, d) {
    if (d.kind === "pptx") return slidesView(note, d);
    if (d.kind === "docx") return docView(note, d);
    return sheetView(note, d);
}

function tableEl(rows, cls = "fv-table") {
    return h("div", { class: "fv-table-wrap" }, h("table", { class: cls }, h("tbody", null, rows.map((r) => h("tr", null, r.map((c) => h("td", null, c)))))));
}

function slidesView(note, d) {
    const cards = d.slides.map((s) => {
        const face = h(
            "div",
            { class: "slide-face" },
            s.title ? h("h2", { class: "slide-title" }, s.title) : null,
            s.body.map((b) =>
                b.type === "table"
                    ? tableEl(b.rows, "fv-table compact")
                    : h(
                          "ul",
                          { class: `slide-list${b.subtitle ? " subtitle" : ""}` },
                          b.items.map((p) => h("li", { style: { "--lvl": p.level } }, p.text)),
                      ),
            ),
            s.images.length ? h("div", { class: "slide-imgs" }, s.images.slice(0, 6).map((img) => officeImg(note.path, img))) : null,
            !s.title && !s.body.length && !s.images.length ? h("div", { class: "slide-empty muted" }, "No text on this slide") : null,
        );
        return h(
            "section",
            { class: `slide-card${s.hidden ? " hidden-slide" : ""}`, id: `slide-${s.index}` },
            h("div", { class: "slide-num" }, s.index, s.hidden ? h("span", { class: "fv-chip" }, "hidden") : null),
            h("div", { class: "slide-main" }, face, s.notes ? h("div", { class: "slide-notes" }, icon("notes", 13), h("div", null, s.notes)) : null),
        );
    });
    const jump = d.slides.length > 1 ? h("nav", { class: "slide-jump", "aria-label": "Slides" }, d.slides.map((s) => h("button", { title: s.title || `Slide ${s.index}`, onclick: () => document.getElementById(`slide-${s.index}`)?.scrollIntoView({ behavior: "smooth", block: "start" }) }, s.index))) : null;
    return [
        strip(note, h("span", { class: "muted" }, `${n(d.total)} slide${d.total === 1 ? "" : "s"} · ${bytes(d.size)}`)),
        metaLine(d.meta),
        jump,
        d.truncated ? h("div", { class: "fv-note" }, icon("alert", 13), `Showing the first ${n(d.slides.length)} of ${n(d.total)} slides.`) : null,
        h("div", { class: "deck" }, cards),
        h("div", { class: "fv-foot muted" }, "Text-only preview — layout, themes and charts aren't rendered."),
    ];
}

function docView(note, d) {
    const blocks = [];
    let list = null;
    for (const b of d.blocks) {
        if (b.type === "p" && b.list != null && !b.heading) {
            if (!list) blocks.push((list = h("ul", { class: "doc-list" })));
            list.append(h("li", { style: { "--lvl": b.list } }, b.text));
            continue;
        }
        list = null;
        if (b.type === "table") blocks.push(tableEl(b.rows));
        else if (b.heading) blocks.push(h(`h${b.heading}`, null, b.text));
        else if (b.quote) blocks.push(h("blockquote", null, b.text));
        else if (b.text.trim()) blocks.push(h("p", null, b.text));
        if (b.images?.length) blocks.push(h("div", { class: "doc-imgs" }, b.images.map((img) => officeImg(note.path, img))));
    }
    return [
        strip(note, h("span", { class: "muted" }, bytes(d.size))),
        metaLine(d.meta),
        d.truncated ? h("div", { class: "fv-note" }, icon("alert", 13), `Showing the first ${n(d.blocks.length)} of ${n(d.total)} blocks.`) : null,
        h("article", { class: "doc-page" }, blocks.length ? blocks : h("p", { class: "muted" }, "This document has no text.")),
    ];
}

function colName(i) {
    let s = "";
    for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
}

function sheetView(note, d) {
    const grid = h("div", { class: "sheet-grid" });
    const status = h("span", { class: "muted" });
    const tabs = h("div", { class: "sheet-tabs", role: "tablist" });
    const show = (i) => {
        const sh = d.sheets[i];
        [...tabs.children].forEach((t, j) => t.setAttribute("aria-selected", String(i === j)));
        status.textContent = `${n(sh.totalRows)} rows · ${sh.cols} columns`;
        grid.replaceChildren(
            ...[
            sh.rows.length
                ? h(
                      "div",
                      { class: "fv-table-wrap" },
                      h(
                          "table",
                          { class: "fv-table sheet" },
                          h("thead", null, h("tr", null, h("th", { class: "rn" }, ""), Array.from({ length: sh.cols }, (_, c) => h("th", null, colName(c))))),
                          h("tbody", null, sh.rows.map((r) => h("tr", null, h("td", { class: "rn" }, r.r), r.cells.map((c) => h("td", { class: /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(c) ? "num" : null }, c))))),
                      ),
                  )
                : h("div", { class: "pad-lg" }, emptyState("table", "Empty sheet", null)),
            sh.totalRows > sh.rows.length ? h("div", { class: "fv-note" }, icon("alert", 13), `Showing the first ${n(sh.rows.length)} of ${n(sh.totalRows)} rows.`) : null,
                        ].filter(Boolean),
                    );
    };
    d.sheets.forEach((sh, i) => tabs.append(h("button", { role: "tab", class: sh.hidden ? "hidden-sheet" : null, onclick: () => show(i) }, icon("table", 12), sh.name)));
    if (d.sheets.length) show(0);
    return [
        strip(note, status),
        metaLine(d.meta, d.truncated ? `first ${d.sheets.length} of ${d.totalSheets} sheets` : null),
        grid,
        d.sheets.length > 1 ? tabs : null,
    ];
}
