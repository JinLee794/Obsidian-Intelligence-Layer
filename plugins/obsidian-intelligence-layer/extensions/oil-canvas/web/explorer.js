// Explorer: Obsidian-style file tree, note pane (preview / edit / changes) and
// a side panel with links, related notes, local graph, outline and history.
// The root and its iframes persist across renders so previews don't reload.
import { h, n, ago, compact, noteName, noteFolder, isMd, icon, fuzzy, markText, hostIsDark, TOKEN } from "./dom.js";
import { S, A } from "./state.js";
import { forceGraph } from "./charts.js";
import { emptyState, skeletonList, skeletonCards, vaultBanners } from "./panels.js";

const X = {};
const enc = encodeURIComponent;
const KIND_ICON = { created: "plus", modified: "edit", failed: "alert", read: "eye", surfaced: "search" };
const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;
const TREE_CAP = 400;

/** Replace children only when they differ, so persistent iframes aren't reloaded. */
function mount(container, ...all) {
    const els = all.filter(Boolean);
    const kids = container.childNodes;
    if (kids.length === els.length && els.every((el, i) => kids[i] === el)) return;
    container.replaceChildren(...els);
}

function ensureRoot() {
    if (X.root) return;
    X.filter = h("input", {
        type: "search",
        class: "t-filter",
        placeholder: "Filter files…",
        "aria-label": "Filter files",
        oninput: (e) => {
            S.treeFilter = e.target.value;
            renderTree();
        },
        onkeydown: (e) => {
            if (e.key === "Escape") {
                S.treeFilter = "";
                e.target.value = "";
                renderTree();
            } else if (e.key === "Enter") {
                const first = X.treeList.querySelector(".t-row.file");
                first?.click();
            } else if (e.key === "ArrowDown") {
                e.preventDefault();
                X.treeList.querySelector(".t-row")?.focus();
            }
        },
    });
    X.treeHead = h("div", { class: "t-head" });
    X.treeList = h("div", { class: "t-list", role: "tree", onkeydown: treeKeys });
    X.treeFoot = h("div", { class: "t-foot" });
    X.tree = h("aside", { class: "x-tree", "aria-label": "Files" }, X.treeHead, h("label", { class: "t-search" }, icon("search", 13), X.filter), X.treeList, X.treeFoot);
    X.bar = h("div", { class: "note-bar" });
    X.body = h("div", { class: "note-body" });
    X.note = h("div", { class: "note-view" }, X.bar, X.body);
    X.center = h("section", { class: "x-center" });
    X.side = h("aside", { class: "x-side", "aria-label": "Note details" });
    X.scrim = h("div", { class: "x-scrim", onclick: () => closeDrawers() });
    X.root = h("div", { class: "explorer" }, X.tree, X.center, X.side, X.scrim);
    X.frame = h("iframe", { class: "note-frame", sandbox: "allow-scripts", referrerpolicy: "no-referrer", title: "Note preview" });
    X.frameKey = null;
}

function closeDrawers() {
    if (matchMedia("(max-width: 1100px)").matches && S.side.open) A.toggleSide(false);
    if (matchMedia("(max-width: 760px)").matches && S.treePane) A.toggleTree(false);
}

/** Iframes owned by the explorer (for postMessage source checks). */
export function explorerFrame() {
    return X.frame || null;
}

export function explorerView() {
    ensureRoot();
    X.root.classList.toggle("no-tree", !S.treePane);
    X.root.classList.toggle("no-side", !S.note || !S.side.open);
    renderTree();
    renderCenter();
    renderSide();
    return X.root;
}

// ── File tree ───────────────────────────────────────────────────────────

function index() {
    if (X.idx && X.idx.src === S.tree && X.idx.touched === S.touched) return X.idx;
    const kids = new Map();
    const get = (f) => {
        let k = kids.get(f);
        if (!k) kids.set(f, (k = { folders: new Set(), files: [] }));
        return k;
    };
    const addFolder = (f) => {
        while (f && !kids.has(f)) {
            get(f);
            const p = noteFolder(f);
            get(p).folders.add(f);
            f = p;
        }
    };
    get("");
    const files = S.tree?.files || [];
    for (const f of S.tree?.folders || []) addFolder(f);
    for (const file of files) {
        const p = noteFolder(file.path);
        addFolder(p);
        get(p).files.push(file);
    }
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const sorted = new Map();
    for (const [f, k] of kids) {
        sorted.set(f, {
            folders: [...k.folders].sort((a, b) => coll.compare(a.split("/").pop(), b.split("/").pop())),
            files: k.files.sort((a, b) => coll.compare(a.path.split("/").pop(), b.path.split("/").pop())),
        });
    }
    const touchedIn = new Map();
    for (const [p] of S.touched) {
        let f = noteFolder(p);
        while (true) {
            touchedIn.set(f, (touchedIn.get(f) || 0) + 1);
            if (!f) break;
            f = noteFolder(f);
        }
    }
    X.idx = { src: S.tree, touched: S.touched, kids: sorted, touchedIn, mdCount: files.filter((f) => isMd(f.path)).length, fileCount: files.length };
    return X.idx;
}

