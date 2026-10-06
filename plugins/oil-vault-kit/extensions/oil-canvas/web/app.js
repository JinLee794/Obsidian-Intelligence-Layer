// OIL Vault Activity canvas — core: shell, navigation, data loading, modals, live updates.
// Vanilla JS, no build step. All dynamic text goes through textContent (never innerHTML).
import { h, api, n, params, TOKEN, noteName, noteFolder, isMd, icon, hostIsDark, debounce, fuzzy, markText, toast, WRITE_TOOLS } from "./dom.js";
import { S, A, VIEWS, pref, savePref, touchKind } from "./state.js";
import { activityView, vaultView, vaultBanners } from "./panels.js";
import { explorerView, explorerFrame } from "./explorer.js";
import { analyticsView, hygieneView } from "./insights.js";
import { hideTip } from "./charts.js";
import { createEditor } from "./editor.js";
import { fileKind, fileIcon } from "./filetypes.js";
import { parkMedia } from "./viewers.js";

const enc = encodeURIComponent;
const TABS = [
    ["activity", "activity", "Activity"],
    ["explorer", "folderOpen", "Explorer"],
    ["analytics", "chart", "Analytics"],
    ["hygiene", "shield", "Health"],
    ["vault", "vault", "Vault"],
];

// ── Shell ───────────────────────────────────────────────────────────────

const app = document.getElementById("app");
const header = h("header", { class: "top" });
const tabsEl = h("nav", { class: "tabs", role: "tablist", "aria-label": "Views" });
const main = h("main", { class: "main" });
let lastTab = null;

function renderHeader() {
    const st = S.state;
    const scoped = ["activity", "explorer", "analytics"].includes(S.tab);
    // Native replaceChildren renders null as the text "null", so drop absent parts.
    header.replaceChildren(
        ...[
            h("div", { class: "brand" }, h("span", { class: "logo" }, icon("sparkle", 16)), h("span", { class: "brand-name" }, "OIL"), h("span", { class: "brand-sub" }, "Vault Activity")),
            h(
                "button",
                { class: "vault-chip", title: st?.vault ? `${st.vault.path}\nChange vault` : "Choose a vault", onclick: () => setTab("vault") },
                h("span", { class: "vi xs" }, (st?.vault?.name || "?").charAt(0).toUpperCase()),
                h("span", { class: "ellipsis" }, st?.vault?.name || "Choose vault"),
                icon("chevron", 11, { class: "icon rot90" }),
            ),
            h("span", { class: `live ${S.live ? "on" : ""}`, title: S.live ? "Live — updates as Copilot calls OIL" : "Reconnecting…" }, h("i"), S.live ? "Live" : "Offline"),
            h("span", { class: "grow" }),
            st?.vault ? h("button", { class: "search-btn", title: "Quick switcher (Ctrl+O)", onclick: () => quickSwitcher() }, icon("search", 14), h("span", { class: "lbl" }, "Search notes"), h("kbd", null, "Ctrl O")) : null,
            scoped
                ? h(
                      "div",
                      { class: "seg sm", role: "group", "aria-label": "Scope" },
                      h("button", { "aria-pressed": String(S.scope === "session"), onclick: () => setScope("session"), title: "Only this Copilot session" }, "This session"),
                      h("button", { "aria-pressed": String(S.scope === "all"), onclick: () => setScope("all"), title: "Every recorded session" }, "All sessions"),
                  )
                : null,
        ].filter(Boolean),
    );
    tabsEl.replaceChildren(
        ...TABS.map(([key, ic, label]) => {
            let badge = null;
            if (key === "activity" && S.activity?.notes.length) badge = h("span", { class: "tab-badge" }, n(S.activity.notes.length));
            if (key === "hygiene" && S.hygiene) badge = h("span", { class: `tab-badge score ${S.hygiene.score >= 80 ? "good" : S.hygiene.score >= 60 ? "mid" : "bad"}` }, S.hygiene.score);
            if (key === "analytics" && S.importing) badge = h("span", { class: "tab-badge pulse-dot" });
            return h("button", { class: "tab", role: "tab", "aria-selected": String(S.tab === key), onclick: () => setTab(key) }, icon(ic, 15), h("span", { class: "lbl" }, label), badge);
        }),
        h("span", { class: "tab-ink", "aria-hidden": "true" }),
    );
    const active = tabsEl.querySelector('[aria-selected="true"]');
    const ink = tabsEl.querySelector(".tab-ink");
    if (active && ink) requestAnimationFrame(() => Object.assign(ink.style, { left: `${active.offsetLeft}px`, width: `${active.offsetWidth}px` }));
}

function render() {
    renderView();
    parkMedia();
}

function renderView() {
    hideTip?.();
    renderHeader();
    const entering = lastTab !== S.tab;
    lastTab = S.tab;
    main.dataset.tab = S.tab;
    if (S.tab === "explorer") {
        const root = explorerView();
        if (main.firstChild !== root || main.childNodes.length !== 1) main.replaceChildren(root);
        return;
    }
    let content;
    try {
        if (S.tab === "activity") content = activityView();
        else if (S.tab === "analytics") content = [...vaultBanners(), ...analyticsView()];
        else if (S.tab === "hygiene") content = hygieneView();
        else content = vaultView();
    } catch (err) {
        console.error(err);
        content = [h("div", { class: "banner warn" }, icon("alert", 15), `Render error: ${err.message}`)];
    }
    const scrollTop = entering ? 0 : main.querySelector(":scope > .page")?.scrollTop || 0;
    const page = h("div", { class: `page${entering ? " enter" : ""}` }, S.error ? h("div", { class: "banner warn" }, icon("alert", 15), h("span", { class: "grow" }, S.error), h("button", { class: "btn sm", onclick: () => refreshTab() }, "Retry")) : null, content);
    main.replaceChildren(page);
    if (scrollTop) page.scrollTop = scrollTop;
}

