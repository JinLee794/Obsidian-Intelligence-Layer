// OIL Vault Activity canvas.
//
// Captures OIL MCP tool calls in this session as they happen, snapshots notes
// before/after OIL writes, and serves a canvas that previews touched notes with
// the vault's own theme plus analytics from a local SQLite database.

import { readFileSync, statSync } from "node:fs";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { OIL_TOOLS, PromptBuffer, WRITE_TOOLS, batchTimings, oilToolName, oilToolNameFromQualified } from "./lib/activity.mjs";
import { normalizeNotePath, resolveInVault } from "./lib/paths.mjs";

// Every Copilot session runs its own copy of this extension, so keep the idle
// footprint small: the HTTP server, markdown/diff/graph code, SQLite and the
// session-log importer load only when a panel opens or OIL is actually called.
const lazy = (load) => {
    let p = null;
    return () => (p ??= load().catch((err) => ((p = null), Promise.reject(err))));
};
const loadHistory = lazy(() => import("./lib/history.mjs"));
const loadVaults = lazy(() => import("./lib/vaults.mjs"));

const MAX_SNAPSHOT_BYTES = 512 * 1024;
const VIEWS = ["activity", "explorer", "analytics", "hygiene", "vault"];
const MODES = ["preview", "edit", "changes"];

const getStore = lazy(() =>
    import("./lib/store.mjs")
        .then((m) => m.openStore())
        .then((s) => ((storeOpen = true), s)),
);
let storeOpen = false;

let session = null;
const log = (message, opts) => {
    try {
        session?.log(message, opts);
    } catch {}
};

let server = null;
let serverPromise = null;
const openPanels = new Set();

async function getServer(sessionId, { listen = false } = {}) {
    serverPromise ??= (async () => {
        const { CanvasServer } = await import("./lib/server.mjs");
        server = new CanvasServer({
            getStore,
            sessionId,
            cwd: process.cwd(),
            log,
            // "Fix with Copilot" / "Ask Copilot" in the canvas post a normal user message to this session.
            onAsk: async (prompt) => {
                if (!session) throw new Error("Session is not connected");
                return session.send({ prompt });
            },
        });
        return server;
    })().catch((err) => {
        serverPromise = null;
        throw err;
    });
    const s = await serverPromise;
    if (listen && !s.running) await s.start();
    return s;
}

// ── Before/after snapshots of OIL writes ────────────────────────────────

const pendingById = new Map();
const pendingByPath = new Map();

/** Vaults OIL might be writing to: its configured vault(s) first, then the canvas's selected vault. */
async function candidateVaults() {
    const { detectOilVaults, loadSettings } = await loadVaults();
    const oil = detectOilVaults(process.cwd()).filter((v) => v.exists);
    // A vault from an MCP config is what the server actually receives; the bare env var may be stale.
    oil.sort((a, b) => Number(a.sources.includes("OBSIDIAN_VAULT_PATH") && a.sources.length === 1) - Number(b.sources.includes("OBSIDIAN_VAULT_PATH") && b.sources.length === 1));
    const out = oil.map((v) => v.path);
    const selected = loadSettings().vaultPath;
    if (selected && !out.includes(selected)) out.push(selected);
    return out;
}

function readText(abs) {
    try {
        const st = statSync(abs);
        if (!st.isFile()) return { exists: false, text: null };
        if (st.size > MAX_SNAPSHOT_BYTES) return { exists: true, text: null, tooLarge: true };
        return { exists: true, text: readFileSync(abs, "utf8") };
    } catch {
        return { exists: false, text: null };
    }
}