function treeKeys(e) {
    const rows = [...X.treeList.querySelectorAll(".t-row")];
    const i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    const row = rows[i];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
        if (next) next.focus();
        else if (e.key === "ArrowUp") X.filter.focus();
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && row.dataset.folder != null) {
        e.preventDefault();
        const open = S.treeOpen.has(row.dataset.folder);
        if ((e.key === "ArrowRight") !== open) row.click();
    }
}

function renderTree() {
    if (!X.root) return;
    const st = S.state;
    X.treeHead.replaceChildren(
        h(
            "button",
            { class: "t-vault", title: "Vault home", onclick: () => A.goHome() },
            h("span", { class: "vi sm" }, (st?.vault?.name || "?").charAt(0).toUpperCase()),
            h("span", { class: "ellipsis strong" }, st?.vault?.name || "No vault"),
        ),
        h("span", { class: "grow" }),
        h("button", { class: "icon-btn", title: "New note", onclick: () => A.createNote(S.folder ? `${S.folder}/` : "") }, icon("plus", 15)),
        h("button", { class: "icon-btn", title: "Collapse all", onclick: () => (S.treeOpen.clear(), renderTree()) }, icon("layers", 15)),
        h("button", { class: "icon-btn", title: "Refresh", onclick: () => A.loadTree(true) }, icon("refresh", 15)),
        h("button", { class: "icon-btn", title: "Hide files", onclick: () => A.toggleTree(false) }, icon("sidebarL", 15)),
    );
    if (document.activeElement !== X.filter && X.filter.value !== S.treeFilter) X.filter.value = S.treeFilter;

    if (S.treeError) {
        X.treeList.replaceChildren(h("div", { class: "pad small bad-text" }, S.treeError));
        X.treeFoot.replaceChildren();
        return;
    }
    if (!S.tree) {
        X.treeList.replaceChildren(skeletonList(8));
        X.treeFoot.replaceChildren();
        return;
    }
    const idx = index();
    const active = S.note?.path;
    const q = S.treeFilter.trim();
    const rows = [];
    if (q) {
        const hits = [];
        for (const f of S.tree.files) {
            const m = fuzzy(q, f.path);
            if (m) hits.push({ f, m });
        }
        hits.sort((a, b) => b.m.score - a.m.score || (isMd(b.f.path) ? 1 : 0) - (isMd(a.f.path) ? 1 : 0));
        for (const { f, m } of hits.slice(0, 150)) rows.push(fileRow(f, 0, active, m.idx));
        if (!hits.length) rows.push(h("div", { class: "pad small muted" }, "No matching files.", h("button", { class: "link", onclick: () => A.createNote(q) }, ` Create “${q}”`)));
        else if (hits.length > 150) rows.push(h("div", { class: "pad small muted" }, `${n(hits.length - 150)} more — refine the filter`));
    } else {
        const walk = (folder, depth) => {
            const k = idx.kids.get(folder);
            if (!k) return;
            for (const sub of k.folders) {
                const open = S.treeOpen.has(sub);
                const touched = idx.touchedIn.get(sub) || 0;
                rows.push(
                    h(
                        "button",
                        {
                            class: `t-row folder${open ? " open" : ""}${S.folder === sub && !S.note ? " active" : ""}`,
                            style: { "--d": depth },
                            role: "treeitem",
                            "aria-expanded": String(open),
                            "data-folder": sub,
                            title: sub,
                            onclick: () => {
                                if (open) S.treeOpen.delete(sub);
                                else S.treeOpen.add(sub);
                                renderTree();
                            },
                            ondblclick: () => A.revealFolder(sub),
                        },
                        h("span", { class: "t-chev" }, icon("chevron", 12)),
                        icon(open ? "folderOpen" : "folder", 14),
                        h("span", { class: "t-name ellipsis" }, sub.split("/").pop()),
                        touched ? h("span", { class: "t-count", title: `${touched} touched by OIL` }, touched) : null,
                    ),
                );
                if (open) walk(sub, depth + 1);
            }
            const all = S.showAll[`tree:${folder}`];
            const files = all ? k.files : k.files.slice(0, TREE_CAP);
            for (const f of files) rows.push(fileRow(f, depth, active));
            if (k.files.length > files.length) {
                rows.push(
                    h(
                        "button",
                        { class: "t-row more", style: { "--d": depth }, onclick: () => ((S.showAll[`tree:${folder}`] = true), renderTree()) },
                        h("span", { class: "t-chev" }),
                        `Show ${n(k.files.length - files.length)} more`,
                    ),
                );
            }
        };
        walk("", 0);
        if (!rows.length) rows.push(h("div", { class: "pad small muted" }, "This vault is empty."));
    }
    X.treeList.replaceChildren(...rows);
    X.treeFoot.replaceChildren(
        ...[
            h("span", null, `${n(idx.mdCount)} notes`),
            h("span", null, `${n(idx.fileCount - idx.mdCount)} files`),
            S.touched.size ? h("span", { class: "t-foot-touched" }, h("i", { class: "t-dot k-modified" }), `${n(S.touched.size)} touched`) : null,
            S.tree.truncated ? h("span", { class: "warn-text" }, "truncated") : null,
        ].filter(Boolean),
    );
    if (active && X.lastActive !== active) {
        X.lastActive = active;
        requestAnimationFrame(() => X.treeList.querySelector(".t-row.active")?.scrollIntoView({ block: "nearest" }));
    }
}