// ── Data loading ────────────────────────────────────────────────────────

async function loadState() {
    S.state = await api("/api/state");
    if (S.state.importing) S.importing = S.state.importing;
    applyAccent();
}

function applyAccent() {
    const color = S.state?.useVaultTheme && S.state?.appearance?.accentColor;
    if (color && /^#[0-9a-f]{3,8}$|^rgb|^hsl/i.test(color)) document.documentElement.style.setProperty("--vault-accent", color);
    else document.documentElement.style.removeProperty("--vault-accent");
}

async function loadActivity() {
    const a = await api(`/api/activity?scope=${S.scope}`);
    S.activity = a;
    const touched = new Map();
    for (const note of a.notes) touched.set(note.path, touchKind(note));
    S.touched = touched;
}

async function loadAnalytics() {
    const qs = `scope=${S.scope}&days=${S.days || ""}`;
    if (S.analyticsView === "search") S.searchStats = await api(`/api/search-analytics?${qs}`);
    else S.analytics = await api(`/api/analytics?${qs}`);
}

function setAnalyticsView(v) {
    if (S.analyticsView === v) return;
    S.analyticsView = v;
    savePref("analyticsView", v);
    render();
    refreshTab();
}

async function loadTree(force = false) {
    if (!S.state?.vault) return;
    if (S.tree && !force) return;
    try {
        S.tree = await api("/api/tree");
        S.treeError = null;
    } catch (err) {
        S.treeError = err.message;
    }
    if (force) render();
}
const reloadTreeSoon = debounce(() => loadTree(true), 600);

async function scanHygiene() {
    if (S.scanning || !S.state?.vault) return;
    S.scanning = true;
    S.hygieneError = null;
    render();
    try {
        S.hygiene = await api("/api/hygiene");
    } catch (err) {
        S.hygieneError = err.message;
    } finally {
        S.scanning = false;
        render();
    }
}

async function browse(path) {
    try {
        S.fs = await api(`/api/fs${path ? `?path=${enc(path)}` : ""}`);
        S.fsError = null;
    } catch (err) {
        S.fsError = err.message;
    }
    render();
}

async function refreshTab() {
    try {
        if (S.tab === "activity") await loadActivity();
        if (S.tab === "explorer") await Promise.all([loadTree(), loadActivity()]);
        if (S.tab === "analytics") await loadAnalytics();
        if (S.tab === "hygiene" && !S.hygiene && !S.scanning) scanHygiene();
        if (S.tab === "vault") {
            await api("/api/vaults").then((v) => (S.vaults = v));
            if (!S.fs) S.fs = await api(`/api/fs${S.state?.vault ? `?path=${enc(S.state.vault.path)}` : ""}`).catch(() => api("/api/fs"));
        }
        S.error = null;
    } catch (err) {
        S.error = err.message;
    }
    render();
}

const scheduleRefresh = debounce(async () => {
    try {
        if (S.tab === "activity" || S.tab === "explorer") await loadActivity();
        else if (S.activity) loadActivity().catch(() => {});
        if (S.tab === "analytics") await loadAnalytics();
        else S.analytics = S.searchStats = null;
    } catch {
        /* keep the last good data */
    }
    render();
}, 300);

// ── Notes ───────────────────────────────────────────────────────────────

function noteKind(path) {
    return fileKind(path);
}

async function loadNoteInfo(note) {
    try {
        const info = await api(`/api/note?path=${enc(note.path)}&scope=${S.scope}`);
        if (S.note !== note) return;
        note.info = info;
        if (note.mode === "changes" || note.diffs) await loadDiffs(note);
    } catch (err) {
        if (S.note === note) toast(err.message, "error");
    }
    if (S.note === note) render();
}

async function loadDiffs(note) {
    const writes = note.info.history.filter((e) => e.kind === "modified" || e.kind === "created");
    const diffs = await Promise.all(
        writes.map(async (event) => ({
            event,
            diff: event.has_snapshot && event.tool_call_id ? await api(`/api/diff?toolCallId=${enc(event.tool_call_id)}`).catch(() => null) : null,
        })),
    );
    if (S.note === note) note.diffs = diffs;
}

async function loadLinks(note) {
    if (note.kind !== "md") return;
    try {
        const links = await api(`/api/links?path=${enc(note.path)}`);
        if (S.note !== note) return;
        note.links = links;
    } catch (err) {
        if (S.note === note) note.links = { outgoing: [], backlinks: [], unresolved: [], tags: [], headings: [], properties: [], words: 0, tasks: { open: 0, done: 0 }, related: [], error: err.message };
    }
    if (S.note === note) render();
}

async function loadGraph(note) {
    if (note.graph || note.graphLoading) return;
    note.graphLoading = true;
    try {
        const g = await api(`/api/graph?path=${enc(note.path)}&depth=${S.side.depth}`);
        if (S.note === note) {
            note.graph = g;
            note.graphError = null;
        }
    } catch (err) {
        if (S.note === note) note.graphError = err.message;
    } finally {
        note.graphLoading = false;
    }
    if (S.note === note) render();
}

async function ensureEditor(note) {
    if (note.editor || note.editLoading || note.kind !== "md") return;
    note.editLoading = true;
    note.editError = null;
    try {
        const r = await api(`/api/raw?path=${enc(note.path)}`);
        if (S.note !== note) return;
        if (!r.exists) throw new Error("This note doesn't exist on disk yet.");
        note.editor = createEditor({
            path: note.path,
            text: r.text,
            mtimeMs: r.mtimeMs,
            files: S.tree?.files.map((f) => f.path) || [],
            mode: pref("editorMode", "edit"),
            isDark: hostIsDark,
            onSaved: (res) => {
                if (S.note !== note) return;
                note.version = Date.now();
                if (!res.unchanged) toast(`Saved ${noteName(note.path)}`, "success", 1800);
                loadLinks(note);
                reloadTreeSoon();
            },
            onDirty: (dirty) => {
                note.dirty = dirty;
                if (S.note === note) render();
            },
            onMode: (m) => savePref("editorMode", m),
        });
    } catch (err) {
        note.editError = err.status === 413 ? "This note is too large to edit in the canvas — open it in Obsidian instead." : err.message;
    } finally {
        note.editLoading = false;
    }
    if (S.note === note) {
        render();
        if (note.mode === "edit") requestAnimationFrame(() => note.editor?.focus());
    }
}

function currentLoc() {
    if (S.note) return { type: "note", path: S.note.path, mode: S.note.mode === "edit" ? "preview" : S.note.mode };
    if (S.tag) return { type: "tag", tag: S.tag.tag };
    if (S.folder) return { type: "folder", folder: S.folder };
    return { type: "home" };
}

const sameLoc = (a, b) => a.type === b.type && a.path === b.path && a.tag === b.tag && a.folder === b.folder;

async function confirmLeave() {
    const ed = S.note?.editor;
    if (!ed?.isDirty()) return true;
    const choice = await modal({
        title: "Unsaved changes",
        icon: "save",
        body: h("p", null, "Save your changes to ", h("b", null, noteName(S.note.path)), " before leaving?"),
        actions: [
            { label: "Cancel", value: null },
            { label: "Discard", value: "discard", kind: "danger" },
            { label: "Save", value: "save", kind: "primary" },
        ],
    });
    if (choice === "save") return await ed.save();
    return choice === "discard";
}

async function go(loc, { push = true, heading = null } = {}) {
    const cur = currentLoc();
    const leavingNote = S.note && !(loc.type === "note" && loc.path === S.note.path);
    if (leavingNote && !(await confirmLeave())) return false;
    if (push && S.state?.vault && !sameLoc(cur, loc) && (S.tab === "explorer" || S.note)) {
        S.hist.back.push(cur);
        if (S.hist.back.length > 60) S.hist.back.shift();
        S.hist.fwd = [];
    }
    if (leavingNote) {
        S.note.editor?.destroy();
        S.note = null;
    }
    hidePopover(true);
    S.tab = "explorer";
    S.tag = null;
    S.folder = null;
    if (loc.type === "note") {
        if (!S.note) {
            const note = { path: loc.path, kind: noteKind(loc.path), mode: "preview", version: Date.now(), info: null, links: null, graph: null, diffs: null, editor: null, outline: null, heading };
            S.note = note;
            revealAncestors(loc.path);
            loadNoteInfo(note);
            loadLinks(note);
            if (S.side.tab === "graph") loadGraph(note);
        } else if (heading) {
            scrollToHeading({ text: heading });
        }
        applyMode(S.note, loc.mode || "preview");
    } else if (loc.type === "tag") {
        S.tag = { tag: loc.tag, data: null };
        const t = S.tag;
        api(`/api/tag?tag=${enc(loc.tag)}`)
            .then((d) => (t.data = d))
            .catch((err) => ((t.error = err.message), (t.data = { tag: loc.tag, total: 0, notes: [] })))
            .finally(() => S.tag === t && render());
    } else if (loc.type === "folder") {
        S.folder = loc.folder;
        revealAncestors(`${loc.folder}/x`);
        S.treeOpen.add(loc.folder);
    }
    loadTree().then(() => render());
    if (!S.activity) loadActivity().then(() => render()).catch(() => {});
    if (loc.type === "home" && !S.hygiene && !S.scanning && S.state?.vault) api("/api/hygiene").then((hy) => ((S.hygiene = hy), render())).catch(() => {});
    render();
    return true;
}

function revealAncestors(path) {
    let f = noteFolder(path);
    while (f) {
        S.treeOpen.add(f);
        f = noteFolder(f);
    }
}

function applyMode(note, mode) {
    if (mode === "edit" && note.kind !== "md") mode = "preview";
    note.mode = mode;
    if (mode === "edit") ensureEditor(note);
    if (mode === "changes" && note.info && !note.diffs) loadDiffs(note).then(() => render());
}

function openNote(path, mode = "preview", { heading = null, push = true } = {}) {
    if (!path) return;
    if (S.note?.path === path && S.tab === "explorer") {
        applyMode(S.note, mode);
        if (heading) scrollToHeading({ text: heading });
        render();
        return;
    }
    return go({ type: "note", path, mode }, { push, heading });
}

function setNoteMode(mode) {
    if (!S.note) return;
    applyMode(S.note, mode);
    render();
}

function scrollToHeading(item) {
    const note = S.note;
    if (!note) return;
    if (note.mode !== "preview" && note.kind === "md") {
        if (note.mode === "edit" && note.editor && note.editor.mode !== "edit") {
            postTo(note.editor.frame, item.id ? { type: "oil-scroll", id: item.id } : { type: "oil-scroll-heading", heading: item.text });
            return;
        }
        note.heading = item.text;
        setNoteMode("preview");
        return;
    }
    postTo(explorerFrame(), item.id ? { type: "oil-scroll", id: item.id } : { type: "oil-scroll-heading", heading: item.text });
}

function postTo(frame, msg) {
    try {
        frame?.contentWindow?.postMessage(msg, "*");
    } catch {
        /* frame gone */
    }
}

async function back() {
    const loc = S.hist.back.pop();
    if (!loc) return;
    const cur = currentLoc();
    if (await go(loc, { push: false })) S.hist.fwd.push(cur);
    else S.hist.back.push(loc);
    render();
}

async function forward() {
    const loc = S.hist.fwd.pop();
    if (!loc) return;
    const cur = currentLoc();
    if (await go(loc, { push: false })) S.hist.back.push(cur);
    else S.hist.fwd.push(loc);
    render();
}

async function setTab(tab) {
    if (!VIEWS.includes(tab)) return;
    hidePopover(true);
    S.tab = tab;
    render();
    refreshTab();
}

function setScope(scope) {
    if (S.scope === scope) return;
    S.scope = scope;
    S.activity = null;
    S.analytics = S.searchStats = null;
    S.touched = new Map();
    if (S.note) {
        S.note.info = null;
        S.note.diffs = null;
        loadNoteInfo(S.note);
    }
    render();
    refreshTab();
}

async function selectVault(path) {
    if (!(await confirmLeave())) return;
    try {
        S.state = await api("/api/vault", { method: "POST", body: { path } });
        resetVault();
        applyAccent();
        toast(`Using vault ${S.state.vault?.name || path}`, "success");
        setTab("explorer");
    } catch (err) {
        toast(err.message, "error", 5000);
    }
}

function resetVault() {
    S.note?.editor?.destroy();
    Object.assign(S, { activity: null, analytics: null, searchStats: null, hygiene: null, hygieneError: null, tree: null, treeError: null, note: null, tag: null, folder: null, touched: new Map(), hist: { back: [], fwd: [] } });
    S.treeOpen.clear();
}

async function startImport() {
    try {
        const r = await api("/api/import-history", { method: "POST", body: {} });
        if (r.otherSession) {
            toast(r.error || "A history import is already running in another session", "info", 5000);
            return;
        }
        S.importing = r.progress || { done: 0, files: 0 };
        S.lastImport = null;
        render();
    } catch (err) {
        toast(err.message, "error", 5000);
    }
}

async function openInObsidian(path) {
    try {
        await api("/api/open-in-obsidian", { method: "POST", body: { path } });
        toast("Opening in Obsidian…", "info", 1800);
    } catch (err) {
        toast(err.message, "error");
    }
}

async function openFile(path) {
    try {
        await api("/api/open-file", { method: "POST", body: { path } });
        toast("Opening in the default app…", "info", 1800);
    } catch (err) {
        toast(err.message, "error");
    }
}

// ── Modals ──────────────────────────────────────────────────────────────

let modalOpen = null;

/** Promise-based dialog. Resolves with the clicked action's value, or null on dismiss. */
function modal({ title, icon: ic, body, actions = [], cls = "", onMount }) {
    modalOpen?.close(null);
    return new Promise((resolve) => {
        const prevFocus = document.activeElement;
        const close = (value) => {
            if (!back.isConnected) return;
            back.classList.add("leaving");
            setTimeout(() => back.remove(), 140);
            document.removeEventListener("keydown", onKey, true);
            modalOpen = null;
            prevFocus?.focus?.();
            resolve(value);
        };
        const onKey = (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close(null);
            }
        };
        const btns = actions.map((a) => h("button", { class: `btn ${a.kind || ""}`, onclick: async () => (a.run ? (await a.run()) !== false && close(a.value) : close(a.value)) }, a.icon ? icon(a.icon, 14) : null, a.label));
        const dlg = h(
            "div",
            { class: `modal ${cls}`, role: "dialog", "aria-modal": "true", "aria-label": title },
            h("div", { class: "modal-h" }, ic ? h("span", { class: "modal-ic" }, icon(ic, 16)) : null, h("h3", null, title), h("span", { class: "grow" }), h("button", { class: "icon-btn", title: "Close", onclick: () => close(null) }, icon("x", 15))),
            h("div", { class: "modal-b" }, body),
            btns.length ? h("div", { class: "modal-f" }, btns) : null,
        );
        const back = h("div", { class: "modal-back", onmousedown: (e) => e.target === back && close(null) }, dlg);
        document.body.append(back);
        document.addEventListener("keydown", onKey, true);
        modalOpen = { close };
        onMount?.({ close, dlg });
        requestAnimationFrame(() => (dlg.querySelector("[autofocus]") || dlg.querySelector("textarea, input, .btn.primary"))?.focus());
    });
}

