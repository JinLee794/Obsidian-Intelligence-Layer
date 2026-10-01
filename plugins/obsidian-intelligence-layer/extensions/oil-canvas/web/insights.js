// Analytics dashboard and vault hygiene report.
import { h, n, ago, ms, compact, noteName, noteFolder, icon, WRITE_TOOLS } from "./dom.js";
import { S, A } from "./state.js";
import { PALETTE, fillDays, areaChart, donut, calendarHeatmap, punchcard, histogram, latencyRanges, treemap, gauge, sparkline, rankList, columnChart, percentLines, bubbleScatter, stackedBars, funnel } from "./charts.js";
import { kpi, emptyState, skeletonCards, skeletonList, vaultBanners } from "./panels.js";

const card = (title, ic, body, { cls = "", extra = null, sub = null } = {}) =>
    h("section", { class: `card ${cls}` }, h("div", { class: "card-h" }, icon(ic, 15), h("h3", null, title), sub ? h("span", { class: "muted small" }, sub) : null, h("span", { class: "grow" }), extra), body);

const KIND_COLORS = { created: "var(--green)", modified: "var(--amber)", read: "var(--c2)", surfaced: "var(--c3)", failed: "var(--red)" };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hourLabel = (hr) => (hr === 0 ? "12 am" : hr === 12 ? "12 pm" : hr < 12 ? `${hr} am` : `${hr - 12} pm`);

// ── Analytics ───────────────────────────────────────────────────────────

function importBanner() {
    if (!S.lastImport) return null;
    return h(
        "div",
        { class: `banner ${S.lastImport.error ? "warn" : "info"}` },
        icon(S.lastImport.error ? "alert" : "check", 15),
        h(
            "span",
            { class: "grow" },
            S.lastImport.error
                ? `Import failed: ${S.lastImport.error}`
                : `Imported ${n(S.lastImport.calls)} OIL calls from ${n(S.lastImport.scanned)} changed session logs (${n(S.lastImport.skipped)} unchanged skipped) in ${ms(S.lastImport.elapsedMs)}.`,
        ),
        h("button", { class: "icon-btn", title: "Dismiss", onclick: () => ((S.lastImport = null), A.render()) }, icon("x", 14)),
    );
}

function analyticsToolbar() {
    return h(
        "div",
        { class: "toolbar" },
        h(
            "div",
            { class: "seg", role: "group", "aria-label": "Analytics view" },
            [
                ["overview", "chart", "Overview"],
                ["search", "search", "Search"],
            ].map(([v, ic, label]) => h("button", { "aria-pressed": String(S.analyticsView === v), onclick: () => A.setAnalyticsView(v) }, icon(ic, 13), label)),
        ),
        h(
            "div",
            { class: "seg", role: "group", "aria-label": "Range" },
            [
                [7, "7d"],
                [30, "30d"],
                [90, "90d"],
                [0, "All"],
            ].map(([d, label]) => h("button", { "aria-pressed": String(S.days === d), onclick: () => A.setDays(d) }, label)),
        ),
        h("span", { class: "grow" }),
        S.importing ? h("div", { class: "progress", title: "Importing" }, h("div", { style: { width: `${S.importing.files ? Math.round((100 * S.importing.done) / S.importing.files) : 5}%` } })) : null,
        h(
            "button",
            { class: "btn", onclick: A.startImport, disabled: Boolean(S.importing), title: "Scan Copilot session logs for past OIL tool calls" },
            icon("refresh", 14),
            S.importing ? `Importing ${n(S.importing.done)}/${n(S.importing.files)}…` : "Import past sessions",
        ),
    );
}