function fileRow(f, depth, active, matchIdx) {
    const md = isMd(f.path);
    const kind = S.touched.get(f.path);
    const base = f.path.lastIndexOf("/") + 1;
    const name = md ? noteName(f.path) : f.path.slice(base);
    let label;
    if (matchIdx) {
        const nameIdx = matchIdx.filter((i) => i >= base && i - base < name.length).map((i) => i - base);
        const folderIdx = matchIdx.filter((i) => i < base - 1);
        label = [h("span", { class: "t-name ellipsis" }, ...markText(name, nameIdx)), base ? h("span", { class: "t-path ellipsis" }, ...markText(f.path.slice(0, base - 1), folderIdx)) : null];
    } else label = h("span", { class: "t-name ellipsis" }, name);
    return h(
        "button",
        {
            class: `t-row file${f.path === active ? " active" : ""}${matchIdx ? " flat" : ""}${md ? "" : " attach"}`,
            style: { "--d": depth },
            role: "treeitem",
            title: f.path,
            onclick: () => A.openNote(f.path),
        },
        h("span", { class: "t-chev" }),
        icon(md ? "file" : IMAGE_RE.test(f.path) ? "image" : "paperclip", 14),
        label,
        kind ? h("i", { class: `t-dot k-${kind}`, title: `OIL ${kind}` }) : null,
    );
}

// ── Center ──────────────────────────────────────────────────────────────

function renderCenter() {
    if (!S.state?.vault) {
        mount(X.center, h("div", { class: "page pad-lg" }, ...vaultBanners(), emptyState("vault", "No vault selected", "Choose your Obsidian vault to browse and edit notes here.", h("button", { class: "btn primary", onclick: () => A.setTab("vault") }, "Choose vault"))));
        return;
    }
    if (S.note) {
        renderNoteBar();
        renderNoteBody();
        mount(X.center, X.note);
        return;
    }
    if (S.tag) return mount(X.center, tagView());
    if (S.folder != null && S.folder !== "") return mount(X.center, folderView());
    return mount(X.center, homeView());
}

function treeToggle() {
    return S.treePane ? null : h("button", { class: "icon-btn", title: "Show files", onclick: () => A.toggleTree(true) }, icon("sidebarL", 16));
}

function navButtons() {
    return [
        h("button", { class: "icon-btn", title: "Back (Alt+←)", disabled: !S.hist.back.length, onclick: () => A.back() }, icon("back", 16)),
        h("button", { class: "icon-btn", title: "Forward (Alt+→)", disabled: !S.hist.fwd.length, onclick: () => A.forward() }, icon("fwd", 16)),
    ];
}

function crumbTrail(path, { last = true } = {}) {
    const parts = path.split("/");
    const out = [];
    let acc = "";
    parts.forEach((p, i) => {
        acc = acc ? `${acc}/${p}` : p;
        const isLast = i === parts.length - 1;
        if (isLast && last) out.push(h("span", { class: "cur ellipsis", title: path }, isMd(p) ? noteName(p) : p));
        else {
            const target = acc;
            out.push(h("button", { class: "crumb ellipsis", title: target, onclick: () => A.revealFolder(target) }, p));
        }
        if (!isLast) out.push(h("span", { class: "sep" }, "/"));
    });
    return out;
}

function renderNoteBar() {
    const note = S.note;
    const md = note.kind === "md";
    const info = note.info;
    const writes = info?.history.filter((e) => e.kind === "modified" || e.kind === "created").length || 0;
    const kind = S.touched.get(note.path);
    const seg = (mode, ic, label, extra = {}) =>
        h("button", { "aria-pressed": String(note.mode === mode), title: extra.title || label, disabled: extra.disabled, onclick: () => A.setNoteMode(mode) }, icon(ic, 14), h("span", { class: "lbl" }, label), extra.count ? h("span", { class: "seg-count" }, extra.count) : null);
    X.bar.replaceChildren(
        ...[
            treeToggle(),
            ...navButtons(),
            h("nav", { class: "nb-crumbs min0", "aria-label": "Path" }, crumbTrail(note.path)),
            note.dirty ? h("span", { class: "dirty-dot", title: "Unsaved changes" }) : null,
            kind ? h("span", { class: `chip k-${kind} sm`, title: `OIL ${kind} this note` }, icon(KIND_ICON[kind], 11), kind) : null,
            info && !info.exists ? h("span", { class: "badge missing", title: "Not found in the selected vault" }, "not in vault") : null,
            h("span", { class: "grow" }),
            h(
                "div",
                { class: "seg", role: "group", "aria-label": "View" },
                seg("preview", "eye", "Read"),
                md ? seg("edit", "edit", "Edit", { title: "Edit (Ctrl+E)", disabled: info && !info.exists }) : null,
                seg("changes", "diff", "Changes", { count: writes || null }),
            ),
            h("button", { class: "icon-btn accent", title: "Ask Copilot about this note", onclick: () => A.askCopilot() }, icon("sparkle", 16)),
            h("button", { class: "icon-btn", title: "Open in Obsidian", disabled: info && !info.exists, onclick: () => A.openInObsidian(note.path) }, icon("external", 16)),
            h("button", { class: `icon-btn${S.side.open ? " on" : ""}`, title: S.side.open ? "Hide details" : "Show details", onclick: () => A.toggleSide() }, icon("sidebar", 16)),
        ].filter(Boolean),
    );
}