function askPresets() {
    const note = S.note;
    if (note?.kind === "md") {
        const name = noteName(note.path);
        return [
            ["Summarize", `Summarize my Obsidian note "${note.path}" in 5 bullets and list its open action items. Use OIL's read_note_section / get_note_metadata.`],
            ["Suggest links", `Find notes in my vault related to "${note.path}" that aren't linked yet and suggest where to add [[wikilinks]] (quote the sentence). Use OIL's search_vault and get_related_entities. Don't edit anything until I confirm.`],
            ["Fix this note", `Review "${note.path}" for broken links, missing frontmatter and tags, and formatting issues. Propose fixes, then wait for my OK before using atomic_replace.`],
            ["What changed?", `What did OIL change in "${note.path}" recently, and why? Use get_agent_log and summarize each change.`],
            ["Continue writing", `Read "${name}" and draft the next section in the same voice and structure. Show it to me before appending.`],
        ];
    }
    return [
        ["Vault overview", "Give me an overview of my Obsidian vault: main areas, most active notes, and anything that looks neglected. Use OIL's search_vault, query_frontmatter and check_vault_health."],
        ["Health check", "Run OIL's check_vault_health on my vault and walk me through the top issues with concrete fixes. Don't change anything until I confirm."],
        ["Recent activity", "Summarize what OIL has read and written in my vault recently (use get_agent_log), grouped by customer or topic."],
    ];
}

