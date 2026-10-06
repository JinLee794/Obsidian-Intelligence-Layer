// Activity feed and vault picker views.
import { h, n, ago, clock, ms, noteName, noteFolder, icon, WRITE_TOOLS, api } from "./dom.js";
import { S, A, touchKind } from "./state.js";

// ── Shared bits ─────────────────────────────────────────────────────────

export function vaultBanners() {
    const st = S.state;
    if (!st?.vault) {
        return [
            h(
                "div",
                { class: "banner info" },
                icon("vault", 16),
                h("span", { class: "grow" }, "Pick the Obsidian vault OIL works in to preview, edit and analyse notes."),
                h("button", { class: "btn sm primary", onclick: () => A.setTab("vault") }, "Choose vault"),
            ),
        ];
    }
    if (st.oilMismatch) {
        const oil = st.oilVaults[0];
        return [
            h(
                "div",
                { class: "banner warn" },
                icon("alert", 16),
                h("span", { class: "grow" }, "OIL is configured for ", h("code", null, oil.path), " but the canvas shows ", h("code", null, st.vault.path), ". Notes may be missing."),
                h("button", { class: "btn sm", onclick: () => A.selectVault(oil.path) }, "Use OIL's vault"),
            ),
        ];
    }
    return [];
}

export function kpi(value, label, { ic, tone, spark, sub } = {}) {
    return h(
        "div",
        { class: `kpi ${tone || ""}` },
        h("div", { class: "kpi-top" }, ic ? h("span", { class: "kpi-ic" }, icon(ic, 15)) : null, h("span", { class: "kpi-l" }, label)),
        h("div", { class: "kpi-v" }, typeof value === "number" ? n(value) : value),
        sub ? h("div", { class: "kpi-sub" }, sub) : null,
        spark || null,
    );
}

export function emptyState(ic, title, text, ...actions) {
    return h(
        "div",
        { class: "empty-state" },
        h("div", { class: "empty-orb" }, icon(ic, 28)),
        h("h3", null, title),
        text ? h("p", null, text) : null,
        actions.length ? h("div", { class: "row center gap" }, actions) : null,
    );
}

// ── Activity ────────────────────────────────────────────────────────────

export function activityView() {
    const a = S.activity;
    if (!a) return [skeletonCards(5), skeletonList(6)];
    const missing = new Set(a.missing || []);
    const wrote = (x) => x.modified || x.created || x.failed_writes;
    const changed = a.notes.filter(wrote);
    const read = a.notes.filter((x) => !wrote(x) && x.reads);
    const surfaced = a.notes.filter((x) => !wrote(x) && !x.reads && x.surfaced);

    if (!a.calls.length && !a.notes.length) {
        return [
            ...vaultBanners(),
            emptyState(
                "activity",
                S.scope === "session" ? "No OIL activity in this session yet" : "No OIL activity recorded yet",
                "Notes OIL reads, writes, or surfaces appear here live as Copilot calls the vault tools.",
                S.scope === "session" ? h("button", { class: "btn", onclick: () => A.setScope("all") }, "Show all sessions") : null,
                h("button", { class: "btn", onclick: A.startImport, disabled: Boolean(S.importing) }, icon("refresh", 14), S.importing ? "Importing…" : "Import past sessions"),
                S.state?.vault ? h("button", { class: "btn primary", onclick: () => A.setTab("explorer") }, icon("folderOpen", 14), "Browse the vault") : null,
            ),
        ];
    }

    const writes = a.calls.filter((c) => WRITE_TOOLS.has(c.tool)).length;
    return [
        ...vaultBanners(),
        h(
            "div",
            { class: "kpis" },
            kpi(a.totals.calls, "OIL calls", { ic: "zap", tone: "t1", sub: writes ? `${n(writes)} writes` : "read-only" }),
            kpi(changed.length, "Notes changed", { ic: "edit", tone: "t4" }),
            kpi(read.length, "Notes read", { ic: "eye", tone: "t2" }),
            kpi(surfaced.length, "Surfaced", { ic: "search", tone: "t3" }),
            kpi(a.totals.errors, "Errors", { ic: "alert", tone: a.totals.errors ? "bad" : "t5" }),
        ),
        h(
            "div",
            { class: "act-grid" },
            h(
                "div",
                { class: "act-notes" },
                noteSection("changed", "Changed", "edit", changed, missing),
                noteSection("read", "Read", "eye", read, missing),
                noteSection("surfaced", "Surfaced in results", "search", surfaced, missing),
            ),
            h("div", { class: "card act-feed" }, h("div", { class: "card-h" }, icon("pulse", 15), h("h3", null, "Tool calls"), h("span", { class: "pill" }, n(a.calls.length))), timeline(a.calls)),
        ),
    ];
}

