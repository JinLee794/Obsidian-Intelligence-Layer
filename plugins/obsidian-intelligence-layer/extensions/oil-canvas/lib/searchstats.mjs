import { SEARCH_TOOLS, WRITE_TOOLS } from "./activity.mjs";

// Calls without a recorded user prompt (older logs) are grouped by idle time instead.
const FALLBACK_GAP_MS = 5 * 60_000;
const CHAIN_BUCKETS = [
    { label: "1", lo: 1, hi: 1 },
    { label: "2", lo: 2, hi: 2 },
    { label: "3", lo: 3, hi: 3 },
    { label: "4", lo: 4, hi: 4 },
    { label: "5", lo: 5, hi: 5 },
    { label: "6–8", lo: 6, hi: 8 },
    { label: "9–12", lo: 9, hi: 12 },
    { label: "13+", lo: 13, hi: Infinity },
];
const NEXT_STEPS = ["retry", "switch", "read", "write", "other", "end"];
const MAX_CHAIN_STEPS = 40;

const quant = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
const round = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const tokens = (q) => new Set(String(q || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1));

/** Two queries that share words but aren't identical — the agent rephrasing the same question. */
function isRephrase(a, b) {
    if (!a || !b || a.toLowerCase() === b.toLowerCase()) return false;
    const ta = tokens(a);
    const tb = tokens(b);
    for (const t of ta) if (tb.has(t)) return true;
    return false;
}

/**
 * Turn raw OIL calls into search-effort analytics.
 *
 * An "answer" is one user prompt (a Copilot interaction). Within it, each search call is
 * judged *opened* when the agent went on to read or write a note that search surfaced, which
 * is the observable sign its results were what the agent was looking for.
 *
 * @param {{calls: object[], touches: {tool_call_id: string, path: string, kind: string}[], interactions: object[]}} input
 *   `calls` must be ordered by session then start time.
 */