async function captureBefore(tool, args, toolCallId) {
    if (!WRITE_TOOLS.has(tool)) return;
    const rel = normalizeNotePath(args?.path);
    if (!rel) return;
    const vaults = await candidateVaults();
    let chosen = null;
    for (const v of vaults) {
        const abs = resolveInVault(v, rel);
        if (abs && readText(abs).exists) {
            chosen = { vault: v, abs };
            break;
        }
    }
    if (!chosen && vaults.length) chosen = { vault: vaults[0], abs: resolveInVault(vaults[0], rel), all: vaults };
    if (!chosen?.abs) return;
    const entry = { rel, ...chosen, before: readText(chosen.abs), at: Date.now() };
    if (toolCallId) pendingById.set(toolCallId, entry);
    else pendingByPath.set(rel, entry);
}

function takePending(toolCallId, rel) {
    let entry = pendingById.get(toolCallId);
    if (entry) pendingById.delete(toolCallId);
    if (rel && pendingByPath.has(rel)) {
        entry ??= pendingByPath.get(rel);
        pendingByPath.delete(rel);
    }
    return entry;
}

async function captureAfter(call, ts) {
    const args = call.args_json ? JSON.parse(call.args_json) : null;
    const rel = normalizeNotePath(args?.path);
    const entry = takePending(call.tool_call_id, rel);
    if (!entry || !call.success) return false;
    let abs = entry.abs;
    let after = readText(abs);
    // create_note: the file may have landed in a different candidate vault than guessed.
    if (!after.exists && entry.all) {
        for (const v of entry.all) {
            const p = resolveInVault(v, rel);
            const r = p ? readText(p) : null;
            if (r?.exists) {
                abs = p;
                after = r;
                break;
            }
        }
    }
    if (entry.before.tooLarge || after.tooLarge) return false;
    const store = await getStore();
    store.saveSnapshot({ toolCallId: call.tool_call_id, path: rel, beforeText: entry.before.text, afterText: after.text, beforeExists: entry.before.exists, ts });
    return true;
}

// Drop stale pending entries (e.g. a write that never completed).
setInterval(() => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const m of [pendingById, pendingByPath, callTiming]) for (const [k, v] of m) if (v.at < cutoff) m.delete(k);
}, 60_000).unref();

// ── Live capture from session events ────────────────────────────────────

let sessionRecorded = false;
const prompts = new PromptBuffer();
// Tool calls identified as OIL at start; other tools never touch SQLite.
const oilCalls = new Set();
// toolCallId → { at, mcpStartedAt?, timing?, batchSize? }: what the completion event can't tell us.
const callTiming = new Map();

function noteTiming(toolCallId, fields) {
    callTiming.set(toolCallId, { ...callTiming.get(toolCallId), ...fields, at: Date.now() });
}

function onAssistantMessage(event) {
    for (const [id, t] of batchTimings(event.data?.toolRequests)) noteTiming(id, t);
}

async function onToolStart(event) {
    if (!event.data?.toolCallId || !oilToolName(event.data)) return;
    oilCalls.add(event.data.toolCallId);
    const [store, { ingestStart }] = await Promise.all([getStore(), loadHistory()]);
    const tool = ingestStart(store, session.sessionId, event.data, event.timestamp || new Date().toISOString(), "live");
    if (!tool) return;
    if (!sessionRecorded) {
        sessionRecorded = true;
        store.upsertSession({ sessionId: session.sessionId, cwd: process.cwd(), ts: event.timestamp || new Date().toISOString() });
    }
    server?.broadcast("call", { phase: "start", toolCallId: event.data.toolCallId, tool, paths: store.touchesOf(event.data.toolCallId).map((t) => t.path) });
}

async function onToolComplete(event) {
    // Calls started before this provider (re)loaded are only looked up if SQLite is open anyway.
    if (!oilCalls.delete(event.data?.toolCallId) && !storeOpen) return;
    const [store, { ingestComplete }] = await Promise.all([getStore(), loadHistory()]);
    const ts = event.timestamp || new Date().toISOString();
    const { at, ...timing } = callTiming.get(event.data.toolCallId) ?? {};
    callTiming.delete(event.data.toolCallId);
    const call = ingestComplete(store, event.data, ts, timing);
    if (!call) return;
    prompts.flushTo(store, session.sessionId, event.data.interactionId);
    const full = store.getCall(event.data.toolCallId);
    let snapshot = false;
    if (WRITE_TOOLS.has(full.tool)) snapshot = await captureAfter(full, ts);
    server?.broadcast("call", {
        phase: "complete",
        toolCallId: full.tool_call_id,
        tool: full.tool,
        success: Boolean(full.success),
        snapshot,
        paths: store.touchesOf(full.tool_call_id).map((t) => t.path),
    });
}