function renderNoteBody() {
    const note = S.note;
    if (note.mode === "edit") {
        if (note.editor) return mount(X.body, note.editor.el);
        if (note.editError) return mount(X.body, h("div", { class: "pad-lg" }, emptyState("alert", "Can't edit this note", note.editError, h("button", { class: "btn", onclick: () => A.setNoteMode("preview") }, "Back to reading"))));
        return mount(X.body, h("div", { class: "pad-lg" }, skeletonList(10)));
    }
    if (note.mode === "changes") return mount(X.body, h("div", { class: "diffs" }, changesView()));
    if (note.kind === "md") {
        const dark = hostIsDark();
        const key = `${note.path}|${note.version}|${dark}`;
        if (X.frameKey !== key) {
            X.frameKey = key;
            X.frame.title = noteName(note.path);
            X.frame.src = `/render?t=${enc(TOKEN)}&path=${enc(note.path)}&mode=${dark ? "dark" : "light"}&v=${note.version}`;
        }
        return mount(X.body, X.frame);
    }
    if (note.kind === "image") {
        return mount(
            X.body,
            h("div", { class: "asset-view" }, h("img", { src: `/asset?t=${enc(TOKEN)}&path=${enc(note.path)}&v=${note.version}`, alt: noteName(note.path) }), h("div", { class: "muted small" }, note.path, note.info?.size ? ` · ${bytes(note.info.size)}` : "")),
        );
    }
    return mount(
        X.body,
        h(
            "div",
            { class: "pad-lg" },
            emptyState("paperclip", note.path.split("/").pop(), `${note.info?.size ? `${bytes(note.info.size)} · ` : ""}This file type can't be previewed here.`, h("button", { class: "btn primary", onclick: () => A.openInObsidian(note.path) }, icon("external", 14), "Open in Obsidian")),
        ),
    );
}