export function analyticsView() {
    const out = [analyticsToolbar(), importBanner()].filter(Boolean);
    if (S.analyticsView === "search") return [...out, ...searchView()];
    const a = S.analytics;
    if (!a) return [...out, skeletonCards(6), skeletonList(6)];
    const t = a.totals;
    if (!t.calls) {
        out.push(
            emptyState(
                "chart",
                "Nothing to chart yet",
                S.scope === "session" ? "Switch to All sessions, or import past sessions to backfill history." : "Import past sessions to backfill history from Copilot session logs.",
                S.scope === "session" ? h("button", { class: "btn", onclick: () => A.setScope("all") }, "Show all sessions") : null,
            ),
        );
        return out;
    }

    const days = fillDays(a.byDay, Math.min(S.days || 30, 90));
    const tail = days.slice(-30);
    const series = (k) => tail.map((d) => d[k] || 0);
    const successRate = (100 * (t.calls - t.errors)) / t.calls;
    const writeRatio = (100 * t.writes) / t.calls;

    out.push(
        h(
            "div",
            { class: "kpis" },
            kpi(t.calls, "OIL calls", { ic: "zap", tone: "t1", spark: sparkline(series("calls"), { color: "var(--c1)" }), sub: t.last_ts ? `last ${ago(t.last_ts)}` : null }),
            S.scope === "all" ? kpi(t.sessions, "Sessions", { ic: "layers", tone: "t3" }) : null,
            kpi(t.notes, "Notes touched", { ic: "file", tone: "t2" }),
            kpi(t.writes, "Writes", { ic: "edit", tone: "t4", spark: sparkline(series("writes"), { color: "var(--c4)" }) }),
            kpi(t.errors, "Errors", { ic: "alert", tone: t.errors ? "bad" : "t5", spark: t.errors ? sparkline(series("errors"), { color: "var(--red)" }) : null }),
            kpi(ms(t.p50_ms), "Median latency", { ic: "clock", tone: "t6", sub: `p95 ${ms(t.p95_ms)}` }),
        ),
    );

    // Row 1: trend + gauges
    out.push(
        h(
            "div",
            { class: "grid g-trend" },
            card(
                "Activity over time",
                "activity",
                h(
                    "div",
                    null,
                    areaChart(
                        days,
                        [
                            { key: "calls", label: "All calls", color: "var(--c1)" },
                            { key: "writes", label: "Writes", color: "var(--c4)" },
                            { key: "errors", label: "Errors", color: "var(--red)" },
                        ],
                        { height: 200 },
                    ),
                    legend([
                        ["var(--c1)", "All calls"],
                        ["var(--c4)", "Writes"],
                        ["var(--red)", "Errors"],
                    ]),
                ),
                { cls: "span2", sub: days.length ? `${days[0].day} → ${days[days.length - 1].day}` : null },
            ),
            card(
                "Health",
                "target",
                h(
                    "div",
                    { class: "gauges" },
                    h("div", { class: "gauge-cell" }, gauge(successRate, { label: "success" })),
                    h("div", { class: "gauge-cell" }, gauge(writeRatio, { label: "writes", color: "var(--c4)" })),
                ),
            ),
        ),
    );

    // Row 2: calendar + punchcard
    const pc = a.punchcard || [];
    let best = { v: 0, d: 0, hr: 0 };
    const dayTotals = pc.map((row) => row.reduce((x, y) => x + y, 0));
    pc.forEach((row, d) => row.forEach((v, hr) => v > best.v && (best = { v, d, hr })));
    const busiestDay = dayTotals.indexOf(Math.max(...dayTotals, 0));
    out.push(
        h(
            "div",
            { class: "grid g-2" },
            card("Daily rhythm", "calendar", calendarHeatmap(a.byDay, { weeks: 26 }), { sub: "last 26 weeks" }),
            card(
                "When OIL works",
                "clock",
                punchcard(pc),
                {
                    extra: best.v ? h("span", { class: "chips" }, h("span", { class: "chip" }, `Peak ${DAYS[best.d].slice(0, 3)} ${hourLabel(best.hr)}`), h("span", { class: "chip" }, `Busiest: ${DAYS[busiestDay]}`)) : null,
                },
            ),
        ),
    );

    // Row 3: mixes + latency
    const tools = [...a.byTool].sort((x, y) => y.calls - x.calls);
    const topTools = tools.slice(0, 6).map((x, i) => ({ label: x.tool, value: x.calls, color: WRITE_TOOLS.has(x.tool) ? `color-mix(in srgb, var(--c4) ${100 - i * 10}%, var(--c5))` : PALETTE[i % PALETTE.length] }));
    const rest = tools.slice(6).reduce((s, x) => s + x.calls, 0);
    if (rest) topTools.push({ label: "other", value: rest, color: "var(--muted-fill)" });
    const kinds = (a.byKind || []).map((k) => ({ label: k.kind, value: k.touches, color: KIND_COLORS[k.kind] || "var(--c7)" }));
    out.push(
        h(
            "div",
            { class: "grid g-3" },
            card("Tool mix", "layers", donut(topTools, { center: compact(t.calls), sub: "calls" })),
            card("How notes were touched", "eye", kinds.length ? donut(kinds, { center: compact(t.notes), sub: "notes" }) : h("div", { class: "muted small pad" }, "No note touches yet.")),
            card("Latency distribution", "zap", a.latency?.length ? histogram(a.latency, { p50: t.p50_ms, p95: t.p95_ms }) : h("div", { class: "muted small pad" }, "No timings yet."), { sub: `p50 ${ms(t.p50_ms)} · p95 ${ms(t.p95_ms)}` }),
        ),
    );

    // Row 4: per-tool latency + top notes
    out.push(
        h(
            "div",
            { class: "grid g-2" },
            card(
                "Latency by tool",
                "clock",
                h("div", null, latencyRanges(a.toolLatency || [], { limit: 9 }), legend([["var(--c1)", "p50 → p95 range"], ["var(--c4)", "p95"]])),
                { sub: "log scale" },
            ),
            card(
                "Most touched notes",
                "file",
                a.topNotes.length
                    ? rankList(
                          a.topNotes.slice(0, 9).map((x) => ({
                              label: h("button", { class: "link ellipsis", title: x.path, onclick: () => A.openNote(x.path, x.writes ? "changes" : "preview") }, noteName(x.path)),
                              value: x.touches,
                              accent: x.writes,
                              valueText: `${n(x.touches)}${x.writes ? ` · ${n(x.writes)} w` : ""}`,
                          })),
                          { color: "var(--c2)", accent: "var(--c4)" },
                      )
                    : h("div", { class: "muted small pad" }, "No notes yet."),
            ),
        ),
    );

    // Row 5: folders treemap
    if (a.topFolders.length) {
        out.push(
            card(
                "Where in the vault",
                "folder",
                treemap(
                    a.topFolders.slice(0, 24).map((x) => ({ label: x.folder || "(vault root)", folder: x.folder, value: x.touches, notes: x.notes, writes: x.writes, sub: `${n(x.notes)} notes · ${n(x.touches)}` })),
                    { onClick: (r) => A.revealFolder(r.folder || ""), height: 240 },
                ),
                { sub: "click a folder to open it in Explorer" },
            ),
        );
    }

    if (S.scope === "all" && a.bySession.length) {
        const maxCalls = Math.max(1, ...a.bySession.map((x) => x.calls));
        out.push(
            card(
                "Recent sessions",
                "layers",
                h(
                    "table",
                    { class: "table" },
                    h("thead", null, h("tr", null, h("th", null, "Session"), h("th", null, "Calls"), h("th", { class: "r" }, "Writes"), h("th", { class: "r" }, "Span"), h("th", { class: "r" }, "Last"))),
                    h(
                        "tbody",
                        null,
                        a.bySession.slice(0, 15).map((x) => {
                            const span = x.first_ts && x.last_ts ? Date.parse(x.last_ts) - Date.parse(x.first_ts) : null;
                            return h(
                                "tr",
                                null,
                                h("td", { class: "ellipsis", style: { maxWidth: "300px" }, title: `${x.session_id}${x.cwd ? `\n${x.cwd}` : ""}` }, x.name || (x.cwd ? x.cwd.split(/[\\/]/).pop() : x.session_id.slice(0, 8))),
                                h("td", null, h("div", { class: "cell-bar" }, h("div", { class: "cb-track" }, h("div", { class: "cb-fill", style: { width: `${(100 * x.calls) / maxCalls}%` } })), h("span", { class: "num" }, n(x.calls)))),
                                h("td", { class: "r" }, x.writes ? h("span", { class: "badge modified" }, n(x.writes)) : h("span", { class: "muted" }, "–")),
                                h("td", { class: "r muted" }, span != null ? duration(span) : "–"),
                                h("td", { class: "r muted" }, ago(x.last_ts)),
                            );
                        }),
                    ),
                ),
            ),
        );
    }
    return out;
}

