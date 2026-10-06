import { closeSync, createReadStream, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { sessionStateDir } from "./paths.mjs";
import { analyzeResult, batchTimings, compactArgs, oilToolName, resultTextOf, touchesFromArgs } from "./activity.mjs";

/** Record a tool.execution_start event if it is an OIL call. Returns the bare tool name or null. */
export function ingestStart(store, sessionId, data, ts, source = "live") {
    const tool = oilToolName(data);
    if (!tool || !data?.toolCallId) return null;
    store.recordStart({ toolCallId: data.toolCallId, sessionId, tool, args: compactArgs(data.arguments), ts, source });
    store.addTouches(data.toolCallId, sessionId, touchesFromArgs(tool, data.arguments), ts);
    return tool;
}

/** Record a tool.execution_complete event for a previously started OIL call. Returns the call row or null.
 *  `timing` carries what the completion event lacks: when OIL received the call and its parallel batch. */
export function ingestComplete(store, data, ts, { mcpStartedAt = null, timing = null, batchSize = null } = {}) {
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
        mcpStartedAt,
        timing,
        batchSize,
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

// A log is resumed from the last point where no OIL call was in flight. If a call never completes
// (e.g. the session was killed), stop waiting for it once this much log has accumulated after it.
const MAX_UNSETTLED_BYTES = 4 * 1024 * 1024;
// Bytes just before the resume offset, compared on the next pass to detect a rewritten log.
const TAIL_BYTES = 64;
const MAX_CARRY_PROMPT = 4000;
// Only these event types are decoded; every other line is skipped after peeking at its prefix.
const WANTED = ['{"type":"user.message"', '{"type":"assistant.message"', '{"type":"hook.start"', '{"type":"tool.execution_start"', '{"type":"tool.execution_complete"'];
const PEEK = 40;

/**
 * Import OIL tool calls from Copilot session logs (`session-state/<id>/events.jsonl`).
 * Incremental: unchanged logs are skipped, and a log that grew is read only from where the last pass
 * settled, so a frequent sync costs about as much as stat-ing the session folders.
 * `full` forgets every resume point and re-reads all logs from the start.
 */
export async function importHistory(store, { onProgress, signal, full = false } = {}) {
    const root = sessionStateDir();
    let dirs = [];
    try {
        dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
        return { files: 0, scanned: 0, skipped: 0, calls: 0, bytes: 0, sessionsWithOil: 0 };
    }
    if (full) store.clearImports();
    const before = store.countHistoryCalls();
    const stats = { files: dirs.length, scanned: 0, skipped: 0, calls: 0, bytes: 0, sessionsWithOil: 0 };
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
        let from = 0;
        let carry = null;
        if (prev?.read_to != null && prev.read_to <= st.size && readTail(file, prev.read_to) === prev.tail) {
            from = prev.read_to;
            carry = parseCarry(prev.carry);
        }
        const r = await importFile(store, id, file, { from, to: st.size, carry });
        if (r.calls > 0) {
            stats.sessionsWithOil++;
            const meta = readWorkspaceMeta(dir);
            store.upsertSession({ sessionId: id, name: meta.name, cwd: meta.cwd, ts: null });
        }
        store.markImported(file, st.size, st.mtimeMs, { readTo: r.settled, tail: readTail(file, r.settled), carry: r.carry ? JSON.stringify(r.carry) : null });
        stats.bytes += st.size - from;
        stats.scanned++;
        if (onProgress && (i % 25 === 0 || i === dirs.length)) onProgress({ ...stats, done: i });
        // Yield so live events and HTTP requests stay responsive during a long import.
        await new Promise((r) => setImmediate(r));
    }
    stats.calls = store.countHistoryCalls() - before;
    return stats;
}

/**
 * Read one log from byte `from` to byte `to`. Returns the OIL calls seen, the offset to resume from
 * next time (`settled`: just after the last line where no OIL call was in flight) and the prompt that
 * was current there (`carry`), since calls after the resume point may still answer it.
 * Re-reading lines after `settled` is harmless: every write below is idempotent.
 */
async function importFile(store, sessionId, file, { from = 0, to, carry = null } = {}) {
    const started = new Set();
    const prompts = new Map();
    const answered = new Set();
    const timings = new Map();
    const mcpStarts = new Map();
    // Requested or started OIL calls that haven't completed yet.
    const pending = new Set();
    let lastPrompt = carry?.prompt?.id ? carry.prompt : null;
    if (lastPrompt) prompts.set(lastPrompt.id, { ts: lastPrompt.ts, prompt: lastPrompt.prompt });
    let calls = 0;
    let pos = from;
    let settled = from;
    let settledPrompt = lastPrompt;
    const batch = [];
    const flush = () => {
        if (!batch.length) return;
        store.transaction(() => {
            for (const fn of batch) fn();
        });
        batch.length = 0;
    };
    const onLine = (line) => {
        if (line.startsWith('{"type":"user.message"')) {
            const ev = parse(line);
            const id = ev?.data?.interactionId;
            if (id) {
                const prompt = typeof ev.data.content === "string" ? ev.data.content : null;
                prompts.set(id, { ts: ev.timestamp, prompt });
                lastPrompt = { id, ts: ev.timestamp ?? null, prompt: prompt ? prompt.slice(0, MAX_CARRY_PROMPT) : null };
            }
            return;
        }
        if (line.startsWith('{"type":"assistant.message"')) {
            if (!line.includes('"toolRequests":[{') || !line.includes('"mcpToolName"')) return;
            const ev = parse(line);
            for (const [id, t] of batchTimings(ev?.data?.toolRequests)) {
                timings.set(id, t);
                pending.add(id);
            }
            return;
        }
        if (line.startsWith('{"type":"hook.start"')) {
            if (!line.includes('"preMcpToolCall"')) return;
            const ev = parse(line);
            const id = ev?.data?.input?.toolCallId;
            if (id && started.has(id)) mcpStarts.set(id, ev.timestamp);
            return;
        }
        if (line.startsWith('{"type":"tool.execution_start"')) {
            if (!line.includes('"mcpToolName"')) return;
            const ev = parse(line);
            if (!ev?.data?.toolCallId || !oilToolName(ev.data)) return;
            started.add(ev.data.toolCallId);
            pending.add(ev.data.toolCallId);
            calls++;
            batch.push(() => ingestStart(store, sessionId, ev.data, ev.timestamp, "history"));
        } else if (line.startsWith('{"type":"tool.execution_complete"')) {
            const m = /"toolCallId":"([^"]+)"/.exec(line);
            if (!m) return;
            pending.delete(m[1]);
            if (!started.has(m[1])) return;
            const ev = parse(line);
            if (!ev) return;
            if (ev.data?.interactionId) answered.add(ev.data.interactionId);
            const timing = { mcpStartedAt: mcpStarts.get(m[1]) ?? null, ...timings.get(m[1]) };
            batch.push(() => ingestComplete(store, ev.data, ev.timestamp, timing));
        }
    };
    if (to > from) {
        // Split on raw bytes so offsets stay exact, and only decode lines of the event types we use.
        // A trailing line without a newline is still being written; it is left for the next pass.
        let parts = [];
        for await (const chunk of createReadStream(file, { start: from, end: to - 1 })) {
            let i = 0;
            let nl;
            while ((nl = chunk.indexOf(10, i)) !== -1) {
                const piece = chunk.subarray(i, nl);
                const buf = parts.length ? Buffer.concat([...parts, piece]) : piece;
                parts = [];
                pos += buf.length + 1;
                i = nl + 1;
                const head = buf.toString("utf8", 0, Math.min(PEEK, buf.length));
                if (WANTED.some((w) => head.startsWith(w))) {
                    let line = buf.toString("utf8");
                    if (line.endsWith("\r")) line = line.slice(0, -1);
                    onLine(line);
                }
                if (pending.size && pos - settled > MAX_UNSETTLED_BYTES) pending.clear();
                if (!pending.size) {
                    settled = pos;
                    settledPrompt = lastPrompt;
                }
                if (batch.length >= 200) flush();
            }
            if (i < chunk.length) parts.push(chunk.subarray(i));
        }
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
    return { calls, settled, carry: settledPrompt ? { prompt: settledPrompt } : null };
}

/** The bytes just before `offset`, base64; a mismatch on the next pass means the log was rewritten. */
function readTail(file, offset) {
    if (!offset) return "";
    let fd;
    try {
        fd = openSync(file, "r");
        const len = Math.min(TAIL_BYTES, offset);
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, offset - len);
        return buf.subarray(0, n).toString("base64");
    } catch {
        return null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

function parseCarry(text) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
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