function bytes(v) {
    if (v == null) return "–";
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

function changesView() {
    const note = S.note;
    if (!note.info) return skeletonList(5);
    const writes = note.info.history.filter((e) => e.kind === "modified" || e.kind === "created");
    if (!writes.length) {
        return emptyState(
            "diff",
            "No recorded changes",
            S.scope === "session" ? "OIL hasn't written to this note in this session." : "OIL hasn't written to this note.",
            S.scope === "session" ? h("button", { class: "btn", onclick: () => A.setScope("all") }, "All sessions") : null,
            h("button", { class: "btn", onclick: () => A.setNoteMode("preview") }, icon("eye", 14), "Read note"),
        );
    }
    if (!note.diffs) return skeletonList(6);
    return note.diffs.map(({ event, diff }, di) => {
        const head = h(
            "div",
            { class: "diff-head" },
            h("span", { class: `badge ${event.kind}` }, event.kind),
            h("span", { class: "mono small" }, event.tool),
            event.success === 0 || event.error ? h("span", { class: "badge error" }, "failed") : null,
            diff ? h("span", { class: "plus" }, `+${diff.added}`) : null,
            diff ? h("span", { class: "minus" }, `−${diff.removed}`) : null,
            diff ? diffMeter(diff) : null,
            h("span", { class: "grow" }),
            h("span", { class: "muted small", title: event.ts }, `${ago(event.ts)}${S.scope === "all" && event.session_name ? ` · ${event.session_name}` : ""}`),
        );
        if (!diff) {
            const a = event.args || {};
            const detail = [a.heading && `section: ${a.heading}`, a.section && `section: ${a.section}`, a.content].filter(Boolean).join("\n\n");
            return h(
                "div",
                { class: "diff", style: { "--i": di } },
                head,
                h("div", { class: "pad small muted" }, event.error ? `Error: ${event.error}` : "No before/after snapshot — this change was recorded while the canvas wasn't capturing (e.g. imported from session history)."),
                detail ? h("pre", { class: "diff-args" }, detail) : null,
            );
        }
        if (!diff.hunks.length) return h("div", { class: "diff", style: { "--i": di } }, head, h("div", { class: "pad small muted" }, "No textual change."));
        return h(
            "div",
            { class: "diff", style: { "--i": di } },
            head,
            diff.hunks.map((hunk) => [
                h("div", { class: "hunk-sep" }, `@@ −${hunk.oldStart} +${hunk.newStart} @@`),
                h(
                    "table",
                    { class: "dl" },
                    h(
                        "tbody",
                        null,
                        hunk.lines.map((l) =>
                            h("tr", { class: l.op === "+" ? "add" : l.op === "-" ? "del" : "" }, h("td", { class: "n" }, l.old ?? ""), h("td", { class: "n" }, l.new ?? ""), h("td", { class: "s" }, l.op === "+" ? "+" : l.op === "-" ? "−" : ""), h("td", null, l.text || " ")),
                        ),
                    ),
                ),
            ]),
        );
    });
}

function diffMeter(diff) {
    const total = diff.added + diff.removed;
    if (!total) return null;
    const blocks = 5;
    const add = Math.round((diff.added / total) * blocks);
    return h(
        "span",
        { class: "diff-meter", "aria-hidden": "true" },
        Array.from({ length: blocks }, (_, i) => h("i", { class: i < add ? "a" : "d" })),
    );
}

function noteCard(path, { sub, kind, i = 0 } = {}) {
    const md = isMd(path);
    const k = kind || S.touched.get(path);
    return h(
        "button",
        { class: `n-card${k ? ` k-${k}` : ""}`, title: path, style: { "--i": i }, onclick: () => A.openNote(path, k && k !== "read" && k !== "surfaced" ? "changes" : "preview") },
        h("span", { class: "n-ic" }, icon(k ? KIND_ICON[k] : md ? "file" : IMAGE_RE.test(path) ? "image" : "paperclip", 15)),
        h("span", { class: "min0 grow" }, h("div", { class: "n-name ellipsis" }, md ? noteName(path) : path.split("/").pop()), h("div", { class: "n-sub ellipsis" }, noteFolder(path) || "vault root")),
        sub ? h("span", { class: "n-meta" }, sub) : null,
    );
}

function homeView() {
    const st = S.state;
    const idx = S.tree ? index() : null;
    const recent = S.tree ? S.tree.files.filter((f) => isMd(f.path)).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 12) : null;
    const touched = (S.activity?.notes || []).slice().sort((a, b) => Date.parse(b.last_ts || 0) - Date.parse(a.last_ts || 0)).slice(0, 12);
    const tags = S.hygiene?.topTags?.slice(0, 18);
    return h(
        "div",
        { class: "page home" },
        h(
            "div",
            { class: "hero home-hero" },
            treeToggle(),
            h("div", { class: "hero-orb" }, icon("vault", 28)),
            h(
                "div",
                { class: "grow min0" },
                h("div", { class: "eyebrow" }, "Vault"),
                h("h2", { class: "ellipsis" }, st.vault.name),
                h(
                    "div",
                    { class: "hero-stats" },
                    idx
                        ? [
                              h("span", null, h("b", null, compact(idx.mdCount)), " notes"),
                              h("span", null, h("b", null, compact(idx.fileCount - idx.mdCount)), " attachments"),
                              h("span", null, h("b", null, compact(Math.max(0, idx.kids.size - 1))), " folders"),
                              S.touched.size ? h("span", null, h("b", null, n(S.touched.size)), S.scope === "session" ? " touched this session" : " touched by OIL") : null,
                          ]
                        : h("span", { class: "muted" }, "Indexing…"),
                ),
            ),
        ),
        h(
            "button",
            { class: "big-search", onclick: () => A.quickSwitcher() },
            icon("search", 18),
            h("span", { class: "grow" }, "Search notes…"),
            h("kbd", null, "Ctrl"),
            h("kbd", null, "O"),
        ),
        h(
            "div",
            { class: "row gap wrap" },
            h("button", { class: "btn", onclick: () => A.createNote("") }, icon("plus", 14), "New note"),
            h("button", { class: "btn", onclick: () => A.setTab("hygiene") }, icon("shield", 14), "Health check"),
            h("button", { class: "btn", onclick: () => A.openInObsidian("") }, icon("external", 14), "Open vault in Obsidian"),
        ),
        touched.length
            ? [
                  h("h2", { class: "section" }, icon("zap", 14), S.scope === "session" ? "Touched by OIL this session" : "Recently touched by OIL", h("span", { class: "pill" }, n(S.activity.notes.length))),
                  h(
                      "div",
                      { class: "n-cards" },
                      touched.map((t, i) => noteCard(t.path, { sub: ago(t.last_ts), i })),
                  ),
              ]
            : null,
        h("h2", { class: "section" }, icon("clock", 14), "Recently modified"),
        recent ? h("div", { class: "n-cards" }, recent.map((f, i) => noteCard(f.path, { sub: ago(f.mtimeMs), i }))) : skeletonCards(6),
        tags?.length
            ? [
                  h("h2", { class: "section" }, icon("hash", 14), "Tags"),
                  h(
                      "div",
                      { class: "tag-cloud" },
                      tags.map((t) => {
                          const max = tags[0].count || 1;
                          return h("button", { class: "tag", style: { "--w": (0.4 + (0.6 * t.count) / max).toFixed(2) }, onclick: () => A.openTag(t.tag) }, `#${t.tag}`, h("span", { class: "tag-n" }, n(t.count)));
                      }),
                  ),
              ]
            : null,
    );
}