// ── Search effort ───────────────────────────────────────────────────────

const SEARCH_COLORS = { search_vault: "var(--c1)", semantic_search: "var(--c2)", query_frontmatter: "var(--c3)", get_customer_context: "var(--c4)", get_related_entities: "var(--c5)" };
const SEARCH_SHORT = { search_vault: "vault", semantic_search: "semantic", query_frontmatter: "frontmatter", get_customer_context: "customer", get_related_entities: "graph" };
const NEXT_KEYS = [
    { key: "read", label: "Read a note", color: "var(--green)" },
    { key: "write", label: "Wrote a note", color: "var(--c5)" },
    { key: "retry", label: "Same tool again", color: "var(--amber)" },
    { key: "switch", label: "Other search tool", color: "var(--c7)" },
    { key: "other", label: "Other OIL call", color: "var(--c6)" },
    { key: "end", label: "Stopped", color: "var(--muted-fill)" },
];
const toolColor = (t) => SEARCH_COLORS[t] || "var(--c8)";
const modeLabel = (tool, mode) => {
    const short = SEARCH_SHORT[tool] || tool;
    return !mode || mode === short ? short : `${short}: ${mode}`;
};
const pctText = (v) => (v == null ? "–" : `${v}%`);
const chainColor = (len) => `color-mix(in srgb, var(--red) ${Math.min(100, Math.max(0, (len - 1) * 12))}%, var(--green))`;

function gapPrompt(zs) {
    return [
        `The OIL canvas found searches the agent ran against my Obsidian vault that returned nothing:`,
        "",
        ...zs.slice(0, 20).map((z) => `- ${z.tool}: "${z.query}" (×${z.count}, ${z.sessions} session${z.sessions === 1 ? "" : "s"})`),
        "",
        "For each, work out whether the information exists in the vault under another name (missing alias, tag, frontmatter key or differently named note) or is genuinely missing. Use the OIL tools (search_vault, semantic_search, query_frontmatter, get_note_metadata) to check.",
        "Propose the smallest fixes that would make these searches succeed next time, such as aliases, frontmatter fields or stub notes. Wait for my confirmation before writing anything.",
    ].join("\n");
}

function chainPrompt(c) {
    return [
        `Answering ${c.prompt ? `"${c.prompt}"` : "one of my prompts"} took the agent ${c.searches} OIL searches${c.opened ? `; the first useful result came on search ${c.searchesToOpen}` : " and none of the results were opened"}:`,
        "",
        ...c.steps.map((s, i) => `${i + 1}. ${s.tool}${s.mode ? ` [${s.mode}]` : ""}: ${s.query ?? "(no query)"} → ${s.failed ? "error" : `${s.hits ?? "?"} hits`}${s.useful ? " (opened)" : ""}`),
        "",
        "Explain why the early searches missed and what in my Obsidian vault (note names, aliases, frontmatter, links) would have let the first search succeed. Propose concrete changes and wait for my confirmation before writing anything.",
    ].join("\n");
}