async function askCopilot({ title, prompt } = {}) {
    const note = S.note;
    const initial = prompt ?? (note ? `About my Obsidian note "${note.path}":\n\n` : "");
    const ta = h("textarea", { class: "ask-input", rows: 10, autofocus: true, spellcheck: "true", placeholder: "Ask Copilot to do something with your vault…" });
    ta.value = initial;
    const count = h("span", { class: "muted small" });
    const upd = () => {
        count.textContent = `${n(ta.value.length)} / 7,800`;
        count.classList.toggle("bad-text", ta.value.length > 7800);
    };
    ta.addEventListener("input", upd);
    upd();
    ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            sendBtn?.click();
        }
    });
    let sendBtn = null;
    const presets = askPresets();
    const body = [
        h("p", { class: "muted small" }, "This message is posted into your Copilot chat session, where the agent can use OIL tools to act on it."),
        prompt ? null : h("div", { class: "chips presets" }, presets.map(([label, text]) => h("button", { class: "chip", onclick: () => ((ta.value = text), upd(), ta.focus()) }, icon("sparkle", 11), label))),
        ta,
        h("div", { class: "row center" }, h("span", { class: "muted small" }, h("kbd", null, "Ctrl"), " + ", h("kbd", null, "Enter"), " to send"), h("span", { class: "grow" }), count),
    ];
    await modal({
        title: title || "Ask Copilot",
        icon: "sparkle",
        cls: "wide",
        body,
        onMount: ({ dlg }) => (sendBtn = dlg.querySelector(".btn.primary")),
        actions: [
            { label: "Cancel", value: null },
            {
                label: "Send to Copilot",
                icon: "send",
                kind: "primary",
                value: true,
                run: async () => {
                    const text = ta.value.trim();
                    if (!text) return false;
                    try {
                        await api("/api/ask-copilot", { method: "POST", body: { prompt: text.slice(0, 7800) } });
                        toast("Sent to Copilot — follow along in the chat", "success", 3500);
                        return true;
                    } catch (err) {
                        toast(err.status === 503 ? "No active Copilot session to send to." : `Couldn't send: ${err.message}`, "error", 5000);
                        return false;
                    }
                },
            },
        ],
    });
}