function folderView() {
    const folder = S.folder;
    const idx = S.tree ? index() : null;
    const k = idx?.kids.get(folder);
    const files = k ? [...k.files].sort((a, b) => b.mtimeMs - a.mtimeMs) : [];
    const limit = S.showAll[`folder:${folder}`] ? files.length : 60;
    return h(
        "div",
        { class: "page" },
        h(
            "div",
            { class: "folder-head" },
            treeToggle(),
            ...navButtons(),
            h("span", { class: "fh-ic" }, icon("folderOpen", 22)),
            h("div", { class: "min0 grow" }, h("nav", { class: "nb-crumbs" }, h("button", { class: "crumb", onclick: () => A.goHome() }, S.state.vault.name), h("span", { class: "sep" }, "/"), crumbTrail(folder, { last: true })), h("div", { class: "muted small" }, k ? `${n(k.folders.length)} folders · ${n(files.length)} files` : "")),
            h("button", { class: "btn", onclick: () => A.createNote(`${folder}/`) }, icon("plus", 14), "New note here"),
        ),
        !k
            ? S.tree
                ? emptyState("folder", "Folder not found", folder)
                : skeletonCards(6)
            : [
                  k.folders.length
                      ? h(
                            "div",
                            { class: "chips folder-chips" },
                            k.folders.map((f) => h("button", { class: "chip", onclick: () => A.revealFolder(f) }, icon("folder", 12), f.split("/").pop(), idx.touchedIn.get(f) ? h("span", { class: "t-count" }, idx.touchedIn.get(f)) : null)),
                        )
                      : null,
                  files.length ? h("div", { class: "n-cards" }, files.slice(0, limit).map((f, i) => noteCard(f.path, { sub: ago(f.mtimeMs), i: Math.min(i, 20) }))) : h("div", { class: "muted small pad" }, "No files directly in this folder."),
                  files.length > limit ? h("button", { class: "link more", onclick: () => ((S.showAll[`folder:${folder}`] = true), A.render()) }, `Show ${n(files.length - limit)} more`) : null,
              ],
    );
}

function tagView() {
    const t = S.tag;
    return h(
        "div",
        { class: "page" },
        h(
            "div",
            { class: "folder-head" },
            treeToggle(),
            ...navButtons(),
            h("span", { class: "fh-ic tag-ic" }, icon("hash", 22)),
            h("div", { class: "min0 grow" }, h("h2", { class: "ellipsis" }, `#${t.tag}`), h("div", { class: "muted small" }, t.data ? `${n(t.data.total)} notes${t.data.total > t.data.notes.length ? ` · showing ${n(t.data.notes.length)}` : ""} · includes nested tags` : "Searching…")),
            h("button", { class: "btn", onclick: () => A.askCopilot({ title: `Ask about #${t.tag}`, prompt: `Summarize what my Obsidian notes tagged #${t.tag} say, grouped by theme. Use OIL's search_vault / query_frontmatter to find them and cite note names.` }) }, icon("sparkle", 14), "Summarize"),
        ),
        t.error ? h("div", { class: "banner warn" }, icon("alert", 15), t.error) : null,
        !t.data
            ? skeletonCards(6)
            : t.data.notes.length
              ? h(
                    "div",
                    { class: "n-cards" },
                    t.data.notes.map((x, i) => noteCard(x.path, { sub: x.tag !== t.tag ? `#${x.tag}` : ago(x.mtimeMs), i: Math.min(i, 20) })),
                )
              : emptyState("hash", "No notes with this tag", null),
    );
}

// ── Side panel ──────────────────────────────────────────────────────────

const SIDE_TABS = [
    ["links", "link", "Links"],
    ["related", "sparkle", "Related"],
    ["graph", "graph", "Graph"],
    ["outline", "list", "Outline"],
    ["info", "tag", "Properties"],
    ["history", "history", "History"],
];

function renderSide() {
    const note = S.note;
    if (!note) {
        X.side.replaceChildren();
        return;
    }
    const L = note.links;
    const counts = {
        links: L ? L.outgoing.length + L.backlinks.length + L.unresolved.length : null,
        related: L ? L.related.length : null,
        history: note.info ? note.info.history.length : null,
    };
    const tab = SIDE_TABS.some(([k]) => k === S.side.tab) ? S.side.tab : "links";
    const tabs = h(
        "div",
        { class: "side-tabs", role: "tablist" },
        SIDE_TABS.map(([key, ic, label]) =>
            h(
                "button",
                { class: "side-tab", role: "tab", "aria-selected": String(tab === key), title: label, onclick: () => A.setSideTab(key) },
                icon(ic, 15),
                counts[key] ? h("span", { class: "st-count" }, counts[key] > 99 ? "99+" : counts[key]) : null,
            ),
        ),
        h("span", { class: "grow" }),
        h("button", { class: "icon-btn", title: "Close", onclick: () => A.toggleSide(false) }, icon("x", 14)),
    );
    const title = SIDE_TABS.find(([k]) => k === tab)[2];
    let body;
    if (note.kind !== "md" && ["links", "related", "outline", "info"].includes(tab)) body = h("div", { class: "muted small pad" }, "Links and properties are available for markdown notes.");
    else if (tab === "links") body = linksPanel(L);
    else if (tab === "related") body = relatedPanel(L);
    else if (tab === "graph") body = graphPanel(note);
    else if (tab === "outline") body = outlinePanel(note);
    else if (tab === "info") body = infoPanel(note);
    else body = historyPanel(note);
    const scroller = X.side.querySelector(".side-body");
    const keepScroll = X.sideKey === `${note.path}|${tab}` ? scroller?.scrollTop || 0 : 0;
    X.sideKey = `${note.path}|${tab}`;
    const sb = h("div", { class: "side-body" }, h("div", { class: "side-title" }, title), body);
    X.side.replaceChildren(tabs, sb);
    if (keepScroll) sb.scrollTop = keepScroll;
}