function searchView() {
    const a = S.searchStats;
    if (!a) return [skeletonCards(6), skeletonList(6)];
    const t = a.totals;
    if (!t.searches) {
        return [
            emptyState(
                "search",
                "No OIL searches yet",
                S.scope === "session"
                    ? "Searches the agent runs in this session will show up here. Switch to All sessions, or import past sessions to backfill."
                    : "Import past sessions to backfill search history from Copilot session logs.",
                S.scope === "session" ? h("button", { class: "btn", onclick: () => A.setScope("all") }, "Show all sessions") : h("button", { class: "btn primary", onclick: A.startImport, disabled: Boolean(S.importing) }, icon("refresh", 14), "Import past sessions"),
            ),
        ];
    }
    const out = [];
    if (t.unattributed && t.unattributed / Math.max(1, t.answers) > 0.2) {
        out.push(
            h(
                "div",
                { class: "banner info" },
                icon("alert", 15),
                h("span", { class: "grow" }, `${n(t.unattributed)} answers come from calls recorded before prompts were tracked, so they're grouped by 5-minute idle gaps. Import past sessions again to attribute them to the exact prompt.`),
                h("button", { class: "btn sm", onclick: A.startImport, disabled: Boolean(S.importing) }, "Re-import"),
            ),
        );
    }

    const days = a.byDay.slice(-30);
    const opened = Math.round(((t.openedRate || 0) * t.searchedAnswers) / 100);
    const firstOpened = Math.round(((t.firstOpenRate || 0) * t.searchedAnswers) / 100);
    out.push(
        h(
            "div",
            { class: "kpis" },
            kpi(t.avgPerAnswer ?? "–", "Searches per answer", { ic: "search", tone: "t1", sub: `median ${t.medianPerAnswer ?? "–"} · p90 ${t.p90PerAnswer ?? "–"} · max ${t.maxPerAnswer ?? "–"}`, spark: days.length > 1 ? sparkline(days.map((d) => d.perAnswer || 0), { color: "var(--c1)" }) : null }),
            kpi(pctText(t.oneShotRate), "One-shot answers", { ic: "target", tone: "t5", sub: `${n(t.searchedAnswers)} answers needed a search` }),
            kpi(pctText(t.firstOpenRate), "First search opened", { ic: "zap", tone: "t2", sub: "agent read what search #1 found" }),
            kpi(t.avgToOpen ?? "–", "Searches to first open", { ic: "layers", tone: "t3", sub: `${n(t.wastedSearches)} misses before a hit` }),
            kpi(pctText(t.zeroRate), "Zero-hit searches", { ic: "ghost", tone: (t.zeroRate || 0) > 25 ? "bad" : "t6", spark: days.length > 1 ? sparkline(days.map((d) => d.zeroRate || 0), { color: "var(--red)" }) : null }),
            kpi(pctText(t.rephraseRate), "Rephrased", { ic: "refresh", tone: "t4", sub: "answers where a query was reworded" }),
        ),
    );

    // Row 1: chain lengths + funnel
    out.push(
        h(
            "div",
            { class: "grid g-trend" },
            card(
                "How many searches to answer one prompt",
                "chart",
                h(
                    "div",
                    null,
                    columnChart(
                        a.chainLengths.map((b, i) => ({ ...b, color: chainColor([1, 2, 3, 4, 5, 7, 10, 13][i] || 13) })),
                        { unit: "answers", tipLabel: (b) => `${b.label} search${b.label === "1" ? "" : "es"} per answer`, height: 170 },
                    ),
                    h("div", { class: "chips center" }, h("span", { class: "chip" }, `avg ${t.avgPerAnswer}`), h("span", { class: "chip" }, `median ${t.medianPerAnswer}`), h("span", { class: "chip" }, `p90 ${t.p90PerAnswer}`), h("span", { class: "chip" }, `longest ${t.maxPerAnswer}`)),
                ),
                { sub: "one answer = one user prompt" },
            ),
            card(
                "From prompt to answer",
                "target",
                funnel([
                    { label: "Prompts using OIL", value: t.answers, color: "var(--c6)" },
                    { label: "Needed a search", value: t.searchedAnswers, color: "var(--c1)", hint: "Prompts where the agent called at least one OIL search tool." },
                    { label: "Opened a result", value: opened, color: "var(--c2)", hint: "The agent went on to read or edit a note one of its searches returned." },
                    { label: "…on the first search", value: firstOpened, color: "var(--green)", hint: "The very first search surfaced the note the agent then used." },
                ]),
            ),
        ),
    );

    // Row 2: mode scatter + position curve
    const modes = a.byMode.filter((m) => m.calls > 0);
    out.push(
        h(
            "div",
            { class: "grid g-2" },
            card(
                "Search types: speed vs. usefulness",
                "zap",
                h(
                    "div",
                    null,
                    bubbleScatter(
                        modes.map((m) => ({
                            label: modeLabel(m.tool, m.mode),
                            x: m.p50,
                            y: m.openRate,
                            size: m.calls,
                            color: toolColor(m.tool),
                            sub: [
                                ["avg hits", m.avgHits ?? "–"],
                                ["zero-hit", pctText(m.zeroRate)],
                                ["p95", ms(m.p95)],
                            ],
                        })),
                        { xLabel: "median latency", yLabel: "opened %" },
                    ),
                    legend(Object.entries(SEARCH_COLORS).filter(([tool]) => modes.some((m) => m.tool === tool)).map(([tool, c]) => [c, tool])),
                ),
                { sub: "bubble size = calls" },
            ),
            card(
                "Does searching more help?",
                "activity",
                h(
                    "div",
                    null,
                    percentLines(
                        a.byPosition,
                        [
                            { key: "openRate", label: "opened", color: "var(--green)" },
                            { key: "zeroRate", label: "zero hits", color: "var(--red)" },
                        ],
                        { labelKey: "position", barKey: "calls", barLabel: "searches", xTitle: "search #" },
                    ),
                    legend([
                        ["var(--green)", "result opened"],
                        ["var(--red)", "returned nothing"],
                        ["var(--muted-fill)", "searches at that position"],
                    ]),
                ),
                { sub: "by position within one answer" },
            ),
        ),
    );

    // Row 3: scorecard
    const maxCalls = Math.max(1, ...modes.map((m) => m.calls));
    const rateBar = (v, color) => h("div", { class: "cell-bar" }, h("div", { class: "cb-track" }, h("div", { class: "cb-fill", style: { width: `${v ?? 0}%`, background: color } })), h("span", { class: "num" }, pctText(v)));
    out.push(
        card(
            "Search type scorecard",
            "list",
            h(
                "div",
                { class: "table-wrap" },
                h(
                    "table",
                    { class: "table" },
                    h("thead", null, h("tr", null, h("th", null, "Tool"), h("th", null, "Mode"), h("th", null, "Calls"), h("th", { class: "r" }, "Avg hits"), h("th", null, "Zero-hit"), h("th", null, "Opened"), h("th", { class: "r" }, "p50"), h("th", { class: "r" }, "p95"))),
                    h(
                        "tbody",
                        null,
                        modes.map((m) =>
                            h(
                                "tr",
                                null,
                                h("td", null, h("span", { class: "tool-dot", style: { background: toolColor(m.tool) } }), h("span", { class: "mono small" }, m.tool)),
                                h("td", null, h("span", { class: "chip sm" }, m.mode)),
                                h("td", null, h("div", { class: "cell-bar" }, h("div", { class: "cb-track" }, h("div", { class: "cb-fill", style: { width: `${(100 * m.calls) / maxCalls}%`, background: toolColor(m.tool) } })), h("span", { class: "num" }, n(m.calls)))),
                                h("td", { class: "r num" }, m.avgHits ?? "–"),
                                h("td", null, rateBar(m.zeroRate, "var(--red)")),
                                h("td", null, rateBar(m.openRate, "var(--green)")),
                                h("td", { class: "r muted" }, ms(m.p50)),
                                h("td", { class: "r muted" }, ms(m.p95)),
                            ),
                        ),
                    ),
                ),
            ),
            { sub: "opened = the agent then read or edited a note that search returned" },
        ),
    );

    // Row 4: next step + first vs winning tool
    const pie = (list) => list.map((x) => ({ label: x.tool, value: x.count, color: toolColor(x.tool) }));
    out.push(
        h(
            "div",
            { class: "grid g-3" },
            card(
                "What the agent did next",
                "fwd",
                h(
                    "div",
                    null,
                    stackedBars(
                        a.byTool.map((x) => ({ label: SEARCH_SHORT[x.tool] || x.tool, parts: x.next })),
                        NEXT_KEYS,
                    ),
                    legend(NEXT_KEYS.map((k) => [k.color, k.label])),
                ),
                { sub: "after each search" },
            ),
            card("First tool tried", "search", a.firstTool.length ? donut(pie(a.firstTool), { center: compact(t.searchedAnswers), sub: "answers" }) : h("div", { class: "muted small pad" }, "No searches yet.")),
            card("Tool that found it", "check", a.winningTool.length ? donut(pie(a.winningTool), { center: compact(opened), sub: "opened" }) : h("div", { class: "muted small pad" }, "No search led to an opened note yet.")),
        ),
    );

    // Row 5: trend
    if (days.length > 1) {
        out.push(
            card(
                "Search effort over time",
                "calendar",
                h(
                    "div",
                    null,
                    areaChart(days, [
                        { key: "searches", label: "Searches", color: "var(--c1)" },
                        { key: "answers", label: "Answers", color: "var(--c2)" },
                        { key: "zero", label: "Zero-hit", color: "var(--red)" },
                    ], { height: 170 }),
                    legend([
                        ["var(--c1)", "Searches"],
                        ["var(--c2)", "Answers"],
                        ["var(--red)", "Zero-hit searches"],
                    ]),
                ),
                { sub: `${days[0].day} → ${days[days.length - 1].day}` },
            ),
        );
    }

    // Row 6: chains
    const chains = S.searchChains === "recent" ? a.recent : a.longest;
    out.push(
        card(
            "Search chains",
            "history",
            chains.length ? h("ol", { class: "chains" }, chains.map(chainItem)) : h("div", { class: "muted small pad" }, "No chains yet."),
            {
                extra: h(
                    "div",
                    { class: "seg sm", role: "group", "aria-label": "Chains" },
                    [
                        ["longest", "Longest"],
                        ["recent", "Recent"],
                    ].map(([v, label]) => h("button", { "aria-pressed": String(S.searchChains === v), onclick: () => ((S.searchChains = v), A.render()) }, label)),
                ),
            },
        ),
    );

    // Row 7: content gaps
    const zs = a.zeroHitQueries;
    if (zs.length) {
        out.push(
            card(
                "Searches that found nothing",
                "ghost",
                h(
                    "div",
                    { class: "table-wrap" },
                    h(
                        "table",
                        { class: "table" },
                        h("thead", null, h("tr", null, h("th", null, "Query"), h("th", null, "Tool"), h("th", { class: "r" }, "Times"), h("th", { class: "r" }, "Sessions"), h("th", { class: "r" }, "Last"))),
                        h(
                            "tbody",
                            null,
                            zs.slice(0, S.showAll["zero-q"] ? zs.length : 10).map((z) =>
                                h(
                                    "tr",
                                    null,
                                    h("td", { class: "ellipsis mono small", style: { maxWidth: "340px" }, title: z.query }, z.query),
                                    h("td", null, h("span", { class: "tool-dot", style: { background: toolColor(z.tool) } }), h("span", { class: "small" }, SEARCH_SHORT[z.tool] || z.tool)),
                                    h("td", { class: "r" }, h("span", { class: "badge error" }, `×${n(z.count)}`)),
                                    h("td", { class: "r muted" }, n(z.sessions)),
                                    h("td", { class: "r muted" }, ago(z.last_ts)),
                                ),
                            ),
                        ),
                    ),
                    zs.length > 10 && !S.showAll["zero-q"] ? h("button", { class: "link", onclick: () => ((S.showAll["zero-q"] = true), A.render()) }, `Show ${zs.length - 10} more`) : null,
                ),
                {
                    sub: "likely content gaps or missing aliases",
                    extra: h("button", { class: "btn sm primary", onclick: () => A.askCopilot({ title: "Fill search gaps", prompt: gapPrompt(zs) }) }, icon("wand", 13), "Fix with Copilot"),
                },
            ),
        );
    }
    return out;
}