async function createNote(target = "") {
    if (!S.state?.vault) return setTab("vault");
    let initial = String(target || "").replace(/#.*$/, "").replace(/\|.*$/, "").trim();
    if (initial && !initial.endsWith("/") && !/\.[a-z0-9]{1,6}$/i.test(initial)) initial += ".md";
    const input = h("input", { class: "input mono", type: "text", autofocus: true, spellcheck: "false", placeholder: "Folder/Note name.md" });
    input.value = initial;
    const err = h("div", { class: "bad-text small", hidden: true });
    const folders = S.tree?.folders || [];
    const hint = h("div", { class: "muted small" }, "Path relative to the vault root. Folders are created as needed.");
    const sugg = h("div", { class: "chips" });
    const updSugg = () => {
        const v = input.value;
        const base = v.split("/").pop();
        const q = v.includes("/") ? v.slice(0, v.lastIndexOf("/")) : v;
        const hits = folders
            .map((f) => ({ f, m: fuzzy(q, f) }))
            .filter((x) => x.m && q)
            .sort((a, b) => b.m.score - a.m.score)
            .slice(0, 6);
        sugg.replaceChildren(...hits.map(({ f }) => h("button", { class: "chip", onclick: () => ((input.value = `${f}/${base.includes(".") ? base : base || ""}`), input.focus(), updSugg()) }, icon("folder", 11), f)));
    };
    input.addEventListener("input", updSugg);
    updSugg();
    const run = async () => {
        let path = input.value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
        if (!path || path.endsWith("/")) return fail("Enter a note name.");
        if (!/\.md$/i.test(path)) path += ".md";
        if (path.split("/").some((seg) => seg === ".." || seg === "." || !seg)) return fail("That path isn't valid.");
        try {
            await api("/api/save", { method: "POST", body: { path, text: "", create: true } });
            toast(`Created ${noteName(path)}`, "success");
            await loadTree(true);
            setTimeout(() => openNote(path, "edit"), 0);
            return true;
        } catch (e) {
            if (e.status === 409) {
                setTimeout(() => openNote(path), 0);
                toast("That note already exists — opened it", "info");
                return true;
            }
            return fail(e.message);
        }
    };
    const fail = (msg) => {
        err.textContent = msg;
        err.hidden = false;
        return false;
    };
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            input.closest(".modal")?.querySelector(".btn.primary")?.click();
        }
    });
    await modal({
        title: "New note",
        icon: "plus",
        body: [input, sugg, hint, err],
        actions: [
            { label: "Cancel", value: null },
            { label: "Create", icon: "plus", kind: "primary", value: true, run },
        ],
    });
}

// ── Quick switcher ──────────────────────────────────────────────────────