function sideRow(path, { meta, onclick, ic, cls = "" } = {}) {
    const md = isMd(path);
    const kind = S.touched.get(path);
    return h(
        "button",
        { class: `side-row ${cls}`, title: path, onclick: onclick || (() => A.openNote(path)) },
        icon(ic || (md ? "file" : IMAGE_RE.test(path) ? "image" : "paperclip"), 14),
        h("span", { class: "min0 grow" }, h("div", { class: "ellipsis sr-name" }, md ? noteName(path) : path.split("/").pop()), noteFolder(path) ? h("div", { class: "ellipsis sr-sub" }, noteFolder(path)) : null),
        kind ? h("i", { class: `t-dot k-${kind}`, title: `OIL ${kind}` }) : null,
        meta != null ? h("span", { class: "sr-meta" }, meta) : null,
    );
}

function section(title, count, ...body) {
    return h("div", { class: "side-sec" }, h("div", { class: "ss-h" }, title, count != null ? h("span", { class: "pill" }, n(count)) : null), ...body);
}

function linksPanel(L) {
    if (!L) return skeletonList(5);
    const out = [];
    out.push(
        section(
            "Backlinks",
            L.backlinks.length,
            L.backlinks.length
                ? L.backlinks.map((b) =>
                      h(
                          "div",
                          { class: "bl" },
                          sideRow(b.path, { meta: b.count > 1 ? `×${b.count}` : null, ic: "backlink" }),
                          (b.snippets || []).slice(0, 2).map((sn) => h("div", { class: "snip" }, sn)),
                      ),
                  )
                : h("div", { class: "muted small" }, "No notes link here yet."),
        ),
    );
    out.push(
        section(
            "Outgoing links",
            L.outgoing.length,
            L.outgoing.length ? L.outgoing.map((o) => sideRow(o.path, { meta: o.embed ? "embed" : o.count > 1 ? `×${o.count}` : null })) : h("div", { class: "muted small" }, "This note doesn't link anywhere."),
        ),
    );
    if (L.unresolved.length) {
        out.push(
            section(
                "Unresolved",
                L.unresolved.length,
                L.unresolved.map((u) =>
                    h(
                        "button",
                        { class: "side-row unresolved", title: `Create “${u.target}”`, onclick: () => A.createNote(u.target) },
                        icon("unlink", 14),
                        h("span", { class: "grow min0 ellipsis sr-name" }, u.target),
                        u.count > 1 ? h("span", { class: "sr-meta" }, `×${u.count}`) : null,
                        h("span", { class: "sr-act" }, icon("plus", 12), "Create"),
                    ),
                ),
            ),
        );
    }
    return out;
}

function relatedPanel(L) {
    if (!L) return skeletonList(5);
    if (!L.related.length) return h("div", { class: "muted small" }, "No related notes found from shared links or tags.");
    const max = Math.max(...L.related.map((r) => r.score), 1);
    return h(
        "div",
        { class: "related" },
        L.related.map((r, i) =>
            h(
                "div",
                { class: "rel", style: { "--i": i } },
                sideRow(r.path, { meta: h("span", { class: "rel-score", title: `score ${r.score.toFixed?.(1) ?? r.score}` }, h("i", { style: { width: `${Math.round((100 * r.score) / max)}%` } })) }),
                h(
                    "div",
                    { class: "reasons" },
                    r.reasons.map((x) => h("span", { class: "reason" }, x)),
                ),
            ),
        ),
    );
}