function chainItem(c) {
    const key = `chain:${c.key}`;
    const open = Boolean(S.showAll[key]);
    const status = c.opened
        ? h("span", { class: "badge created" }, c.searchesToOpen === 1 ? "first search hit" : `hit on #${c.searchesToOpen}`)
        : h("span", { class: "badge missing" }, "nothing opened");
    return h(
        "li",
        { class: `chain ${open ? "open" : ""}` },
        h(
            "button",
            { class: "chain-head", "aria-expanded": String(open), onclick: () => ((S.showAll[key] = !open), A.render()) },
            h("span", { class: "chain-n", style: { background: chainColor(c.searches) } }, String(c.searches)),
            h(
                "span",
                { class: "chain-main" },
                h("span", { class: `chain-prompt ellipsis ${c.prompt ? "" : "muted"}`, title: c.prompt || "" }, c.prompt || "(prompt not recorded)"),
                h("span", { class: "chain-meta muted small" }, [c.sessionName || c.sessionId?.slice(0, 8), c.ts ? ago(c.ts) : null, c.totalMs ? `${ms(c.totalMs)} searching` : null].filter(Boolean).join(" · ")),
            ),
            h("span", { class: "chain-dots", "aria-hidden": "true" }, c.steps.slice(0, 24).map((s) => h("i", { class: s.useful ? "ok" : s.failed ? "err" : s.hits === 0 ? "zero" : "", style: { "--tc": toolColor(s.tool) } }))),
            c.rephrased ? h("span", { class: "chip sm", title: "The agent reworded a query" }, "rephrased") : null,
            status,
            icon("chevron", 13),
        ),
        open
            ? h(
                  "div",
                  { class: "chain-body" },
                  h(
                      "ol",
                      { class: "steps" },
                      c.steps.map((s, i) =>
                          h(
                              "li",
                              { class: `step ${s.useful ? "ok" : s.failed ? "err" : s.hits === 0 ? "zero" : ""}`, style: { "--tc": toolColor(s.tool), "--i": i } },
                              h("span", { class: "step-n" }, s.useful ? icon("check", 11) : String(i + 1)),
                              h("span", { class: "step-tool" }, modeLabel(s.tool, s.mode)),
                              h("span", { class: "step-q mono ellipsis", title: s.query || "" }, s.query || "–"),
                              h("span", { class: "step-hits" }, s.hits === 0 ? "0 hits" : s.failed ? "error" : s.hits == null ? "?" : `${n(s.hits)} hit${s.hits === 1 ? "" : "s"}`),
                              h("span", { class: "step-ms muted" }, s.ms != null ? ms(s.ms) : ""),
                              h("span", { class: `step-next ${s.next}` }, `→ ${NEXT_KEYS.find((k) => k.key === s.next)?.label.toLowerCase() || s.next}`),
                          ),
                      ),
                  ),
                  c.searches > c.steps.length ? h("div", { class: "muted small" }, `…and ${c.searches - c.steps.length} more`) : null,
                  h("div", { class: "row end" }, h("button", { class: "btn sm", onclick: () => A.askCopilot({ title: "Why so many searches?", prompt: chainPrompt(c) }) }, icon("wand", 13), "Ask Copilot why")),
              )
            : null,
    );
}