async function quickSwitcher() {
    if (!S.state?.vault) return setTab("vault");
    if (!S.tree) loadTree().then(() => upd());
    const input = h("input", { class: "qs-input", type: "text", autofocus: true, spellcheck: "false", placeholder: "Find or create a note…", "aria-label": "Search notes" });
    const list = h("div", { class: "qs-list", role: "listbox" });
    let items = [];
    let sel = 0;
    let closeFn = null;
    const pick = (it, e) => {
        closeFn?.(true);
        if (it.create) createNote(it.create);
        else openNote(it.path, e?.ctrlKey ? "edit" : "preview");
    };
    const upd = () => {
        const q = input.value.trim();
        const files = S.tree?.files || [];
        if (!q) {
            const seen = new Set();
            const recent = [...S.hist.back].reverse().filter((l) => l.type === "note").map((l) => l.path);
            const touched = (S.activity?.notes || []).map((x) => x.path);
            const mtime = files.filter((f) => isMd(f.path)).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 10).map((f) => f.path);
            items = [];
            for (const [label, paths] of [["Recent", recent], ["Touched by OIL", touched], ["Recently modified", mtime]]) {
                const fresh = paths.filter((p) => !seen.has(p)).slice(0, 6);
                fresh.forEach((p, i) => {
                    seen.add(p);
                    items.push({ path: p, group: i === 0 ? label : null });
                });
            }
        } else {
            const hits = [];
            for (const f of files) {
                const m = fuzzy(q, f.path);
                if (m) hits.push({ path: f.path, idx: m.idx, score: m.score + (isMd(f.path) ? 50 : 0) });
            }
            hits.sort((a, b) => b.score - a.score);
            items = hits.slice(0, 40);
            const exact = files.some((f) => noteName(f.path).toLowerCase() === q.toLowerCase());
            if (!exact) items.push({ create: q, group: items.length ? null : null });
        }
        sel = Math.min(sel, Math.max(0, items.length - 1));
        list.replaceChildren(
            ...items.map((it, i) => {
                const row = it.create
                    ? h("button", { class: "qs-item create", role: "option" }, icon("plus", 14), h("span", { class: "grow" }, "Create ", h("b", null, it.create)), h("kbd", null, "Enter"))
                    : (() => {
                          const base = it.path.lastIndexOf("/") + 1;
                          const name = isMd(it.path) ? noteName(it.path) : it.path.slice(base);
                          const idx = it.idx || [];
                          const kind = S.touched.get(it.path);
                          return h(
                              "button",
                              { class: "qs-item", role: "option", title: it.path },
                              icon(fileIcon(it.path), 14),
                              h("span", { class: "qs-name ellipsis" }, ...markText(name, idx.filter((x) => x >= base && x - base < name.length).map((x) => x - base))),
                              h("span", { class: "qs-path ellipsis" }, ...markText(noteFolder(it.path), idx.filter((x) => x < base - 1))),
                              kind ? h("i", { class: `t-dot k-${kind}` }) : null,
                          );
                      })();
                row.setAttribute("aria-selected", String(i === sel));
                row.addEventListener("mousemove", () => {
                    if (sel !== i) {
                        sel = i;
                        list.querySelectorAll(".qs-item").forEach((el, j) => el.setAttribute("aria-selected", String(j === sel)));
                    }
                });
                row.addEventListener("click", (e) => pick(it, e));
                return it.group ? [h("div", { class: "qs-group" }, it.group), row] : row;
            }).flat(),
        );
        if (!items.length) list.append(h("div", { class: "qs-empty muted small" }, S.tree ? "No notes yet." : "Loading files…"));
    };
    input.addEventListener("input", () => ((sel = 0), upd()));
    input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length);
            list.querySelectorAll(".qs-item").forEach((el, j) => el.setAttribute("aria-selected", String(j === sel)));
            list.querySelectorAll(".qs-item")[sel]?.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter" && items[sel]) {
            e.preventDefault();
            pick(e.shiftKey && input.value.trim() ? { create: input.value.trim() } : items[sel], e);
        }
    });
    upd();
    await modal({
        title: "Quick switcher",
        icon: "search",
        cls: "qs",
        body: [input, list, h("div", { class: "qs-foot muted small" }, h("span", null, h("kbd", null, "↑↓"), " navigate"), h("span", null, h("kbd", null, "Enter"), " open"), h("span", null, h("kbd", null, "Ctrl"), "+", h("kbd", null, "Enter"), " edit"), h("span", null, h("kbd", null, "Shift"), "+", h("kbd", null, "Enter"), " create"))],
        onMount: ({ close }) => (closeFn = close),
    });
}

// ── Hover preview popover ───────────────────────────────────────────────

const pop = { el: null, frame: null, path: null, hideTimer: null, over: false };

function ensurePopover() {
    if (pop.el) return;
    pop.frame = h("iframe", { class: "pop-frame", sandbox: "allow-scripts", referrerpolicy: "no-referrer", title: "Link preview" });
    pop.title = h("span", { class: "ellipsis grow strong" });
    pop.el = h(
        "div",
        {
            class: "popover",
            hidden: true,
            onmouseenter: () => ((pop.over = true), clearTimeout(pop.hideTimer)),
            onmouseleave: () => ((pop.over = false), hidePopover()),
        },
        h("div", { class: "pop-h" }, icon("file", 13), pop.title, h("button", { class: "icon-btn", title: "Open", onclick: () => (openNote(pop.path), hidePopover(true)) }, icon("external", 13))),
        pop.frame,
    );
    document.body.append(pop.el);
}

