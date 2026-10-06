// Markdown editor: textarea over a syntax-highlight backdrop, [[ autocomplete, live preview, safe saves.
import { h, api, TOKEN, icon, debounce, toast, fuzzy, markText, noteName, isMd } from "./dom.js";

const HL_LIMIT = 150_000;
const enc = encodeURIComponent;
const span = (cls, text) => h("span", { class: cls }, text);

// ── Highlighter ─────────────────────────────────────────────────────────

// Groups: 1-2 code, 3 wikilink, 4 md link, 5 bold, 6 italic, 7 highlight, 8 strike, 9 tag, 10 url.
const INLINE =
    /(`+)([^`\n]+?)\1|(!?\[\[[^\]\n]+\]\])|(!?\[[^\]\n]*\]\([^)\n]*\))|(\*\*[^*\n]+\*\*|__[^_\n]+__)|((?<![*\w])\*(?![\s*])[^*\n]+?\*(?!\*)|(?<![_\w])_(?![\s_])[^_\n]+?_(?![_\w]))|(==[^=\n]+==)|(~~[^~\n]+~~)|((?<![\w/&#])#[\p{L}\p{N}_][\p{L}\p{N}_/-]*)|(https?:\/\/[^\s)>\]]+)/gu;
const INLINE_CLASS = { 1: "code", 3: "wl", 4: "lk", 5: "b", 6: "i", 7: "mk", 8: "st", 9: "tg", 10: "url" };

function inline(text, parent) {
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
        if (m.index > last) parent.append(text.slice(last, m.index));
        const g = [1, 3, 4, 5, 6, 7, 8, 9, 10].find((k) => m[k] !== undefined);
        parent.append(span(INLINE_CLASS[g], m[0]));
        last = m.index + m[0].length;
    }
    if (last < text.length) parent.append(text.slice(last));
}

function highlight(text) {
    const frag = document.createDocumentFragment();
    const lines = text.split("\n");
    let fm = lines[0] === "---" ? 1 : 0;
    let fence = null;
    lines.forEach((line, i) => {
        if (i) frag.append("\n");
        if (fm === 1) {
            const delim = i === 0 || ((line === "---" || line === "...") && i > 0);
            const m = !delim && line.match(/^([\w .-]+)(:)(.*)$/);
            frag.append(m ? h("span", { class: "fm" }, span("fm-k", m[1]), span("md", m[2]), m[3]) : span(`fm${delim ? " md" : ""}`, line));
            if (i > 0 && delim) fm = 2;
            return;
        }
        const f = line.match(/^\s*(`{3,}|~{3,})/);
        if (fence) {
            frag.append(span(f && f[1][0] === fence[0] && f[1].length >= fence.length ? "cb md" : "cb", line));
            if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
            return;
        }
        if (f) {
            fence = f[1];
            frag.append(span("cb md", line));
            return;
        }
        const hm = line.match(/^(#{1,6})(\s.*|$)/);
        if (hm) {
            const el = span(`hd h${hm[1].length}`);
            el.append(span("md", hm[1]));
            inline(hm[2], el);
            frag.append(el);
            return;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            frag.append(span("hr", line));
            return;
        }
        let rest = line;
        const el = span("ln");
        const q = rest.match(/^(\s*>+\s?)(\[![^\]]+\][+-]?)?/);
        if (q) {
            el.className = q[2] ? "ln co" : "ln bq";
            el.append(span("md", q[1]));
            if (q[2]) el.append(span("co-t", q[2]));
            rest = rest.slice(q[0].length);
        }
        const lm = rest.match(/^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX/-]\]\s)?/);
        if (lm) {
            el.append(lm[1], span("lm", lm[2]), lm[3]);
            if (lm[4]) {
                const done = /x/i.test(lm[4]);
                el.append(span(done ? "tk done" : "tk", lm[4]));
                if (done) el.classList.add("done");
            }
            rest = rest.slice(lm[0].length);
        }
        if (/^\s*\|/.test(rest)) el.classList.add("tbl");
        inline(rest, el);
        frag.append(el);
    });
    frag.append("\n");
    return frag;
}

// ── Caret coordinates (mirror div) ──────────────────────────────────────

const MIRROR_PROPS = [
    "boxSizing", "width", "overflowX", "overflowY", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize",
    "lineHeight", "fontFamily", "textAlign", "textTransform", "textIndent", "letterSpacing", "wordSpacing", "tabSize", "whiteSpace", "wordBreak", "overflowWrap",
];

function caretXY(ta, pos) {
    const cs = getComputedStyle(ta);
    const div = h("div", { style: { position: "absolute", visibility: "hidden", top: "0", left: "-9999px", whiteSpace: "pre-wrap" } });
    for (const p of MIRROR_PROPS) div.style[p] = cs[p];
    div.style.height = "auto";
    div.append(ta.value.slice(0, pos));
    const mark = h("span", null, "\u200b");
    div.append(mark);
    document.body.append(div);
    const out = { left: mark.offsetLeft - ta.scrollLeft, top: mark.offsetTop - ta.scrollTop, height: mark.offsetHeight || parseFloat(cs.lineHeight) || 20 };
    div.remove();
    return out;
}

// ── Editor ──────────────────────────────────────────────────────────────

/**
 * opts: { path, text, mtimeMs, files: string[], mode: "edit"|"split"|"preview", isDark(): boolean,
 *         onSaved(result), onDirty(dirty), onMode(mode) }
 */
export function createEditor(opts) {
    const { path } = opts;
    let saved = opts.text ?? "";
    let mtimeMs = opts.mtimeMs;
    let mode = opts.mode || "edit";
    let saving = false;
    let destroyed = false;
    let wasDirty = false;
    let lastPreview = null;
    let draftSeq = 0;
    const plain = saved.length > HL_LIMIT;

    // Basename index for shortest unambiguous wikilinks.
    const files = (opts.files || []).filter((p) => p !== path);
    const baseKey = (p) => (isMd(p) ? noteName(p) : p.split("/").pop()).toLowerCase();
    const baseCount = new Map();
    for (const p of files) baseCount.set(baseKey(p), (baseCount.get(baseKey(p)) || 0) + 1);
    const linkText = (p) => {
        const short = isMd(p) ? noteName(p) : p.split("/").pop();
        if ((baseCount.get(baseKey(p)) || 0) <= 1) return short;
        return isMd(p) ? p.replace(/\.md$/i, "") : p;
    };

    const ta = h("textarea", { class: "ed-input", spellcheck: "true", "aria-label": `Edit ${noteName(path)}`, autocomplete: "off", autocapitalize: "off" });
    ta.value = saved;
    const hl = h("pre", { class: "ed-hl", "aria-hidden": "true" });
    const pane = h("div", { class: `ed-pane${plain ? " plain" : ""}` }, hl, ta);
    const frame = h("iframe", { class: "ed-frame", sandbox: "allow-scripts", referrerpolicy: "no-referrer", title: `Preview of ${noteName(path)}` });
    const preview = h("div", { class: "ed-preview" }, frame);
    const body = h("div", { class: "ed-body" }, pane, preview);
    const banner = h("div", { class: "ed-banner", hidden: true });
    const status = h("span", { class: "ed-status" });
    const counts = h("span", { class: "ed-counts" });
    const pos = h("span", { class: "ed-pos" });
    const saveBtn = h("button", { class: "btn primary sm", title: "Save (Ctrl+S)", onclick: () => save() }, icon("save", 14), h("span", { class: "lbl" }, "Save"));
    const modeBtns = {};
    const seg = h(
        "div",
        { class: "seg sm", role: "group", "aria-label": "Editor layout" },
        [
            ["edit", "edit", "Source"],
            ["split", "split", "Split"],
            ["preview", "eye", "Preview"],
        ].map(([m, ic, label]) => (modeBtns[m] = h("button", { "aria-pressed": "false", title: label, onclick: () => setMode(m) }, icon(ic, 14), h("span", { class: "lbl" }, label)))),
    );
    const tool = (ic, title, fn) =>
        h("button", { class: "tb", title, "aria-label": title, onmousedown: (e) => e.preventDefault(), onclick: () => (fn(), ta.focus()) }, icon(ic, 15));
    const toolbar = h(
        "div",
        { class: "ed-toolbar" },
        h(
            "div",
            { class: "tb-group" },
            tool("bold", "Bold (Ctrl+B)", () => wrap("**", "**")),
            tool("italic", "Italic (Ctrl+I)", () => wrap("*", "*")),
            tool("heading", "Cycle heading", cycleHeading),
            tool("link", "Wikilink (Ctrl+K)", () => (wrap("[[", "]]"), checkAc())),
        ),
        h(
            "div",
            { class: "tb-group" },
            tool("bullet", "Bullet list", () => prefixLines("- ")),
            tool("task", "Task (Ctrl+Enter toggles)", () => prefixLines("- [ ] ")),
            tool("quote", "Quote", () => prefixLines("> ")),
            tool("code", "Code", codeWrap),
            tool("callout", "Callout", insertCallout),
        ),
        h("span", { class: "grow" }),
        status,
        seg,
        saveBtn,
    );
    const foot = h("div", { class: "ed-foot" }, counts, h("span", { class: "grow" }), plain ? h("span", { class: "muted" }, "Highlighting off for large note") : null, pos);
    const ac = h("div", { class: "ac", hidden: true, role: "listbox" });
    const el = h("div", { class: "editor" }, toolbar, banner, body, foot, ac);

    // ── Rendering helpers ───────────────────────────────────────────────
    let hlRaf = 0;
    const renderHl = () => {
        if (plain) return;
        cancelAnimationFrame(hlRaf);
        hlRaf = requestAnimationFrame(() => {
            hl.replaceChildren(highlight(ta.value));
            hl.scrollTop = ta.scrollTop;
        });
    };
    const updateCounts = debounce(() => {
        const v = ta.value;
        const words = (v.replace(/^---\n[\s\S]*?\n---\n/, "").match(/\S+/g) || []).length;
        counts.replaceChildren(`${words.toLocaleString()} words · ${v.length.toLocaleString()} chars`);
    }, 120);
    const updatePos = () => {
        const v = ta.value;
        const c = ta.selectionStart;
        const before = v.slice(0, c);
        const ln = before.split("\n").length;
        const col = c - before.lastIndexOf("\n");
        const sel = ta.selectionEnd - ta.selectionStart;
        pos.replaceChildren(`Ln ${ln}, Col ${col}${sel ? ` · ${sel} selected` : ""}`);
    };
    const isDirty = () => ta.value !== saved;
    const setStatus = () => {
        const dirty = isDirty();
        status.className = `ed-status ${saving ? "saving" : dirty ? "dirty" : "clean"}`;
        status.replaceChildren(saving ? "Saving…" : dirty ? "Unsaved" : "Saved");
        saveBtn.disabled = saving || !dirty;
        if (dirty !== wasDirty) {
            wasDirty = dirty;
            opts.onDirty?.(dirty);
        }
    };

    const updatePreview = debounce(async () => {
        if (destroyed || mode === "edit") return;
        const text = ta.value;
        if (text === lastPreview && frame.src) return;
        lastPreview = text;
        const seq = ++draftSeq;
        let url = `/render?t=${enc(TOKEN)}&path=${enc(path)}&mode=${opts.isDark?.() ? "dark" : "light"}&v=${Date.now()}`;
        if (text !== saved) {
            try {
                const r = await api("/api/draft", { method: "POST", body: { path, text } });
                url += `&draft=${enc(r.id)}`;
            } catch (err) {
                toast(`Preview failed: ${err.message}`, "error");
                return;
            }
        }
        if (seq === draftSeq && !destroyed) frame.src = url;
    }, 380);

    function setMode(m) {
        mode = m;
        body.className = `ed-body mode-${m}`;
        for (const [k, b] of Object.entries(modeBtns)) b.setAttribute("aria-pressed", String(k === m));
        if (m !== "edit") {
            lastPreview = null;
            updatePreview();
        }
        if (m !== "preview") requestAnimationFrame(() => ta.focus({ preventScroll: true }));
        opts.onMode?.(m);
    }

    // ── Text operations (undo-friendly via execCommand) ─────────────────
    function replace(start, end, text, selStart, selEnd) {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(start, end);
        const ok = text ? document.execCommand("insertText", false, text) : start === end || document.execCommand("delete");
        if (!ok) {
            ta.setRangeText(text, start, end, "end");
            ta.dispatchEvent(new Event("input", { bubbles: true }));
        }
        if (selStart != null) ta.setSelectionRange(selStart, selEnd ?? selStart);
    }
    function lineBounds(s = ta.selectionStart, e = ta.selectionEnd) {
        const v = ta.value;
        const start = v.lastIndexOf("\n", s - 1) + 1;
        let end = v.indexOf("\n", e > s && v[e - 1] === "\n" ? e - 1 : e);
        if (end < 0) end = v.length;
        return [start, end];
    }
    function wrap(a, b) {
        const v = ta.value;
        const s0 = ta.selectionStart;
        const e0 = ta.selectionEnd;
        const sel = v.slice(s0, e0);
        if (sel.startsWith(a) && sel.endsWith(b) && sel.length >= a.length + b.length) return replace(s0, e0, sel.slice(a.length, sel.length - b.length), s0, e0 - a.length - b.length);
        if (v.slice(s0 - a.length, s0) === a && v.slice(e0, e0 + b.length) === b) return replace(s0 - a.length, e0 + b.length, sel, s0 - a.length, e0 - a.length);
        replace(s0, e0, a + sel + b, s0 + a.length, e0 + a.length);
    }
    const LIST = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX/-]\]\s)?/;
    function prefixLines(prefix) {
        const [s0, e0] = lineBounds();
        const lines = ta.value.slice(s0, e0).split("\n");
        const has = (l) => l.trimStart().startsWith(prefix.trim()) && (prefix !== "- " || !/^\s*- \[[ xX/-]\]/.test(l));
        const all = lines.every((l) => !l.trim() || has(l));
        const out = lines.map((l) => {
            if (!l.trim() && lines.length > 1) return l;
            if (all) return l.replace(prefix.trim() === ">" ? /^(\s*)>\s?/ : new RegExp(`^(\\s*)${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+$/, "")}\\s?`), "$1");
            const indent = l.match(/^\s*/)[0];
            const body = prefix === "> " ? l.slice(indent.length) : l.slice(indent.length).replace(LIST, "");
            return `${indent}${prefix}${body}`;
        });
        const text = out.join("\n");
        replace(s0, e0, text, lines.length === 1 ? s0 + text.length : s0, s0 + text.length);
    }
    function cycleHeading() {
        const [s0, e0] = lineBounds(ta.selectionStart, ta.selectionStart);
        const line = ta.value.slice(s0, e0);
        const m = line.match(/^(#{1,6})\s+/);
        const level = m ? m[1].length : 0;
        const next = level >= 4 ? 0 : level + 1;
        const bodyText = m ? line.slice(m[0].length) : line;
        const text = next ? `${"#".repeat(next)} ${bodyText}` : bodyText;
        replace(s0, e0, text, s0 + text.length);
    }
    function codeWrap() {
        const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        if (!sel.includes("\n")) return wrap("`", "`");
        const s0 = ta.selectionStart;
        const text = `\`\`\`\n${sel.replace(/\n$/, "")}\n\`\`\`\n`;
        replace(s0, ta.selectionEnd, text, s0 + 3);
    }
    function insertCallout() {
        const [s0, e0] = lineBounds();
        const sel = ta.value.slice(s0, e0);
        const bodyLines = sel.trim() ? sel.split("\n").map((l) => `> ${l}`) : ["> "];
        const text = `> [!note] Title\n${bodyLines.join("\n")}`;
        replace(s0, e0, text, s0 + 10, s0 + 15);
    }
    function indent(out) {
        const [s0, e0] = lineBounds();
        const lines = ta.value.slice(s0, e0).split("\n");
        const next = lines.map((l) => (out ? l.replace(/^(\t| {1,4})/, "") : `\t${l}`));
        const text = next.join("\n");
        const delta = next[0].length - lines[0].length;
        const multi = ta.selectionStart !== ta.selectionEnd;
        replace(s0, e0, text, multi ? s0 : Math.max(s0, ta.selectionStart + delta), multi ? s0 + text.length : undefined);
    }
    function toggleTask() {
        const [s0, e0] = lineBounds(ta.selectionStart, ta.selectionStart);
        const line = ta.value.slice(s0, e0);
        const m = line.match(/^(\s*[-*+]\s+)\[([ xX])\]/);
        if (!m) return prefixLines("- [ ] ");
        const at = s0 + m[1].length + 1;
        const c = ta.selectionStart;
        replace(at, at + 1, m[2] === " " ? "x" : " ", c);
    }
    function continueList() {
        if (ta.selectionStart !== ta.selectionEnd) return false;
        const c = ta.selectionStart;
        const v = ta.value;
        const s0 = v.lastIndexOf("\n", c - 1) + 1;
        const line = v.slice(s0, c);
        const q = line.match(/^(\s*>+\s?)/);
        const lm = line.slice(q ? q[0].length : 0).match(LIST);
        if (!lm && !q) return false;
        const lead = (q ? q[0] : "") + (lm ? lm[0] : "");
        if (line.trim() === lead.trim()) {
            replace(s0, c, "", s0);
            return true;
        }
        if (v.slice(c, v.indexOf("\n", c) < 0 ? v.length : v.indexOf("\n", c)).trim() && !lm) return false;
        let marker = "";
        if (lm) {
            const num = lm[2].match(/^(\d+)([.)])$/);
            marker = `${lm[1]}${num ? `${Number(num[1]) + 1}${num[2]}` : lm[2]} ${lm[3] ? "[ ] " : ""}`;
        }
        replace(c, c, `\n${q ? q[0] : ""}${marker}`);
        return true;
    }

    // ── [[ autocomplete ─────────────────────────────────────────────────
    let acState = null;
    function closeAc() {
        acState = null;
        ac.hidden = true;
    }
    function checkAc() {
        const c = ta.selectionStart;
        if (c !== ta.selectionEnd || !files.length) return closeAc();
        const before = ta.value.slice(Math.max(0, c - 160), c);
        const m = before.match(/\[\[([^[\]\n|#^]*)$/);
        if (!m) return closeAc();
        const q = m[1];
        const scored = [];
        for (const p of files) {
            const label = isMd(p) ? p.replace(/\.md$/i, "") : p;
            const r = q ? fuzzy(q, label) : { score: -label.length * 0.01, idx: [] };
            if (r) scored.push({ p, label, ...r });
            if (!q && scored.length > 400) break;
        }
        scored.sort((a, b) => b.score - a.score);
        const items = scored.slice(0, 8);
        if (!items.length) return closeAc();
        acState = { start: c - q.length, items, sel: 0 };
        renderAc();
    }
    function renderAc() {
        const { items, sel } = acState;
        ac.replaceChildren(
            ...items.map((it, i) => {
                const name = it.label.split("/").pop();
                const nameStart = it.label.length - name.length;
                const nameIdx = it.idx.filter((x) => x >= nameStart).map((x) => x - nameStart);
                return h(
                    "div",
                    {
                        class: `ac-item${i === sel ? " sel" : ""}`,
                        role: "option",
                        "aria-selected": String(i === sel),
                        onmousedown: (e) => {
                            e.preventDefault();
                            acState.sel = i;
                            acceptAc();
                        },
                    },
                    icon(isMd(it.p) ? "file" : "image", 14),
                    h("span", { class: "ac-name" }, ...markText(name, nameIdx)),
                    it.label.includes("/") ? h("span", { class: "ac-path" }, it.label.slice(0, nameStart - 1)) : null,
                );
            }),
        );
        ac.hidden = false;
        const xy = caretXY(ta, ta.selectionStart);
        const er = el.getBoundingClientRect();
        const tr = ta.getBoundingClientRect();
        let left = tr.left - er.left + xy.left;
        const top = tr.top - er.top + xy.top + xy.height + 4;
        left = Math.max(8, Math.min(left, er.width - 340));
        ac.style.left = `${left}px`;
        ac.style.top = `${Math.min(top, er.height - 40)}px`;
    }
    function acceptAc() {
        if (!acState) return;
        const it = acState.items[acState.sel];
        const c = ta.selectionStart;
        const after = ta.value.slice(c, c + 2);
        const text = linkText(it.p) + (after === "]]" ? "" : "]]");
        const start = acState.start;
        closeAc();
        replace(start, c, text, start + text.length + (after === "]]" ? 2 : 0));
    }

    // ── Events ──────────────────────────────────────────────────────────
    ta.addEventListener("input", () => {
        renderHl();
        updateCounts();
        updatePos();
        setStatus();
        checkAc();
        updatePreview();
    });
    ta.addEventListener("scroll", () => {
        hl.scrollTop = ta.scrollTop;
        hl.scrollLeft = ta.scrollLeft;
        if (acState) closeAc();
    });
    ta.addEventListener("click", () => (updatePos(), checkAc()));
    ta.addEventListener("keyup", (e) => {
        if (!["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(e.key) || !acState) updatePos();
    });
    ta.addEventListener("blur", () => setTimeout(() => document.activeElement !== ta && closeAc(), 120));
    ta.addEventListener("keydown", (e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (acState) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                acState.sel = (acState.sel + (e.key === "ArrowDown" ? 1 : -1) + acState.items.length) % acState.items.length;
                return renderAc();
            }
            if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                return acceptAc();
            }
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                return closeAc();
            }
        }
        if (mod && e.key.toLowerCase() === "s") {
            e.preventDefault();
            save();
        } else if (mod && e.key.toLowerCase() === "b") {
            e.preventDefault();
            wrap("**", "**");
        } else if (mod && e.key.toLowerCase() === "i") {
            e.preventDefault();
            wrap("*", "*");
        } else if (mod && e.key.toLowerCase() === "k") {
            e.preventDefault();
            wrap("[[", "]]");
            checkAc();
        } else if (mod && e.key.toLowerCase() === "e") {
            e.preventDefault();
            setMode(mode === "preview" ? "edit" : "preview");
        } else if (mod && e.key === "Enter") {
            e.preventDefault();
            toggleTask();
        } else if (e.key === "Tab" && !mod && !e.altKey) {
            e.preventDefault();
            const multi = ta.value.slice(ta.selectionStart, ta.selectionEnd).includes("\n");
            const [s0, e0] = lineBounds();
            const onList = LIST.test(ta.value.slice(s0, e0));
            if (e.shiftKey || multi || onList) indent(e.shiftKey);
            else replace(ta.selectionStart, ta.selectionEnd, "\t");
        } else if (e.key === "Enter" && !e.shiftKey && !mod && !e.altKey && !e.isComposing) {
            if (continueList()) e.preventDefault();
        }
    });
    // Ctrl+E / Ctrl+S also work when the preview has focus in the host document.
    el.addEventListener("keydown", (e) => {
        if (e.target === ta) return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === "s") {
            e.preventDefault();
            save();
        } else if (mod && e.key.toLowerCase() === "e") {
            e.preventDefault();
            setMode(mode === "preview" ? "edit" : "preview");
        }
    });

    // ── Saving & external changes ───────────────────────────────────────
    function showBanner(kind, message, actions) {
        banner.className = `ed-banner ${kind}`;
        banner.replaceChildren(icon("alert", 16), h("span", { class: "grow" }, message), ...actions);
        banner.hidden = false;
    }
    const hideBanner = () => (banner.hidden = true);

    async function save({ expected } = {}) {
        if (saving || destroyed) return false;
        const text = ta.value;
        if (text === saved && expected == null) return true;
        saving = true;
        setStatus();
        try {
            const r = await api("/api/save", { method: "POST", body: { path, text, expectedMtimeMs: expected ?? mtimeMs } });
            saved = text;
            mtimeMs = r.mtimeMs;
            hideBanner();
            lastPreview = null;
            if (mode !== "edit") updatePreview();
            opts.onSaved?.(r);
            return true;
        } catch (err) {
            if (err.status === 409) {
                const disk = err.data?.mtimeMs;
                showBanner("warn", "This note changed on disk since you opened it — possibly an OIL write.", [
                    h("button", { class: "btn sm", onclick: () => reload() }, icon("refresh", 14), "Load disk version"),
                    h("button", { class: "btn sm danger", onclick: () => save({ expected: disk }) }, icon("save", 14), "Overwrite with mine"),
                ]);
            } else toast(`Save failed: ${err.message}`, "error", 5000);
            return false;
        } finally {
            saving = false;
            setStatus();
        }
    }

    async function reload() {
        const r = await api(`/api/raw?path=${enc(path)}`);
        saved = r.text ?? "";
        mtimeMs = r.mtimeMs;
        ta.value = saved;
        hideBanner();
        renderHl();
        updateCounts();
        updatePos();
        setStatus();
        lastPreview = null;
        if (mode !== "edit") updatePreview();
    }

    /** Called when the note may have changed on disk (OIL write, another save). */
    async function externalChange() {
        if (destroyed || saving) return;
        let r;
        try {
            r = await api(`/api/raw?path=${enc(path)}`);
        } catch {
            return;
        }
        if (r.mtimeMs === mtimeMs) return;
        if (r.text === saved || r.text === ta.value) {
            // Our own save (SSE raced the response) or an identical write.
            mtimeMs = r.mtimeMs;
            if (r.text === ta.value) saved = r.text;
            setStatus();
            return;
        }
        if (!isDirty()) {
            await reload();
            toast(`${noteName(path)} was updated on disk — reloaded`, "info");
        } else {
            showBanner("warn", "This note was changed on disk while you were editing.", [
                h("button", { class: "btn sm", onclick: () => reload() }, icon("refresh", 14), "Discard mine & reload"),
                h("button", { class: "btn sm", onclick: () => hideBanner() }, "Keep editing"),
            ]);
        }
    }

    // ── Init ────────────────────────────────────────────────────────────
    if (!plain) hl.replaceChildren(highlight(saved));
    updateCounts();
    updatePos();
    setStatus();
    setMode(mode);

    return {
        el,
        frame,
        isDirty,
        save,
        reload,
        externalChange,
        setMode,
        get mode() {
            return mode;
        },
        focus: () => ta.focus(),
        refreshPreview: () => {
            lastPreview = null;
            updatePreview();
        },
        destroy() {
            destroyed = true;
            updatePreview.cancel();
            updateCounts.cancel();
            cancelAnimationFrame(hlRaf);
        },
    };
}