function legend(items) {
    return h(
        "div",
        { class: "legend" },
        items.map(([color, label]) => h("span", null, h("i", { style: { background: color } }), label)),
    );
}

function duration(msv) {
    const m = Math.round(msv / 60000);
    if (m < 1) return "<1m";
    if (m < 60) return `${m}m`;
    const hr = Math.floor(m / 60);
    if (hr < 48) return `${hr}h ${m % 60}m`;
    return `${Math.round(hr / 24)}d`;
}

// ── Hygiene ─────────────────────────────────────────────────────────────

const CATS = [
    {
        key: "broken",
        label: "Broken links",
        icon: "unlink",
        tone: "bad",
        desc: "Wikilinks that point at notes that don't exist.",
        ask: "For each broken link, find the note it most likely meant (renamed, moved or misspelled) and fix the link — or tell me if a new note should be created instead.",
    },
    { key: "orphans", label: "Orphan notes", icon: "ghost", tone: "warn", desc: "No links in or out — invisible from the graph.", ask: "Suggest where each note should be linked from (an index, MOC, hub or related note) so it's reachable, and which links it should have." },
    { key: "noBacklinks", label: "No backlinks", icon: "backlink", tone: "info", desc: "Link out, but nothing links to them.", ask: "Suggest existing notes that should link to each of these, quoting the sentence where the link would go." },
    { key: "empty", label: "Empty notes", icon: "empty", tone: "warn", desc: "Fewer than five words of content.", ask: "For each, recommend delete, merge, or flesh out; draft starter content where it makes sense." },
    { key: "duplicates", label: "Duplicate names", icon: "copy", tone: "warn", desc: "Notes sharing a file name make [[links]] ambiguous.", ask: "Compare the notes that share a name and recommend which to keep, merge or rename so links resolve unambiguously." },
    { key: "noFrontmatter", label: "No frontmatter", icon: "list", tone: "info", desc: "Missing the YAML properties block.", ask: "Propose frontmatter (tags, type, dates, related entities) consistent with similar notes in this vault." },
    { key: "untagged", label: "Untagged", icon: "tag", tone: "info", desc: "No #tags in body or properties.", ask: "Suggest tags for each note, reusing the tags this vault already uses." },
    { key: "stale", label: "Stale notes", icon: "clock", tone: "info", desc: "Not modified in over a year.", ask: "Flag which are still relevant, which should be archived, and which need an update — with a one-line reason each." },
    { key: "large", label: "Very large notes", icon: "weight", tone: "info", desc: "Over 8,000 words or 256 KB.", ask: "Suggest how to split each into smaller, linked notes (proposed titles and which sections go where)." },
    {
        key: "unusedAttachments",
        label: "Unused attachments",
        icon: "paperclip",
        tone: "info",
        desc: "Images and files no note links to.",
        ask: "Check whether each attachment is referenced anywhere (including markdown links and embeds) and list which are safe to delete. Do not delete anything.",
    },
];

const GRADES = [
    [90, "A", "Excellent"],
    [80, "B", "Healthy"],
    [70, "C", "Needs care"],
    [60, "D", "Messy"],
    [0, "F", "Neglected"],
];

function itemLine(key, it) {
    if (key === "broken") return `- [[${it.target}]] (×${it.count}) linked from: ${it.sources.slice(0, 6).join(", ")}${it.sources.length > 6 ? ", …" : ""}`;
    if (key === "duplicates") return `- ${it.name}: ${it.paths.join(", ")}`;
    return `- ${it.path}${it.detail ? ` (${it.detail})` : ""}`;
}