function showPopover(sourceFrame, d) {
    if (!d.path || !isMd(d.path) || !sourceFrame) return;
    ensurePopover();
    clearTimeout(pop.hideTimer);
    const fr = sourceFrame.getBoundingClientRect();
    const W = Math.min(440, window.innerWidth - 24);
    const H = Math.min(320, window.innerHeight - 24);
    const linkX = fr.left + (d.rect?.x || 0);
    const linkY = fr.top + (d.rect?.y || 0);
    const linkH = d.rect?.h || 18;
    let left = Math.max(12, Math.min(window.innerWidth - W - 12, linkX));
    let top = linkY + linkH + 8;
    if (top + H > window.innerHeight - 12) top = Math.max(12, linkY - H - 8);
    Object.assign(pop.el.style, { left: `${left}px`, top: `${top}px`, width: `${W}px`, height: `${H}px` });
    if (pop.path !== d.path) {
        pop.path = d.path;
        pop.title.textContent = noteName(d.path);
        pop.frame.src = `/render?t=${enc(TOKEN)}&path=${enc(d.path)}&mode=${hostIsDark() ? "dark" : "light"}&embed=1`;
    }
    pop.el.hidden = false;
    requestAnimationFrame(() => pop.el.classList.add("show"));
}

function hidePopover(now = false) {
    if (!pop.el) return;
    clearTimeout(pop.hideTimer);
    const hide = () => {
        if (pop.over && !now) return;
        pop.el.classList.remove("show");
        pop.el.hidden = true;
    };
    if (now) hide();
    else pop.hideTimer = setTimeout(hide, 350);
}

// ── Messages from note iframes ──────────────────────────────────────────

window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d !== "object" || typeof d.type !== "string") return;
    const noteFrame = explorerFrame();
    const edFrame = S.note?.editor?.frame;
    let source = null;
    if (noteFrame && e.source === noteFrame.contentWindow) source = noteFrame;
    else if (edFrame && e.source === edFrame.contentWindow) source = edFrame;
    else if (pop.frame && e.source === pop.frame.contentWindow) source = pop.frame;
    if (!source) return;
    switch (d.type) {
        case "oil-open-note": {
            const href = typeof d.href === "string" ? d.href : "";
            const hash = href.indexOf("#");
            const heading = hash >= 0 ? decodeURIComponent(href.slice(hash + 1)).replace(/^\^/, "") : null;
            hidePopover(true);
            if (typeof d.path === "string" && d.path) openNote(d.path, "preview", { heading });
            else if (href) createNote(hash >= 0 ? href.slice(0, hash) : href);
            break;
        }
        case "oil-tag":
            if (typeof d.tag === "string") openTag(d.tag.replace(/^#/, ""));
            break;
        case "oil-open-url":
            if (typeof d.url === "string") api("/api/open-url", { method: "POST", body: { url: d.url } }).catch((err) => toast(err.message, "error"));
            break;
        case "oil-hover":
            if (source !== pop.frame && typeof d.path === "string") showPopover(source, d);
            break;
        case "oil-hover-end":
            if (source !== pop.frame) hidePopover();
            break;
        case "oil-outline":
            if (source === noteFrame && S.note && Array.isArray(d.items)) {
                S.note.outline = d.items.filter((x) => x && typeof x.text === "string").slice(0, 300);
                if (S.note.heading) {
                    postTo(noteFrame, { type: "oil-scroll-heading", heading: S.note.heading });
                    S.note.heading = null;
                }
                if (S.side.open && S.side.tab === "outline") render();
            }
            break;
    }
});

// ── Small actions ───────────────────────────────────────────────────────

function openTag(tag) {
    return go({ type: "tag", tag });
}

function revealFolder(folder) {
    if (!folder) return go({ type: "home" });
    return go({ type: "folder", folder });
}

function toggleSide(open = !S.side.open) {
    S.side.open = open;
    savePref("sideOpen", open);
    if (open && S.note && S.side.tab === "graph") loadGraph(S.note);
    render();
}

function toggleTree(open = !S.treePane) {
    S.treePane = open;
    savePref("treePane", open);
    render();
}

function setSideTab(tab) {
    S.side.tab = tab;
    S.side.open = true;
    savePref("sideTab", tab);
    if (tab === "graph" && S.note) loadGraph(S.note);
    render();
}

function setGraphDepth(d) {
    S.side.depth = d;
    if (S.note) {
        S.note.graph = null;
        loadGraph(S.note);
    }
    render();
}

function setDays(d) {
    S.days = d;
    S.analytics = S.searchStats = null;
    render();
    refreshTab();
}

let lastDark = null;
function themeChanged() {
    const dark = hostIsDark();
    if (dark === lastDark) return;
    lastDark = dark;
    document.documentElement.dataset.oilTone = dark ? "dark" : "light";
    if (S.note) {
        S.note.version = Date.now();
        S.note.editor?.refreshPreview();
    }
    if (pop.el) {
        pop.path = null;
        hidePopover(true);
    }
    render();
}

Object.assign(A, {
    render,
    setTab,
    setScope,
    setDays,
    setAnalyticsView,
    openNote,
    setNoteMode,
    openTag,
    revealFolder,
    goHome: () => go({ type: "home" }),
    createNote,
    askCopilot,
    selectVault,
    browse,
    startImport,
    themeChanged,
    back,
    forward,
    toggleSide,
    toggleTree,
    setSideTab,
    setGraphDepth,
    scrollToHeading,
    openInObsidian,
    openFile,
    quickSwitcher,
    scanHygiene,
    loadTree,
});

