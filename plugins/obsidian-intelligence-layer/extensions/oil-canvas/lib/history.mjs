import { closeSync, createReadStream, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { sessionStateDir } from "./paths.mjs";
import { analyzeResult, compactArgs, oilToolName, resultTextOf, touchesFromArgs } from "./activity.mjs";

/** Record a tool.execution_start event if it is an OIL call. Returns the bare tool name or null. */
export function ingestStart(store, sessionId, data, ts, source = "live") {
    const tool = oilToolName(data);
    if (!tool || !data?.toolCallId) return null;
    store.recordStart({ toolCallId: data.toolCallId, sessionId, tool, args: compactArgs(data.arguments), ts, source });
    store.addTouches(data.toolCallId, sessionId, touchesFromArgs(tool, data.arguments), ts);
    return tool;
}

/** Record a tool.execution_complete event for a previously started OIL call. Returns the call row or null. */
export function ingestComplete(store, data, ts) {
    if (!data?.toolCallId) return null;
    const call = store.getCall(data.toolCallId);
    if (!call) return null;
    const text = resultTextOf(data);
    const args = call.args_json ? JSON.parse(call.args_json) : null;
    const { touches, errorCode, errorMessage, search } = analyzeResult(call.tool, text, args);
    const error =
        data.success === false
            ? String(data.error?.message ?? data.error ?? "failed")
            : errorCode
              ? `${errorCode}${errorMessage ? `: ${errorMessage}` : ""}`
              : null;
    const done = store.recordComplete({
        toolCallId: data.toolCallId,
        ts,
        success: data.success !== false && !errorCode,
        error,
        resultBytes: text ? Buffer.byteLength(text) : null,
    });
    store.recordCallContext(data.toolCallId, { interactionId: data.interactionId ?? null, turnId: data.turnId ?? null, search });
    store.addTouches(data.toolCallId, call.session_id, touches, ts);
    return done;
}

export { PromptBuffer } from "./activity.mjs";

function readWorkspaceMeta(dir) {
    try {
        const text = readFileSync(join(dir, "workspace.yaml"), "utf8");
        const get = (k) => {
            const m = new RegExp(`^${k}:[ \\t]*(.*)$`, "m").exec(text);
            if (!m) return null;
            const v = m[1].trim();
            if (/^[|>][+-]?\d*$/.test(v)) {
                // YAML block scalar: the value is the following indented lines.
                const lines = [];
                for (const line of text.slice(m.index + m[0].length).split(/\r?\n/).slice(1)) {
                    if (line.trim() && !/^\s/.test(line)) break;
                    lines.push(line.trim());
                }
                return lines.join(" ").replace(/\s+/g, " ").trim() || null;
            }
            return v.replace(/^["']|["']$/g, "") || null;
        };
        return { name: get("name") || get("summary"), cwd: get("cwd") };
    } catch {
        return { name: null, cwd: null };
    }
}

/**
 * Import OIL tool calls from Copilot session logs (`session-state/<id>/events.jsonl`).
 * Incremental: files whose size and mtime are unchanged since the last import are skipped.
 */
export async function importHistory(store, { onProgress, signal } = {}) {
    const root = sessionStateDir();
    let dirs = [];
    try {
        dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
        return { files: 0, scanned: 0, skipped: 0, calls: 0 };
    }
    const stats = { files: dirs.length, scanned: 0, skipped: 0, calls: 0, sessionsWithOil: 0 };
    let i = 0;
    for (const id of dirs) {
        if (signal?.aborted) break;
        i++;
        const dir = join(root, id);
        const file = join(dir, "events.jsonl");
        let st;
        try {
            st = statSync(file);
        } catch {
            continue;
        }
        const prev = store.importState(file);
        if (prev && prev.size === st.size && prev.mtime_ms === st.mtimeMs) {
            stats.skipped++;
            continue;
        }
        const found = await importFile(store, id, file);
        if (found > 0) {
            stats.sessionsWithOil++;
            const meta = readWorkspaceMeta(dir);
            store.upsertSession({ sessionId: id, name: meta.name, cwd: meta.cwd, ts: null });
        }
        store.markImported(file, st.size, st.mtimeMs);
        stats.calls += found;
        stats.scanned++;
        if (onProgress && (i % 25 === 0 || i === dirs.length)) onProgress({ ...stats, done: i });
        // Yield so live events and HTTP requests stay responsive during a long import.
        await new Promise((r) => setImmediate(r));
    }
    return stats;
}

async function importFile(store, sessionId, file) {
    const started = new Set();
    const prompts = new Map();
    const answered = new Set();
    let calls = 0;
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    const batch = [];
    const flush = () => {
        if (!batch.length) return;
        store.transaction(() => {
            for (const fn of batch) fn();
        });
        batch.length = 0;
    };
    for await (const line of rl) {
        if (line.startsWith('{"type":"user.message"')) {
            const ev = parse(line);
            if (ev?.data?.interactionId) prompts.set(ev.data.interactionId, { ts: ev.timestamp, prompt: ev.data.content });
            continue;
        }
        if (!line.includes('"type":"tool.execution_')) continue;
        if (line.startsWith('{"type":"tool.execution_start"')) {
            if (!line.includes('"mcpToolName"')) continue;
            const ev = parse(line);
            if (!ev?.data?.toolCallId || !oilToolName(ev.data)) continue;
            started.add(ev.data.toolCallId);
            calls++;
            batch.push(() => ingestStart(store, sessionId, ev.data, ev.timestamp, "history"));
        } else if (line.startsWith('{"type":"tool.execution_complete"')) {
            const m = /"toolCallId":"([^"]+)"/.exec(line);
            if (!m || !started.has(m[1])) continue;
            const ev = parse(line);
            if (!ev) continue;
            if (ev.data?.interactionId) answered.add(ev.data.interactionId);
            batch.push(() => ingestComplete(store, ev.data, ev.timestamp));
        }
        if (batch.length >= 200) flush();
    }
    for (const id of answered) {
        const p = prompts.get(id);
        batch.push(() => store.recordInteraction({ interactionId: id, sessionId, ts: p?.ts ?? null, prompt: typeof p?.prompt === "string" ? p.prompt : null }));
    }
    flush();
    if (calls) {
        const first = parse(readFirstLine(file));
        const ctx = first?.type === "session.start" ? first.data : null;
        store.upsertSession({ sessionId, cwd: ctx?.context?.cwd ?? null, ts: ctx?.startTime ?? null });
    }
    return calls;
}

function readFirstLine(file) {
    let fd;
    try {
        fd = openSync(file, "r");
        const buf = Buffer.alloc(8192);
        const n = readSync(fd, buf, 0, buf.length, 0);
        return buf.subarray(0, n).toString("utf8").split("\n", 1)[0];
    } catch {
        return null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

function parse(line) {
    if (!line) return null;
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}
