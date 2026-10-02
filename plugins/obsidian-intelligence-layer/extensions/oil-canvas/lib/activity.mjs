import { normalizeNotePath } from "./paths.mjs";

/** OIL tool → how its primary `path` argument is touched. */
const ARG_PATH_KIND = {
    atomic_append: "modified",
    atomic_replace: "modified",
    atomic_replace_section: "modified",
    create_note: "created",
    read_note_section: "read",
    get_note_metadata: "read",
    get_related_entities: "read",
};

export const WRITE_TOOLS = new Set(["atomic_append", "atomic_replace", "atomic_replace_section", "create_note"]);

export const OIL_TOOLS = new Set([
    ...Object.keys(ARG_PATH_KIND),
    "search_vault",
    "semantic_search",
    "query_frontmatter",
    "get_customer_context",
    "prepare_crm_prefetch",
    "check_vault_health",
    "get_agent_log",
    "get_health",
]);

/** OIL tools that look things up — the calls an agent makes while hunting for an answer. */
export const SEARCH_TOOLS = new Set(["search_vault", "semantic_search", "query_frontmatter", "get_customer_context", "get_related_entities"]);

const MAX_SURFACED_PER_CALL = 40;
const MAX_QUERY_CHARS = 300;

/** The lookup a search call made, as one readable string. */
export function searchQueryOf(tool, args) {
    if (!args || typeof args !== "object") return null;
    let q = null;
    if (tool === "search_vault" || tool === "semantic_search") q = args.query;
    else if (tool === "get_customer_context") q = args.customer;
    else if (tool === "get_related_entities") q = args.path;
    else if (tool === "query_frontmatter") {
        if (args.where && typeof args.where === "object" && Object.keys(args.where).length) q = JSON.stringify(args.where);
        else if (args.key && args.value_fragment != null) q = `${args.key} ~ ${args.value_fragment}`;
        else if (args.key) q = String(args.key);
        else q = "(list keys)";
    }
    if (q == null) return null;
    q = String(q).replace(/\s+/g, " ").trim();
    return q ? q.slice(0, MAX_QUERY_CHARS) : null;
}

/**
 * How a search call went: the strategy that answered it (`mode`) and how many results came back.
 * A lookup that found nothing — including OIL's NOT_FOUND for an unknown customer or key — is a
 * zero-hit search rather than a missing measurement; other failures leave `hits` unknown.
 */
export function searchMeta(tool, payload, args, errorCode) {
    if (!SEARCH_TOOLS.has(tool)) return null;
    const query = searchQueryOf(tool, args);
    const meta = { query, mode: null, hits: null, topScore: null };
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

    if (tool === "search_vault") meta.mode = "keyword";
    else if (tool === "semantic_search") meta.mode = "semantic";
    else if (tool === "get_customer_context") meta.mode = "customer";
    else if (tool === "get_related_entities") meta.mode = "graph";
    else if (tool === "query_frontmatter") meta.mode = args?.where && Object.keys(args.where).length ? "query" : args?.key ? (args.value_fragment != null ? "match" : "facet") : "schema";

    if (errorCode) {
        if (errorCode === "NOT_FOUND" && (tool === "get_customer_context" || tool === "query_frontmatter")) meta.hits = 0;
        return meta;
    }
    if (payload == null) return meta;

    let results = null;
    if (Array.isArray(payload)) {
        // Older OIL builds returned search_vault hits as a bare array.
        results = payload;
        meta.hits = payload.length;
    } else if (typeof payload === "object") {
        if (Array.isArray(payload.results)) results = payload.results;
        if (tool === "search_vault") {
            const tiers = Array.isArray(payload.tiers_used) ? payload.tiers_used.filter((t) => typeof t === "string") : null;
            if (tiers) meta.mode = tiers.length ? tiers.join("+") : "none";
            meta.hits = num(payload.count) ?? results?.length ?? null;
        } else if (tool === "semantic_search") {
            meta.hits = num(payload.count) ?? results?.length ?? null;
        } else if (tool === "get_customer_context") {
            meta.hits = payload.customer_path ? 1 : 0;
        } else if (tool === "get_related_entities") {
            meta.hits = num(payload.count) ?? (Array.isArray(payload.related) ? payload.related.length : null);
        } else if (tool === "query_frontmatter") {
            if (typeof payload.mode === "string") meta.mode = payload.mode;
            meta.hits =
                meta.mode === "schema"
                    ? num(payload.key_count) ?? (Array.isArray(payload.keys) ? payload.keys.length : null)
                    : meta.mode === "facet"
                      ? num(payload.distinct_values) ?? (Array.isArray(payload.values) ? payload.values.length : null)
                      : num(payload.total_matched) ?? num(payload.count) ?? (Array.isArray(payload.paths) ? payload.paths.length : results?.length ?? null);
        }
    }
    if (results) {
        for (const r of results) {
            const s = num(r?.score);
            if (s != null && (meta.topScore == null || s > meta.topScore)) meta.topScore = s;
        }
    }
    return meta;
}