function fixPrompt(cat) {
    const hy = S.hygiene;
    const issue = hy.issues[cat.key];
    const items = issue.items.slice(0, 40);
    return [
        `The OIL canvas health check of my Obsidian vault "${hy.vault?.name || "vault"}" found ${n(issue.count)} ${cat.label.toLowerCase()} — ${cat.desc.charAt(0).toLowerCase()}${cat.desc.slice(1)}`,
        "",
        ...items.map((it) => itemLine(cat.key, it)),
        issue.count > items.length ? `- …and ${n(issue.count - items.length)} more` : null,
        "",
        cat.ask,
        "",
        "Use the OIL tools (search_vault, get_note_metadata, get_related_entities, atomic_replace, atomic_append, create_note) to investigate. Propose the exact changes first and wait for my confirmation before writing anything.",
    ]
        .filter((x) => x != null)
        .join("\n");
}

function fixAllPrompt() {
    const hy = S.hygiene;
    const lines = [`The OIL canvas health check scored my Obsidian vault "${hy.vault?.name || "vault"}" ${hy.score}/100. Findings:`, ""];
    for (const cat of CATS) {
        const issue = hy.issues[cat.key];
        if (!issue?.count) continue;
        lines.push(`## ${cat.label} (${n(issue.count)}, −${hy.penalties[cat.key] ?? 0} pts)`);
        lines.push(...issue.items.slice(0, 6).map((it) => itemLine(cat.key, it)));
        lines.push("");
    }
    lines.push(
        "Prioritise the fixes that improve the score most for the least effort. Use the OIL tools (search_vault, get_note_metadata, atomic_replace, create_note) to investigate, then propose a plan and the exact changes. Wait for my confirmation before writing anything.",
    );
    return lines.join("\n");
}

export function hygieneView() {
    const out = [...vaultBanners()];
    if (!S.state?.vault) return out;
    const hy = S.hygiene;
    if (S.hygieneError) out.push(h("div", { class: "banner warn" }, icon("alert", 15), h("span", { class: "grow" }, S.hygieneError), h("button", { class: "btn sm", onclick: () => A.scanHygiene() }, "Retry")));
    if (!hy) {
        out.push(
            h(
                "div",
                { class: "hero scanning" },
                h("div", { class: "hero-orb pulse" }, icon("shield", 30)),
                h("div", null, h("h2", null, "Scanning your vault…"), h("p", { class: "muted" }, "Reading every note to check links, structure and metadata. Cloud-only files (OneDrive, iCloud) may be downloaded.")),
            ),
            skeletonCards(4),
        );
        return out;
    }
    const st = hy.stats;
    const [, grade, verdict] = GRADES.find(([min]) => hy.score >= min);
    const lost = Object.values(hy.penalties).reduce((a, b) => a + b, 0);
    const linkTotal = st.resolvedLinks + st.brokenLinks;
    const taskTotal = st.tasksOpen + st.tasksDone;

    out.push(
        h(
            "div",
            { class: `hero hygiene-hero grade-${grade}` },
            h("div", { class: "hy-gauge" }, gauge(hy.score, { label: "health", suffix: "", size: 150 })),
            h(
                "div",
                { class: "grow min0" },
                h("div", { class: "eyebrow" }, "Vault health"),
                h("h2", null, h("span", { class: "grade" }, grade), verdict),
                h("div", { class: "muted small" }, `${hy.vault?.name || ""} · scanned ${ago(hy.scannedAt)}${st.truncated ? " · partial scan (vault too large)" : ""}`),
                lost > 0 ? penaltyBar(hy) : h("div", { class: "good-text small", style: { marginTop: "10px" } }, icon("check", 13), " No penalties — spotless."),
            ),
            h(
                "div",
                { class: "col gap" },
                lost > 0 ? h("button", { class: "btn primary glow", onclick: () => A.askCopilot({ title: "Fix vault health", prompt: fixAllPrompt() }) }, icon("wand", 14), "Fix with Copilot") : null,
                h("button", { class: "btn", onclick: () => A.scanHygiene(), disabled: S.scanning }, icon("refresh", 14), S.scanning ? "Scanning…" : "Rescan"),
            ),
        ),
    );

    out.push(
        h(
            "div",
            { class: "kpis" },
            kpi(st.notes, "Notes", { ic: "file", tone: "t1" }),
            kpi(st.attachments, "Attachments", { ic: "image", tone: "t3" }),
            kpi(st.folders, "Folders", { ic: "folder", tone: "t2" }),
            kpi(compact(st.words), "Words", { ic: "edit", tone: "t6" }),
            kpi(st.tags, "Tags", { ic: "hash", tone: "t4" }),
            kpi(linkTotal ? `${Math.round((100 * st.resolvedLinks) / linkTotal)}%` : "–", "Links resolve", { ic: "link", tone: st.brokenLinks ? "warn" : "t5", sub: `${n(st.resolvedLinks)} of ${n(linkTotal)}` }),
        ),
    );

    out.push(
        h(
            "div",
            { class: "grid g-3" },
            card(
                "Link integrity",
                "link",
                donut(
                    [
                        { label: "Resolved", value: st.resolvedLinks, color: "var(--green)" },
                        { label: "Broken", value: st.brokenLinks, color: "var(--red)" },
                    ],
                    { center: compact(linkTotal), sub: "links" },
                ),
            ),
            card(
                "Connectivity",
                "graph",
                donut(
                    [
                        { label: "Linked both ways", value: Math.max(0, st.notes - hy.issues.orphans.count - hy.issues.noBacklinks.count), color: "var(--c1)" },
                        { label: "No backlinks", value: hy.issues.noBacklinks.count, color: "var(--c3)" },
                        { label: "Orphans", value: hy.issues.orphans.count, color: "var(--amber)" },
                    ],
                    { center: compact(st.notes), sub: "notes" },
                ),
            ),
            card(
                "Tasks",
                "task",
                taskTotal
                    ? h("div", { class: "gauges single" }, gauge((100 * st.tasksDone) / taskTotal, { label: "done", color: "var(--c2)" }), h("div", { class: "muted small center" }, `${n(st.tasksDone)} done · ${n(st.tasksOpen)} open`))
                    : h("div", { class: "muted small pad" }, "No tasks in this vault."),
            ),
        ),
    );

    out.push(h("h2", { class: "section" }, icon("shield", 14), "Findings"), h("div", { class: "hy-grid" }, CATS.map((cat) => hygieneCard(cat))));

    if (hy.topTags?.length) {
        out.push(
            card(
                "Top tags",
                "hash",
                rankList(
                    hy.topTags.slice(0, 12).map((x) => ({ label: h("button", { class: "link", onclick: () => A.openTag(x.tag) }, `#${x.tag}`), value: x.count, valueText: `${n(x.count)} notes` })),
                    { color: "var(--c5)" },
                ),
                { sub: "click to browse" },
            ),
        );
    }
    return out;
}