const guard = (fn) => (e) => fn(e).catch((err) => log(`oil-canvas: ${err.message}`, { level: "error" }));

// ── Canvas ──────────────────────────────────────────────────────────────

function asObject(input) {
    if (input == null) return {};
    if (typeof input !== "object" || Array.isArray(input)) throw new CanvasError("invalid_input", "Input must be an object");
    return input;
}

function requireNotePath(p) {
    const rel = normalizeNotePath(p);
    if (!rel) throw new CanvasError("invalid_input", "path must be a vault-relative note path");
    return rel;
}

function scopeId(scope, sessionId) {
    if (scope != null && scope !== "session" && scope !== "all") throw new CanvasError("invalid_input", 'scope must be "session" or "all"');
    return scope === "all" ? null : sessionId;
}

const canvas = createCanvas({
    id: "oil-canvas",
    displayName: "OIL Vault Activity",
    description:
        "Live view of the Obsidian notes OIL (Obsidian Intelligence Layer) reads, writes and surfaces in this session — Obsidian-style note browser with backlinks, local graph and editing, before/after diffs of OIL writes, vault hygiene scan, and SQLite-backed analytics across sessions.",
    inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
            view: { type: "string", enum: VIEWS, description: "Tab to show (default: activity, or vault when none is selected)." },
            notePath: { type: "string", description: "Vault-relative note path to open." },
            mode: { type: "string", enum: MODES, description: "Note view mode when notePath is given." },
        },
    },
    actions: [
        {
            name: "focus_note",
            description: "Show a note in open canvas panels: themed preview, editor, or the diffs of OIL's writes to it.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["path"],
                properties: { path: { type: "string" }, mode: { type: "string", enum: MODES } },
            },
            handler: async (ctx) => {
                const input = asObject(ctx.input);
                const path = requireNotePath(input.path);
                if (input.mode != null && !MODES.includes(input.mode)) throw new CanvasError("invalid_input", `mode must be one of ${MODES.join(", ")}`);
                const s = await getServer(ctx.sessionId);
                s.broadcast("navigate", { notePath: path, mode: input.mode || "preview" });
                const note = s.readNote(path);
                return { ok: true, path, existsInSelectedVault: note.exists };
            },
        },
        {
            name: "show_view",
            description: "Switch open canvas panels to the activity, explorer (vault file tree), analytics, hygiene, or vault tab.",
            inputSchema: { type: "object", additionalProperties: false, required: ["view"], properties: { view: { type: "string", enum: VIEWS } } },
            handler: async (ctx) => {
                const { view } = asObject(ctx.input);
                if (!VIEWS.includes(view)) throw new CanvasError("invalid_input", `view must be one of ${VIEWS.join(", ")}`);
                (await getServer(ctx.sessionId)).broadcast("navigate", { view });
                return { ok: true, view };
            },
        },
        {
            name: "select_vault",
            description: "Set the Obsidian vault folder the canvas previews notes from (absolute path).",
            inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" } } },
            handler: async (ctx) => {
                const { path } = asObject(ctx.input);
                if (typeof path !== "string" || !path.trim()) throw new CanvasError("invalid_input", "path is required");
                try {
                    const state = (await getServer(ctx.sessionId)).selectVault(path);
                    return { ok: true, vault: state.vault, oilMismatch: state.oilMismatch };
                } catch (err) {
                    throw new CanvasError("invalid_input", err.message);
                }
            },
        },
        {
            name: "get_activity_summary",
            description: "Notes OIL changed, read and surfaced, plus call totals, for this session or all sessions.",
            inputSchema: { type: "object", additionalProperties: false, properties: { scope: { type: "string", enum: ["session", "all"] } } },
            handler: async (ctx) => {
                const { scope } = asObject(ctx.input);
                const sid = scopeId(scope, ctx.sessionId);
                const a = (await getStore()).activity(sid, { limitCalls: 0 });
                const pick = (f) => a.notes.filter(f).slice(0, 50).map((x) => x.path);
                return {
                    scope: sid ? "session" : "all",
                    totals: a.totals,
                    changed: pick((x) => x.modified || x.created),
                    failedWrites: pick((x) => !x.modified && !x.created && x.failed_writes),
                    read: pick((x) => !x.modified && !x.created && !x.failed_writes && x.reads),
                    surfacedCount: a.notes.filter((x) => !x.modified && !x.created && !x.failed_writes && !x.reads && x.surfaced).length,
                };
            },
        },
        {
            name: "get_analytics",
            description: "Aggregate OIL usage: calls and latency by tool, calls per day, top notes and folders.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: { scope: { type: "string", enum: ["session", "all"] }, days: { type: "integer", minimum: 1, maximum: 3650 } },
            },
            handler: async (ctx) => {
                const { scope, days } = asObject(ctx.input);
                const sid = scopeId(scope, ctx.sessionId);
                if (days != null && (!Number.isInteger(days) || days < 1)) throw new CanvasError("invalid_input", "days must be a positive integer");
                const sinceIso = days ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
                const a = (await getStore()).analytics({ sessionId: sid, sinceIso });
                return { scope: sid ? "session" : "all", days: days ?? null, totals: a.totals, byTool: a.byTool, topNotes: a.topNotes.slice(0, 10), topFolders: a.topFolders.slice(0, 10) };
            },
        },
        {
            name: "get_search_analytics",
            description:
                "How many OIL searches the agent needed per answer (per user prompt), how often results were opened, zero-hit rates, latency by search tool and mode, the longest search chains and queries that found nothing.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: { scope: { type: "string", enum: ["session", "all"] }, days: { type: "integer", minimum: 1, maximum: 3650 } },
            },
            handler: async (ctx) => {
                const { scope, days } = asObject(ctx.input);
                const sid = scopeId(scope, ctx.sessionId);
                if (days != null && (!Number.isInteger(days) || days < 1)) throw new CanvasError("invalid_input", "days must be a positive integer");
                const sinceIso = days ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
                const a = (await getStore()).searchAnalytics({ sessionId: sid, sinceIso });
                const chain = (x) => ({ ts: x.ts, prompt: x.prompt, searches: x.searches, opened: x.opened, steps: x.steps.map((s) => `${s.tool}${s.mode ? `[${s.mode}]` : ""}: ${s.query ?? ""} → ${s.hits ?? "?"} hits${s.useful ? " (opened)" : ""}`) });
                return {
                    scope: sid ? "session" : "all",
                    days: days ?? null,
                    totals: a.totals,
                    chainLengths: a.chainLengths,
                    byMode: a.byMode.map(({ next, ...m }) => m),
                    byPosition: a.byPosition,
                    longest: a.longest.slice(0, 5).map(chain),
                    zeroHitQueries: a.zeroHitQueries.slice(0, 10),
                };
            },
        },
        {
            name: "scan_vault_hygiene",
            description:
                "Scan the selected vault for broken links, orphans, empty notes, duplicate names, missing frontmatter, stale notes and unused attachments; returns a 0-100 health score and the findings, and shows them in open panels.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: { limit: { type: "integer", minimum: 1, maximum: 500, description: "Max items per category (default 25)." } },
            },
            handler: async (ctx) => {
                const { limit } = asObject(ctx.input);
                const s = await getServer(ctx.sessionId);
                const g = s.vaultGraph();
                if (!g) throw new CanvasError("invalid_input", "No vault is selected in the canvas; use select_vault first");
                const h = g.hygiene({ limit: Number.isInteger(limit) ? limit : 25 });
                s.broadcast("navigate", { view: "hygiene" });
                return { vault: s.vaultPath(), ...h };
            },
        },
        {
            name: "import_history",
            description: "Sync analytics from past Copilot session logs now (incremental; runs automatically every few minutes while the canvas is visible). Set full to re-read every log from the start, wait to block until finished.",
            inputSchema: { type: "object", additionalProperties: false, properties: { wait: { type: "boolean" }, full: { type: "boolean" } } },
            handler: async (ctx) => {
                const { wait, full } = asObject(ctx.input);
                const job = (await getServer(ctx.sessionId)).startImport({ full: full === true });
                if (job.otherSession) return { started: false, running: false, error: job.error };
                if (!wait) return { started: job.started, running: true };
                return { finished: true, ...(await job.promise) };
            },
        },
    ],
    open: async (ctx) => {
        const input = asObject(ctx.input);
        if (input.view != null && !VIEWS.includes(input.view)) throw new CanvasError("invalid_input", `view must be one of ${VIEWS.join(", ")}`);
        const notePath = input.notePath != null ? requireNotePath(input.notePath) : null;
        const s = await getServer(ctx.sessionId, { listen: true });
        openPanels.add(ctx.instanceId);
        s.importIfStale().catch((err) => log(`oil-canvas: stale-history check failed: ${err.message}`, { level: "warning" }));
        // Re-opening an existing instance focuses it without reloading, so also navigate live panels.
        if (notePath) s.broadcast("navigate", { notePath, mode: input.mode || "preview" });
        else if (input.view) s.broadcast("navigate", { view: input.view });
        const vault = s.state().vault;
        return {
            title: "OIL Vault Activity",
            url: s.url({ view: input.view, notePath, mode: input.mode }),
            status: vault ? vault.name : "Choose a vault",
        };
    },
    // Last panel closed: stop the loopback server and drop the vault graph until a panel opens again.
    onClose: async (ctx) => {
        openPanels.delete(ctx.instanceId);
        if (openPanels.size || !server?.running) return;
        const s = server;
        if (s.importJob) s.importJob.promise.finally(() => openPanels.size || s.stop());
        else s.stop();
    },
});