// ── Keyboard ────────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
    if (modalOpen) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && (e.key === "o" || e.key === "p")) {
        e.preventDefault();
        quickSwitcher();
    } else if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        back();
    } else if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        forward();
    } else if (mod && e.key === "s" && S.note?.editor) {
        e.preventDefault();
        S.note.editor.save();
    } else if (mod && e.key === "e" && S.note?.kind === "md" && S.tab === "explorer" && !e.target.closest?.(".editor")) {
        e.preventDefault();
        setNoteMode(S.note.mode === "edit" ? "preview" : "edit");
    }
});

window.addEventListener("beforeunload", (e) => {
    if (S.note?.editor?.isDirty()) {
        e.preventDefault();
        e.returnValue = "";
    }
});

// ── Live updates ────────────────────────────────────────────────────────

// While the panel is hidden, SSE events only mark data stale; it is refetched once when the panel is shown again.
let staleWhileHidden = false;
function refreshWhenVisible() {
    if (document.hidden) staleWhileHidden = true;
    else scheduleRefresh();
}
document.addEventListener("visibilitychange", () => {
    document.documentElement.classList.toggle("is-hidden", document.hidden);
    if (!document.hidden && staleWhileHidden) {
        staleWhileHidden = false;
        if (S.note) {
            loadNoteInfo(S.note);
            loadLinks(S.note);
        }
        reloadTreeSoon();
        scheduleRefresh();
    }
});

let blipTimer = null;
function blip() {
    const dot = document.querySelector(".live.on");
    if (!dot || document.hidden) return;
    dot.classList.add("blip");
    clearTimeout(blipTimer);
    blipTimer = setTimeout(() => dot.classList.remove("blip"), 2100);
}

function connect() {
    const es = new EventSource(`/events?t=${enc(TOKEN)}`);
    es.addEventListener("hello", () => {
        S.live = true;
        renderHeader();
    });
    es.onerror = () => {
        if (S.live) {
            S.live = false;
            renderHeader();
        }
    };
    es.addEventListener("call", (e) => {
        const d = JSON.parse(e.data);
        blip();
        if (d.phase === "complete" && WRITE_TOOLS.has(d.tool)) S.hygiene && (S.hygiene.stale = true);
        if (document.hidden) {
            const n = S.note;
            if (n && (d.paths || []).includes(n.path) && d.phase === "complete" && WRITE_TOOLS.has(d.tool)) {
                n.version = Date.now();
                n.diffs = null;
                n.editor?.externalChange();
            }
            staleWhileHidden = true;
            return;
        }
        const note = S.note;
        if (note && (d.paths || []).includes(note.path) && d.phase === "complete") {
            if (WRITE_TOOLS.has(d.tool)) {
                note.version = Date.now();
                note.diffs = null;
                note.editor?.externalChange();
                loadLinks(note);
                if (note.mode === "changes") toast(`OIL ${d.tool} changed this note`, "info");
            }
            loadNoteInfo(note);
        }
        if (d.phase === "complete" && WRITE_TOOLS.has(d.tool)) reloadTreeSoon();
        scheduleRefresh();
    });
    es.addEventListener("activity", refreshWhenVisible);
    es.addEventListener("saved", (e) => {
        const d = JSON.parse(e.data);
        reloadTreeSoon();
        if (S.note && d.path === S.note.path) S.note.editor?.externalChange();
    });
    es.addEventListener("state", (e) => {
        const prev = S.state?.vault?.path;
        S.state = JSON.parse(e.data);
        applyAccent();
        if (prev !== S.state.vault?.path) {
            resetVault();
            refreshTab();
        } else if (S.note) S.note.version = Date.now();
        render();
    });
    es.addEventListener("import", (e) => {
        const d = JSON.parse(e.data);
        if (d.running) S.importing = d;
        else {
            S.importing = null;
            S.lastImport = d.error ? { error: d.error } : { ...(d.stats || d) };
            scheduleRefresh();
        }
        if (S.tab === "analytics" || S.tab === "activity") render();
        else renderHeader();
    });
    es.addEventListener("navigate", (e) => {
        const d = JSON.parse(e.data);
        if (d.notePath) openNote(d.notePath, d.mode || "preview");
        else if (d.view) setTab(d.view);
    });
}

// Reload previews when the host switches light/dark.
const themeObserver = new MutationObserver(() => themeChanged());
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-mode", "data-theme-tone", "class", "style"] });
themeObserver.observe(document.body, { attributes: true, attributeFilter: ["data-color-mode", "data-theme-tone", "class"] });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => themeChanged());
window.addEventListener("resize", debounce(() => renderHeader(), 150));

// ── Boot ────────────────────────────────────────────────────────────────

(async () => {
    try {
        await loadState();
    } catch (err) {
        app.replaceChildren(h("div", { class: "page" }, h("div", { class: "empty-state" }, h("div", { class: "empty-orb" }, icon("alert", 28)), h("h3", null, "Couldn't reach the OIL canvas server"), h("p", null, err.message))));
        return;
    }
    app.replaceChildren(h("div", { class: "shell" }, header, tabsEl, main));
    lastDark = hostIsDark();
    document.documentElement.dataset.oilTone = lastDark ? "dark" : "light";
    if (!S.state.vault && !params.get("view")) S.tab = "vault";
    connect();
    const notePath = params.get("notePath");
    if (notePath) openNote(notePath, ["changes", "edit"].includes(params.get("mode")) ? params.get("mode") : "preview", { push: false });
    else {
        render();
        refreshTab();
    }
    if (S.state.vault) setTimeout(() => loadTree(), 50);
})();