function penaltyBar(hy) {
    const segs = CATS.filter((c) => hy.penalties[c.key] > 0).map((c, i) => ({ cat: c, v: hy.penalties[c.key], color: PALETTE[(i + 3) % PALETTE.length] }));
    return h(
        "div",
        { class: "pen" },
        h(
            "div",
            { class: "pen-bar", title: "Points lost per category" },
            h("div", { class: "pen-ok", style: { width: `${hy.score}%` } }),
            segs.map((sg) => h("div", { class: "pen-seg", style: { width: `${sg.v}%`, background: sg.color }, title: `${sg.cat.label}: −${sg.v}` })),
        ),
        h(
            "div",
            { class: "legend" },
            segs.map((sg) => h("span", null, h("i", { style: { background: sg.color } }), `${sg.cat.label} −${sg.v}`)),
        ),
    );
}

function hygieneCard(cat) {
    const hy = S.hygiene;
    const issue = hy.issues[cat.key] || { count: 0, items: [] };
    const pts = hy.penalties[cat.key];
    const open = Boolean(S.showAll[`hy:${cat.key}`]);
    const all = Boolean(S.showAll[`hy:${cat.key}:all`]);
    const ok = !issue.count;
    const limit = all ? issue.items.length : 8;
    return h(
        "section",
        { class: `hy-card ${ok ? "ok" : cat.tone} ${open ? "open" : ""}` },
        h(
            "button",
            { class: "hy-head", disabled: ok, "aria-expanded": String(open), onclick: () => ((S.showAll[`hy:${cat.key}`] = !open), A.render()) },
            h("span", { class: "hy-ic" }, icon(ok ? "check" : cat.icon, 17)),
            h("span", { class: "grow min0" }, h("div", { class: "strong" }, cat.label), h("div", { class: "muted small" }, cat.desc)),
            h("span", { class: "hy-count" }, ok ? "✓" : compact(issue.count)),
            pts ? h("span", { class: "hy-pts", title: "Points deducted from the health score" }, `−${pts}`) : null,
            ok ? null : h("span", { class: "chev" }, icon("chevron", 14)),
        ),
        open && !ok
            ? h(
                  "div",
                  { class: "hy-body" },
                  cat.key === "broken" && issue.notes ? h("div", { class: "muted small" }, `${n(issue.notes)} notes contain broken links`) : null,
                  h(
                      "ul",
                      { class: "hy-items" },
                      issue.items.slice(0, limit).map((it) => h("li", null, hygieneItem(cat.key, it))),
                  ),
                  h(
                      "div",
                      { class: "row gap" },
                      issue.items.length > limit ? h("button", { class: "link", onclick: () => ((S.showAll[`hy:${cat.key}:all`] = true), A.render()) }, `Show ${issue.items.length - limit} more`) : null,
                      issue.count > issue.items.length ? h("span", { class: "muted small" }, `(first ${n(issue.items.length)} of ${n(issue.count)})`) : null,
                      h("span", { class: "grow" }),
                      h("button", { class: "btn sm primary", onclick: () => A.askCopilot({ title: `Fix ${cat.label.toLowerCase()}`, prompt: fixPrompt(cat) }) }, icon("wand", 13), "Fix with Copilot"),
                  ),
              )
            : null,
    );
}

function hygieneItem(key, it) {
    if (key === "broken") {
        return h(
            "div",
            { class: "hy-item" },
            h("button", { class: "link strong", title: "Create this note", onclick: () => A.createNote(it.target) }, icon("unlink", 12), ` ${it.target}`),
            h("span", { class: "muted small" }, ` ×${it.count} from `),
            it.sources.slice(0, 4).map((p, i) => [i ? ", " : "", h("button", { class: "link small", title: p, onclick: () => A.openNote(p) }, noteName(p))]),
            it.sources.length > 4 ? h("span", { class: "muted small" }, ` +${it.sources.length - 4}`) : null,
        );
    }
    if (key === "duplicates") {
        return h(
            "div",
            { class: "hy-item" },
            h("span", { class: "strong" }, it.name),
            h(
                "div",
                { class: "chips" },
                it.paths.map((p) => h("button", { class: "chip", title: p, onclick: () => A.openNote(p) }, noteFolder(p) || "(root)")),
            ),
        );
    }
    return h(
        "button",
        { class: "hy-item row-btn", title: it.path, onclick: () => A.openNote(it.path) },
        icon(key === "unusedAttachments" ? "image" : "file", 13),
        h("span", { class: "grow min0 ellipsis" }, noteName(it.path), noteFolder(it.path) ? h("span", { class: "muted small" }, `  ${noteFolder(it.path)}`) : null),
        it.detail ? h("span", { class: "badge" }, it.detail) : null,
    );
}