function noteSection(key, label, ic, notes, missing) {
    if (!notes.length) return null;
    const limit = S.showAll[key] ? notes.length : 10;
    return h(
        "section",
        { class: "card" },
        h("div", { class: "card-h" }, icon(ic, 15), h("h3", null, label), h("span", { class: "pill" }, n(notes.length))),
        h(
            "ul",
            { class: "note-list" },
            notes.slice(0, limit).map((note) => h("li", null, noteRow(note, missing.has(note.path)))),
        ),
        notes.length > limit ? h("button", { class: "link more", onclick: () => ((S.showAll[key] = true), A.render()) }, `Show ${notes.length - limit} more`) : null,
    );
}

function noteRow(note, isMissing) {
    const kind = touchKind(note);
    const ic = { created: "plus", modified: "edit", failed: "alert", read: "eye", surfaced: "search" }[kind];
    return h(
        "button",
        { class: `note-row k-${kind}`, title: note.path, onclick: () => A.openNote(note.path, note.modified || note.created || note.failed_writes ? "changes" : "preview") },
        h("span", { class: "nr-ic" }, icon(ic, 14)),
        h("span", { class: "grow min0" }, h("div", { class: "name ellipsis" }, noteName(note.path)), noteFolder(note.path) ? h("div", { class: "folder ellipsis" }, noteFolder(note.path)) : null),
        h(
            "span",
            { class: "badges" },
            isMissing ? h("span", { class: "badge missing", title: "Not found in the selected vault" }, "missing") : null,
            note.created ? h("span", { class: "badge created" }, "created") : null,
            note.modified ? h("span", { class: "badge modified" }, `${note.modified} edit${note.modified > 1 ? "s" : ""}`) : null,
            note.failed_writes ? h("span", { class: "badge error", title: "OIL rejected these writes; the note was not changed" }, `${note.failed_writes} failed`) : null,
            note.reads ? h("span", { class: "badge read" }, `${note.reads} read${note.reads > 1 ? "s" : ""}`) : null,
            note.surfaced && !note.reads && !note.modified && !note.failed_writes ? h("span", { class: "badge" }, `${note.surfaced}×`) : null,
            S.scope === "all" && note.sessions > 1 ? h("span", { class: "badge", title: "sessions" }, `${note.sessions} sessions`) : null,
        ),
        h("span", { class: "muted small nowrap" }, ago(note.last_ts)),
    );
}

function queryOf(args) {
    if (!args) return null;
    for (const k of ["query", "q", "customer", "customer_name", "heading", "section", "field", "filter", "entity"]) {
        if (typeof args[k] === "string" && args[k]) return `${k === "query" || k === "q" ? "" : `${k}: `}${args[k]}`;
    }
    return null;
}

function timeline(calls) {
    const limit = S.showAll.calls ? calls.length : 40;
    return h(
        "ol",
        { class: "timeline" },
        calls.slice(0, limit).map((c) => {
            const isWrite = WRITE_TOOLS.has(c.tool);
            const failed = c.success === 0 || c.error;
            const running = c.success == null && c.duration_ms == null;
            const targets = (c.touches || []).filter((t) => t.kind !== "surfaced");
            const surfacedCount = (c.touches || []).length - targets.length;
            const q = queryOf(c.args);
            return h(
                "li",
                { class: failed ? "err" : isWrite ? "write" : running ? "run" : "" },
                h("span", { class: "tl-dot" }),
                h(
                    "div",
                    { class: "tl-body" },
                    h(
                        "div",
                        { class: "tl-head" },
                        h("span", { class: "tool" }, c.tool),
                        h("span", { class: "grow" }),
                        running ? h("span", { class: "badge run" }, "running") : c.duration_ms != null ? h("span", c.timing === "masked" ? { class: "muted small", title: "Ran in parallel with slower non-OIL tools; this is an upper bound, not OIL's own time." } : { class: "muted small" }, (c.timing === "masked" ? "≤ " : "") + ms(c.duration_ms)) : null,
                        h("span", { class: "muted small", title: c.started_at }, clock(c.started_at)),
                    ),
                    q ? h("div", { class: "q ellipsis", title: q }, icon("search", 12), q) : null,
                    failed && c.error ? h("div", { class: "tl-err" }, c.error) : null,
                    targets.length || surfacedCount
                        ? h(
                              "div",
                              { class: "chips" },
                              targets.map((t) => h("button", { class: `chip k-${t.kind}`, title: `${t.kind}: ${t.path}`, onclick: () => A.openNote(t.path, t.kind === "read" ? "preview" : "changes") }, noteName(t.path))),
                              surfacedCount ? h("span", { class: "chip ghost" }, `+${surfacedCount} surfaced`) : null,
                          )
                        : null,
                ),
            );
        }),
        calls.length > limit ? h("li", { class: "more" }, h("button", { class: "link", onclick: () => ((S.showAll.calls = true), A.render()) }, `Show ${calls.length - limit} more`)) : null,
    );
}