export function computeSearchAnalytics({ calls, touches, interactions }) {
    const touchesByCall = new Map();
    for (const t of touches) {
        if (!touchesByCall.has(t.tool_call_id)) touchesByCall.set(t.tool_call_id, []);
        touchesByCall.get(t.tool_call_id).push(t);
    }
    const promptOf = new Map(interactions.map((i) => [i.interaction_id, i]));

    // ── Group calls into answers ──────────────────────────────────────
    const groups = [];
    const byKey = new Map();
    const lastFallback = new Map();
    for (const c of calls) {
        let key;
        if (c.interaction_id) key = `i:${c.interaction_id}`;
        else {
            const t = Date.parse(c.started_at);
            const prev = lastFallback.get(c.session_id);
            if (!prev || !Number.isFinite(t) || t - prev.t > FALLBACK_GAP_MS) lastFallback.set(c.session_id, { t, key: `g:${c.session_id}:${c.started_at}` });
            else prev.t = t;
            key = lastFallback.get(c.session_id).key;
        }
        let g = byKey.get(key);
        if (!g) {
            g = { key, interactionId: c.interaction_id || null, sessionId: c.session_id, sessionName: c.session_name || null, calls: [] };
            byKey.set(key, g);
            groups.push(g);
        }
        g.calls.push(c);
    }

    // ── Per-call judgement ────────────────────────────────────────────
    const modes = new Map();
    const tools = new Map();
    const positions = [];
    const firstTool = new Map();
    const winningTool = new Map();
    const zeroQueries = new Map();
    const chainLens = [];
    const byDay = new Map();
    const answers = [];
    let searchedAnswers = 0;
    let opened = 0;
    let oneShot = 0;
    let firstOpened = 0;
    let rephrased = 0;
    let totalSearches = 0;
    let measured = 0;
    let zero = 0;
    let wasted = 0;

    const bump = (map, key, init) => {
        if (!map.has(key)) map.set(key, init());
        return map.get(key);
    };
    const statInit = (extra) => () => ({ ...extra, calls: 0, measured: 0, zero: 0, hitsSum: 0, opened: 0, errors: 0, scoreSum: 0, scoreN: 0, durations: [], next: Object.fromEntries(NEXT_STEPS.map((k) => [k, 0])) });

    for (const g of groups) {
        const searchIdx = [];
        g.calls.forEach((c, i) => SEARCH_TOOLS.has(c.tool) && searchIdx.push(i));
        if (!searchIdx.length) continue;
        searchedAnswers++;

        // Notes the agent read or wrote, with the position of the call that did it.
        const usedAt = [];
        g.calls.forEach((c, i) => {
            for (const t of touchesByCall.get(c.tool_call_id) || []) if (t.kind !== "surfaced") usedAt.push({ i, path: t.path, self: SEARCH_TOOLS.has(c.tool) });
        });

        let firstUseful = -1;
        let groupRephrased = false;
        let prevSearch = null;
        const steps = [];
        searchIdx.forEach((ci, pos) => {
            const c = g.calls[ci];
            const failed = c.success === 0 || c.error != null;
            const found = new Set((touchesByCall.get(c.tool_call_id) || []).map((t) => t.path));
            // get_customer_context reads the note it found; that read is itself the answer.
            const selfRead = c.tool === "get_customer_context" && c.hits > 0;
            const useful = !failed && (selfRead || usedAt.some((u) => u.i > ci && found.has(u.path)));
            if (useful && firstUseful < 0) firstUseful = pos;
            if (prevSearch && isRephrase(prevSearch.search_query, c.search_query)) groupRephrased = true;
            prevSearch = c;

            const nextCall = g.calls[ci + 1];
            const next = !nextCall
                ? "end"
                : SEARCH_TOOLS.has(nextCall.tool)
                  ? nextCall.tool === c.tool
                      ? "retry"
                      : "switch"
                  : WRITE_TOOLS.has(nextCall.tool)
                    ? "write"
                    : (touchesByCall.get(nextCall.tool_call_id) || []).some((t) => t.kind === "read")
                      ? "read"
                      : "other";

            const mode = c.search_mode || "unknown";
            for (const st of [bump(modes, `${c.tool}|${mode}`, statInit({ tool: c.tool, mode })), bump(tools, c.tool, statInit({ tool: c.tool }))]) {
                st.calls++;
                if (failed) st.errors++;
                if (c.hits != null) {
                    st.measured++;
                    st.hitsSum += c.hits;
                    if (c.hits === 0) st.zero++;
                }
                if (useful) st.opened++;
                if (c.top_score != null) {
                    st.scoreSum += c.top_score;
                    st.scoreN++;
                }
                if (c.duration_ms != null && c.timing !== "masked") st.durations.push(c.duration_ms);
                st.next[next]++;
            }

            const p = positions[Math.min(pos, 5)] || (positions[Math.min(pos, 5)] = { calls: 0, opened: 0, zero: 0, measured: 0 });
            p.calls++;
            if (useful) p.opened++;
            if (c.hits != null) {
                p.measured++;
                if (c.hits === 0) p.zero++;
            }

            totalSearches++;
            if (c.hits != null) {
                measured++;
                if (c.hits === 0) {
                    zero++;
                    if (c.search_query) {
                        const k = `${c.tool}|${c.search_query.toLowerCase()}`;
                        const z = bump(zeroQueries, k, () => ({ tool: c.tool, query: c.search_query, count: 0, last_ts: null, sessions: new Set() }));
                        z.count++;
                        z.sessions.add(c.session_id);
                        if (!z.last_ts || c.started_at > z.last_ts) z.last_ts = c.started_at;
                    }
                }
            }
            if (steps.length < MAX_CHAIN_STEPS) {
                steps.push({ tool: c.tool, mode: c.search_mode, query: c.search_query, hits: c.hits, ms: c.timing === "masked" ? null : c.duration_ms, useful, failed, next });
            }
        });

        const n = searchIdx.length;
        chainLens.push(n);
        if (n === 1) oneShot++;
        if (firstUseful === 0) firstOpened++;
        if (firstUseful >= 0) {
            opened++;
            wasted += firstUseful;
            const wt = g.calls[searchIdx[firstUseful]].tool;
            winningTool.set(wt, (winningTool.get(wt) || 0) + 1);
        }
        if (groupRephrased) rephrased++;
        const ft = g.calls[searchIdx[0]].tool;
        firstTool.set(ft, (firstTool.get(ft) || 0) + 1);

        const startedAt = g.calls[0].started_at;
        const day = typeof startedAt === "string" ? startedAt.slice(0, 10) : null;
        if (day) {
            const d = bump(byDay, day, () => ({ day, answers: 0, searches: 0, zero: 0, measured: 0, opened: 0 }));
            d.answers++;
            d.searches += n;
            if (firstUseful >= 0) d.opened++;
            for (const s of steps) {
                if (s.hits != null) {
                    d.measured++;
                    if (s.hits === 0) d.zero++;
                }
            }
        }

        const info = g.interactionId ? promptOf.get(g.interactionId) : null;
        answers.push({
            key: g.key,
            sessionId: g.sessionId,
            sessionName: g.sessionName,
            interactionId: g.interactionId,
            ts: info?.ts || startedAt,
            prompt: info?.prompt || null,
            searches: n,
            opened: firstUseful >= 0,
            searchesToOpen: firstUseful >= 0 ? firstUseful + 1 : null,
            rephrased: groupRephrased,
            totalMs: steps.reduce((a, s) => a + (s.ms || 0), 0),
            steps,
        });
    }

    const finish = (st) => {
        st.durations.sort((a, b) => a - b);
        const { durations, hitsSum, scoreSum, scoreN, ...rest } = st;
        return {
            ...rest,
            avgHits: st.measured ? round(hitsSum / st.measured) : null,
            zeroRate: st.measured ? round((100 * st.zero) / st.measured) : null,
            openRate: st.calls ? round((100 * st.opened) / st.calls) : null,
            avgTopScore: scoreN ? round(scoreSum / scoreN, 3) : null,
            p50: quant(durations, 0.5),
            p95: quant(durations, 0.95),
        };
    };

    const sortedLens = [...chainLens].sort((a, b) => a - b);
    const sum = sortedLens.reduce((a, b) => a + b, 0);
    const pct = (a, b) => (b ? round((100 * a) / b) : null);
    const toList = (m) => [...m].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count);

    return {
        totals: {
            answers: groups.length,
            searchedAnswers,
            searches: totalSearches,
            avgPerAnswer: searchedAnswers ? round(sum / searchedAnswers, 2) : null,
            medianPerAnswer: quant(sortedLens, 0.5),
            p90PerAnswer: quant(sortedLens, 0.9),
            maxPerAnswer: sortedLens.length ? sortedLens[sortedLens.length - 1] : null,
            oneShotRate: pct(oneShot, searchedAnswers),
            firstOpenRate: pct(firstOpened, searchedAnswers),
            openedRate: pct(opened, searchedAnswers),
            avgToOpen: opened ? round((wasted + opened) / opened, 2) : null,
            wastedSearches: wasted,
            zeroRate: pct(zero, measured),
            rephraseRate: pct(rephrased, searchedAnswers),
            unattributed: groups.filter((g) => !g.interactionId).length,
        },
        chainLengths: CHAIN_BUCKETS.map((b) => ({ label: b.label, count: chainLens.filter((v) => v >= b.lo && v <= b.hi).length })),
        byMode: [...modes.values()].map(finish).sort((a, b) => b.calls - a.calls),
        byTool: [...tools.values()].map(finish).sort((a, b) => b.calls - a.calls),
        byPosition: positions.map((p, i) => ({
            position: i < 5 ? String(i + 1) : "6+",
            calls: p?.calls || 0,
            openRate: p?.calls ? round((100 * p.opened) / p.calls) : null,
            zeroRate: p?.measured ? round((100 * p.zero) / p.measured) : null,
        })),
        firstTool: toList(firstTool),
        winningTool: toList(winningTool),
        byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, perAnswer: round(d.searches / d.answers, 2), zeroRate: d.measured ? round((100 * d.zero) / d.measured) : null })),
        longest: [...answers].sort((a, b) => b.searches - a.searches || (b.ts || "").localeCompare(a.ts || "")).slice(0, 15),
        recent: [...answers].sort((a, b) => (b.ts || "").localeCompare(a.ts || "")).slice(0, 15),
        zeroHitQueries: [...zeroQueries.values()]
            .map(({ sessions, ...z }) => ({ ...z, sessions: sessions.size }))
            .sort((a, b) => b.count - a.count || (b.last_ts || "").localeCompare(a.last_ts || ""))
            .slice(0, 20),
    };
}