session = await joinSession({
    canvases: [canvas],
    hooks: {
        onPreMcpToolCall: async (input) => {
            // OIL receives the call now — after permission prompts and other hooks — so time it from here.
            if (input?.toolCallId && OIL_TOOLS.has(input.toolName)) {
                const ms = Number.isFinite(input.timestamp) ? input.timestamp : Date.now();
                noteTiming(input.toolCallId, { mcpStartedAt: new Date(ms).toISOString() });
            }
            try {
                if (WRITE_TOOLS.has(input.toolName)) await captureBefore(input.toolName, input.arguments, input.toolCallId);
            } catch (err) {
                log(`oil-canvas: snapshot failed: ${err.message}`, { level: "warning" });
            }
        },
        onPreToolUse: async (input) => {
            try {
                const tool = oilToolNameFromQualified(input.toolName);
                if (!tool || !WRITE_TOOLS.has(tool)) return;
                const rel = normalizeNotePath(input.toolArgs?.path);
                // Fallback only: skip if the MCP hook already captured this path.
                if (rel && ![...pendingById.values()].some((e) => e.rel === rel && Date.now() - e.at < 5000)) await captureBefore(tool, input.toolArgs, null);
            } catch (err) {
                log(`oil-canvas: snapshot failed: ${err.message}`, { level: "warning" });
            }
        },
    },
});

session.on("user.message", (e) => prompts.add(e.data, e.timestamp || new Date().toISOString()));
session.on("assistant.message", onAssistantMessage);
session.on("tool.execution_start", guard(onToolStart));
session.on("tool.execution_complete", guard(onToolComplete));