export function skeletonCards(count = 4) {
    return h(
        "div",
        { class: "kpis" },
        Array.from({ length: count }, () => h("div", { class: "kpi skel" }, h("div", { class: "sk sk-s" }), h("div", { class: "sk sk-l" }))),
    );
}

export function skeletonList(count = 5) {
    return h(
        "div",
        { class: "card" },
        Array.from({ length: count }, (_, i) => h("div", { class: "sk sk-row", style: { width: `${92 - ((i * 13) % 35)}%` } })),
    );
}

// ── Vault picker ────────────────────────────────────────────────────────

export function vaultView() {
    const st = S.state;
    const vaults = S.vaults;
    const current = st?.vault?.path?.toLowerCase();
    const out = [];

    if (!st?.vault) {
        out.push(
            h(
                "div",
                { class: "hero" },
                h("div", { class: "hero-orb" }, icon("vault", 30)),
                h("div", null, h("h2", null, "Choose your vault"), h("p", { class: "muted" }, "Pick the Obsidian vault OIL reads and writes. Notes render with that vault's theme and CSS snippets.")),
            ),
        );
    } else {
        const ap = st.appearance;
        out.push(
            h(
                "div",
                { class: "hero current-vault" },
                h("div", { class: "hero-orb" }, h("span", { class: "vi big" }, st.vault.name.charAt(0).toUpperCase())),
                h(
                    "div",
                    { class: "grow min0" },
                    h("div", { class: "eyebrow" }, "Current vault"),
                    h("h2", { class: "ellipsis" }, st.vault.name),
                    h("div", { class: "muted small mono ellipsis", title: st.vault.path }, st.vault.path),
                    !st.vault.isVault ? h("div", { class: "small warn-text" }, "No .obsidian folder here — notes render with default styling.") : null,
                    h(
                        "div",
                        { class: "row gap wrap", style: { marginTop: "10px" } },
                        h(
                            "label",
                            { class: "switch" },
                            h("input", {
                                type: "checkbox",
                                checked: st.useVaultTheme,
                                onchange: async (e) => {
                                    S.state = await api("/api/settings", { method: "POST", body: { useVaultTheme: e.target.checked } });
                                    A.themeChanged();
                                    A.render();
                                },
                            }),
                            h("span", { class: "switch-ui" }),
                            "Use vault theme & snippets",
                        ),
                        ap && st.useVaultTheme
                            ? h(
                                  "span",
                                  { class: "chips" },
                                  h("span", { class: "chip" }, icon("sparkle", 12), ap.themeName || "Default theme"),
                                  h("span", { class: "chip" }, `${ap.snippets.length} snippet${ap.snippets.length === 1 ? "" : "s"}`),
                                  h("span", { class: "chip" }, `${ap.baseTheme} mode`),
                                  ap.accentColor ? h("span", { class: "chip" }, h("i", { class: "swatch", style: { background: ap.accentColor } }), "accent") : null,
                              )
                            : null,
                    ),
                ),
                h(
                    "div",
                    { class: "col gap" },
                    h("button", { class: "btn primary", onclick: () => A.setTab("explorer") }, icon("folderOpen", 14), "Explore"),
                    h("button", { class: "btn", onclick: () => A.setTab("hygiene") }, icon("shield", 14), "Health check"),
                ),
            ),
        );
    }

    if (st?.oilVaults?.length) {
        out.push(h("h2", { class: "section" }, icon("zap", 14), "OIL is configured for"));
        out.push(h("div", { class: "vault-grid" }, st.oilVaults.map((v) => vaultItem({ name: v.name, path: v.path, exists: v.exists, sub: v.sources.join(", ") }, current))));
    }

    out.push(h("h2", { class: "section" }, icon("vault", 14), "Obsidian vaults on this machine"));
    if (!vaults) out.push(skeletonList(3));
    else if (!vaults.obsidian.length) out.push(h("div", { class: "muted small", style: { marginBottom: "12px" } }, "Obsidian's vault list wasn't found. Browse to your vault folder below."));
    else out.push(h("div", { class: "vault-grid" }, vaults.obsidian.map((v) => vaultItem({ ...v, sub: v.lastOpened ? `Opened ${ago(v.lastOpened)}${v.open ? " · open in Obsidian" : ""}` : null }, current))));

    out.push(h("h2", { class: "section" }, icon("folder", 14), "Browse for a folder"), folderBrowser());
    return out;
}