/**
 * Decide whether a tool event belongs to OIL, returning the bare OIL tool name.
 * The MCP server key is user-configurable, so match on the original tool name
 * and require it to come from an MCP server.
 */
export function oilToolName(data) {
    if (!data) return null;
    if (data.mcpToolName && OIL_TOOLS.has(data.mcpToolName) && (data.mcpServerName || data.mcpConfigServerName)) {
        return data.mcpToolName;
    }
    return oilToolNameFromQualified(data.toolName);
}

/** For hook inputs that only carry the qualified name (e.g. `oil-atomic_append`). */
export function oilToolNameFromQualified(toolName) {
    if (typeof toolName !== "string") return null;
    const m = /^(.+?)-([a-z_]+)$/.exec(toolName);
    if (!m || !OIL_TOOLS.has(m[2])) return null;
    return /oil|obsidian/i.test(m[1]) ? m[2] : null;
}

/** Remembers recent user prompts so a prompt is stored only once an OIL call answers it. */
export class PromptBuffer {
    constructor(max = 50) {
        this.max = max;
        this.map = new Map();
    }
    add(data, ts) {
        if (!data?.interactionId) return;
        this.map.set(data.interactionId, { ts, prompt: typeof data.content === "string" ? data.content : null });
        if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    }
    flushTo(store, sessionId, interactionId) {
        if (!interactionId) return;
        const p = this.map.get(interactionId);
        store.recordInteraction({ interactionId, sessionId, ts: p?.ts ?? null, prompt: p?.prompt ?? null });
    }
}

export function touchesFromArgs(tool, args) {
    const kind = ARG_PATH_KIND[tool];
    const path = normalizeNotePath(args?.path);
    return kind && path ? [{ path, kind }] : [];
}

/** Parse an OIL result payload (JSON text) into touched notes plus any error code. */
export function analyzeResult(tool, resultText, args) {
    let payload = null;
    if (typeof resultText === "string") {
        try {
            payload = JSON.parse(resultText);
        } catch {
            payload = null;
        }
    }
    const errorCode = payload && typeof payload === "object" && payload.error_code ? String(payload.error_code) : null;
    const touches = [];
    const search = searchMeta(tool, payload, args, errorCode);
    if (!payload || errorCode) return { touches, errorCode, errorMessage: errorCode ? String(payload.error ?? "") : null, search };

    if (tool === "get_customer_context") {
        const p = normalizeNotePath(payload.customer_path);
        if (p) touches.push({ path: p, kind: "read" });
    }
    if (tool === "get_agent_log" && typeof payload.path === "string") {
        const p = normalizeNotePath(payload.path);
        if (p) touches.push({ path: p, kind: "read" });
    }

    if (!WRITE_TOOLS.has(tool)) {
        const seen = new Set(touches.map((t) => t.path));
        for (const t of touchesFromArgs(tool, args)) seen.add(t.path);
        for (const p of collectNotePaths(payload)) {
            if (seen.has(p)) continue;
            seen.add(p);
            touches.push({ path: p, kind: "surfaced" });
            if (touches.length >= MAX_SURFACED_PER_CALL) break;
        }
    }
    return { touches, errorCode: null, errorMessage: null, search };
}

/** Walk a JSON payload collecting strings under `*path`/`*paths` keys that look like markdown notes. */
function collectNotePaths(value, out = [], depth = 0) {
    if (depth > 8 || out.length > 500 || value == null) return out;
    if (Array.isArray(value)) {
        for (const v of value) collectNotePaths(v, out, depth + 1);
        return out;
    }
    if (typeof value !== "object") return out;
    for (const [key, v] of Object.entries(value)) {
        if (/paths?$/i.test(key)) {
            for (const s of Array.isArray(v) ? v : [v]) {
                if (typeof s === "string" && /\.md$/i.test(s)) {
                    const p = normalizeNotePath(s);
                    if (p) out.push(p);
                }
            }
        }
        if (v && typeof v === "object") collectNotePaths(v, out, depth + 1);
    }
    return out;
}

/** Result text from a tool.execution_complete event (MCP results arrive as `{ content: string }`). */
export function resultTextOf(data) {
    const r = data?.result;
    if (typeof r === "string") return r;
    if (typeof r?.content === "string") return r.content;
    if (Array.isArray(r?.content)) return r.content.map((c) => c?.text ?? "").join("");
    if (typeof r?.textResultForLlm === "string") return r.textResultForLlm;
    return null;
}

/** Keep stored args small: long strings (note bodies) are truncated. */
export function compactArgs(args) {
    if (!args || typeof args !== "object") return args ?? null;
    const out = {};
    for (const [k, v] of Object.entries(args)) {
        out[k] = typeof v === "string" && v.length > 2000 ? `${v.slice(0, 2000)}… (${v.length} chars)` : v;
    }
    return out;
}