function graphPanel(note) {
    const depthSeg = h(
        "div",
        { class: "seg sm" },
        [1, 2, 3].map((d) => h("button", { "aria-pressed": String(S.side.depth === d), onclick: () => A.setGraphDepth(d) }, `${d} hop${d > 1 ? "s" : ""}`)),
    );
    if (note.graphError) return [depthSeg, h("div", { class: "small bad-text pad" }, note.graphError)];
    if (!note.graph) return [depthSeg, h("div", { class: "graph-wrap loading" }, h("div", { class: "spinner" }))];
    if (X.graphSrc !== note.graph) {
        X.graphSrc = note.graph;
        X.graphEl = note.graph.nodes.length > 1 ? forceGraph(note.graph, { onOpen: (id) => A.openNote(id), height: 380, highlight: new Set(S.touched.keys()) }) : null;
    }
    const counts = note.graph.nodes.reduce((m, x) => ((m[x.kind] = (m[x.kind] || 0) + 1), m), {});
    return [
        h("div", { class: "row center gap" }, depthSeg, h("span", { class: "grow" }), h("span", { class: "muted small" }, `${n(note.graph.nodes.length)} nodes`)),
        X.graphEl ? h("div", { class: "graph-wrap" }, X.graphEl) : h("div", { class: "muted small pad" }, "No links to graph yet."),
        h(
            "div",
            { class: "legend graph-legend" },
            h("span", null, h("i", { class: "lg center" }), "this note"),
            h("span", null, h("i", { class: "lg note" }), `notes ${n(counts.note || 0)}`),
            counts.attachment ? h("span", null, h("i", { class: "lg attachment" }), `files ${n(counts.attachment)}`) : null,
            counts.unresolved ? h("span", null, h("i", { class: "lg unresolved" }), `unresolved ${n(counts.unresolved)}`) : null,
            h("span", null, h("i", { class: "lg hl" }), "touched by OIL"),
        ),
        h("div", { class: "muted small" }, "Drag to rearrange · scroll to zoom · click to open"),
    ];
}

function outlinePanel(note) {
    const items = note.outline?.length ? note.outline : (note.links?.headings || []).map((x) => ({ level: x.level, text: x.text }));
    if (!note.links && !note.outline) return skeletonList(5);
    if (!items.length) return h("div", { class: "muted small" }, "No headings in this note.");
    const min = Math.min(...items.map((x) => x.level));
    return h(
        "ul",
        { class: "outline" },
        items.map((x) => h("li", { style: { "--l": x.level - min } }, h("button", { class: "ol-item", title: x.text, onclick: () => A.scrollToHeading(x) }, h("span", { class: "ol-h" }, `H${x.level}`), h("span", { class: "ellipsis" }, x.text)))),
    );
}

function infoPanel(note) {
    const L = note.links;
    const info = note.info;
    if (!L) return skeletonList(4);
    const kind = S.touched.get(note.path);
    const stat = (label, value, ic) => h("div", { class: "stat" }, icon(ic, 14), h("div", null, h("div", { class: "stat-v" }, value), h("div", { class: "stat-l" }, label)));
    const taskTotal = L.tasks.open + L.tasks.done;
    return [
        section(
            "Properties",
            L.properties.length,
            L.properties.length ? h("div", { class: "chips" }, L.properties.map((p) => h("span", { class: "chip prop" }, icon("list", 11), p))) : h("div", { class: "muted small" }, "No frontmatter."),
        ),
        section("Tags", L.tags.length, L.tags.length ? h("div", { class: "chips" }, L.tags.map((t) => h("button", { class: "chip tag-chip", onclick: () => A.openTag(t) }, `#${t}`))) : h("div", { class: "muted small" }, "No tags.")),
        section(
            "Stats",
            null,
            h(
                "div",
                { class: "stat-grid" },
                stat("words", n(L.words), "edit"),
                stat("headings", n(L.headings.length), "heading"),
                stat("links out", n(L.outgoing.length), "link"),
                stat("backlinks", n(L.backlinks.length), "backlink"),
                taskTotal ? stat("tasks done", `${n(L.tasks.done)}/${n(taskTotal)}`, "task") : null,
                info?.size != null ? stat("size", bytes(info.size), "weight") : null,
                info?.mtime ? stat("modified", ago(info.mtime), "clock") : null,
                kind ? stat("OIL", kind, KIND_ICON[kind]) : null,
            ),
            taskTotal ? h("div", { class: "task-bar", title: `${n(L.tasks.done)} of ${n(taskTotal)} tasks done` }, h("i", { style: { width: `${(100 * L.tasks.done) / taskTotal}%` } })) : null,
        ),
        h("div", { class: "mono small muted path-line", title: note.path }, note.path),
    ];
}

function historyPanel(note) {
    const info = note.info;
    if (!info) return skeletonList(4);
    if (!info.history.length) return h("div", { class: "muted small" }, S.scope === "session" ? "OIL hasn't touched this note in this session." : "OIL hasn't touched this note.");
    return h(
        "ul",
        { class: "hist" },
        info.history.map((e) => {
            const write = e.kind === "modified" || e.kind === "created";
            return h(
                "li",
                { class: `k-${e.success === 0 || e.error ? "failed" : e.kind}` },
                h("span", { class: "hist-dot" }),
                h(
                    "button",
                    { class: "hist-body", disabled: !write, onclick: () => A.setNoteMode("changes"), title: write ? "Show changes" : e.tool },
                    h("div", { class: "row gap center" }, h("span", { class: `badge ${e.kind}` }, e.kind), h("span", { class: "mono small ellipsis" }, e.tool), e.success === 0 || e.error ? h("span", { class: "badge error" }, "failed") : null),
                    h("div", { class: "muted small" }, `${ago(e.ts)}${S.scope === "all" && e.session_name ? ` · ${e.session_name}` : ""}`),
                ),
            );
        }),
    );
}