function vaultItem(v, current) {
    const isCurrent = current && v.path.toLowerCase() === current;
    return h(
        "button",
        { class: `vault-item ${isCurrent ? "current" : ""}`, disabled: !v.exists, onclick: () => A.selectVault(v.path), title: v.exists ? `Use ${v.path}` : "Folder not found" },
        h("span", { class: "vi" }, (v.name || "?").charAt(0).toUpperCase()),
        h("span", { class: "grow min0" }, h("div", { class: "ellipsis strong" }, v.name), h("div", { class: "path ellipsis" }, v.path), v.sub ? h("div", { class: "path ellipsis" }, v.sub) : null),
        isCurrent ? h("span", { class: "badge created" }, icon("check", 11), "selected") : !v.exists ? h("span", { class: "badge missing" }, "missing") : h("span", { class: "vi-go" }, icon("chevron", 14)),
    );
}

function crumbs(path) {
    const isWin = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
    const sep = isWin ? "\\" : "/";
    const parts = path.split(/[\\/]+/).filter(Boolean);
    const out = [];
    let acc = isWin ? "" : "/";
    if (!isWin) out.push({ label: "/", path: "/" });
    parts.forEach((p, i) => {
        acc = isWin && i === 0 ? `${p}\\` : acc.endsWith(sep) ? acc + p : acc + sep + p;
        out.push({ label: p, path: acc });
    });
    return out;
}

function folderBrowser() {
    const fs = S.fs;
    if (!fs) return skeletonList(4);
    const dir = fs.dir;
    return h(
        "div",
        { class: "browser card flush" },
        h("div", { class: "roots" }, fs.roots.map((r) => h("button", { class: "chip", onclick: () => A.browse(r.path) }, icon("folder", 12), r.label))),
        S.fsError ? h("div", { class: "pad small bad-text" }, S.fsError) : null,
        dir
            ? [
                  h(
                      "div",
                      { class: "crumbs" },
                      dir.parent ? h("button", { class: "icon-btn", onclick: () => A.browse(dir.parent), title: "Up one level" }, icon("back", 14)) : null,
                      crumbs(dir.path).map((c, i, all) => [h("button", { class: i === all.length - 1 ? "cur" : "", onclick: () => A.browse(c.path) }, c.label), i < all.length - 1 ? h("span", { class: "sep" }, "›") : null]),
                  ),
                  h(
                      "div",
                      { class: "dir-grid" },
                      dir.entries.length
                          ? dir.entries.map((e) =>
                                h(
                                    "button",
                                    { class: `dir-item ${e.isVault ? "is-vault" : ""}`, onclick: () => A.browse(e.path), ondblclick: () => e.isVault && A.selectVault(e.path), title: e.isVault ? `${e.path}\nDouble-click to use this vault` : e.path },
                                    h("span", { class: "di-ic" }, icon(e.isVault ? "vault" : "folder", 18)),
                                    h("span", { class: "ellipsis" }, e.name),
                                    e.isVault ? h("span", { class: "badge created" }, "vault") : null,
                                ),
                            )
                          : h("div", { class: "pad muted small" }, "No subfolders"),
                  ),
                  h(
                      "div",
                      { class: "dir-foot" },
                      h(
                          "span",
                          { class: "grow small" },
                          dir.isVault
                              ? h("span", { class: "good-text" }, icon("check", 12), " Obsidian vault")
                              : h("span", { class: "muted" }, dir.noteCount ? `${n(dir.noteCount)} notes here · no .obsidian folder` : "Not an Obsidian vault"),
                      ),
                      h("button", { class: "btn primary", onclick: () => A.selectVault(dir.path) }, "Use this folder"),
                  ),
              ]
            : h("div", { class: "pad muted small" }, "Pick a starting location above."),
    );
}
