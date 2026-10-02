import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { artifactsDir } from "./paths.mjs";
import { WRITE_TOOLS } from "./activity.mjs";
import { computeSearchAnalytics } from "./searchstats.mjs";

// Several Copilot sessions share this database: wait for another writer's lock instead of failing with SQLITE_BUSY.
const SCHEMA = `
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS tool_calls (
    tool_call_id TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    tool         TEXT NOT NULL,
    args_json    TEXT,
    started_at   TEXT,
    completed_at TEXT,
    duration_ms  INTEGER,
    success      INTEGER,
    error        TEXT,
    result_bytes INTEGER,
    source       TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS ix_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS ix_calls_started ON tool_calls(started_at);
CREATE TABLE IF NOT EXISTS touches (
    id           INTEGER PRIMARY KEY,
    tool_call_id TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    path         TEXT NOT NULL,
    kind         TEXT NOT NULL,
    ts           TEXT NOT NULL,
    UNIQUE (tool_call_id, path, kind)
);
CREATE INDEX IF NOT EXISTS ix_touches_session ON touches(session_id);
CREATE INDEX IF NOT EXISTS ix_touches_path ON touches(path);
CREATE TABLE IF NOT EXISTS snapshots (
    tool_call_id  TEXT PRIMARY KEY,
    path          TEXT NOT NULL,
    before_text   TEXT,
    after_text    TEXT,
    before_exists INTEGER NOT NULL,
    captured_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_snapshots_path ON snapshots(path);
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    name       TEXT,
    cwd        TEXT,
    first_seen TEXT,
    last_seen  TEXT
);
CREATE TABLE IF NOT EXISTS imports (
    file     TEXT PRIMARY KEY,
    size     INTEGER NOT NULL,
    mtime_ms REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS interactions (
    interaction_id TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL,
    ts             TEXT,
    prompt         TEXT
);
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
`;

// Columns added after the first release; CREATE TABLE IF NOT EXISTS won't add them to an existing DB.
const CALL_COLUMNS = {
    interaction_id: "TEXT",
    turn_id: "TEXT",
    search_query: "TEXT",
    search_mode: "TEXT",
    hits: "INTEGER",
    top_score: "REAL",
    // When OIL actually received the call (preMcpToolCall), after permission prompts and hooks.
    mcp_started_at: "TEXT",
    // solo | parallel | masked — see batchTimings() in activity.mjs. NULL = unknown.
    timing: "TEXT",
    batch_size: "INTEGER",
};

// Bump when the importer extracts new fields, so past session logs are re-read to backfill them.
const IMPORT_VERSION = "3";

function migrate(db) {
    const have = new Set(db.prepare(`PRAGMA table_info(tool_calls)`).all().map((c) => c.name));
    for (const [name, type] of Object.entries(CALL_COLUMNS)) {
        if (!have.has(name)) db.exec(`ALTER TABLE tool_calls ADD COLUMN ${name} ${type}`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS ix_calls_interaction ON tool_calls(interaction_id)`);
    const v = db.prepare(`SELECT value FROM meta WHERE key = 'import_version'`).get()?.value;
    if (v !== IMPORT_VERSION) {
        db.exec(`DELETE FROM imports`);
        db.prepare(`INSERT INTO meta (key, value) VALUES ('import_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(IMPORT_VERSION);
    }
}

const WRITE_LIST = [...WRITE_TOOLS].map((t) => `'${t}'`).join(",");
// The call hasn't failed (in-flight calls have success = NULL and count as OK).
const OK = "(COALESCE(c.success, 1) = 1 AND c.error IS NULL)";
// The duration measures OIL, not a slower non-OIL tool that ran in the same parallel batch (or a canvas edit).
const TIMED = "(c.duration_ms IS NOT NULL AND COALESCE(c.timing, '') <> 'masked' AND c.tool <> 'canvas_edit')";

export async function openStore(file = join(artifactsDir(), "oil-activity.db")) {
    const { DatabaseSync } = await import("node:sqlite");
    mkdirSync(artifactsDir(), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(SCHEMA);
    migrate(db);
    return new ActivityStore(db, file);
}

export class ActivityStore {
    constructor(db, file) {
        this.db = db;
        this.file = file;
        const s = (sql) => db.prepare(sql);
        this.q = {
            insertCall: s(`INSERT INTO tool_calls (tool_call_id, session_id, tool, args_json, started_at, source)
                           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tool_call_id) DO NOTHING`),
            completeCall: s(`UPDATE tool_calls SET completed_at = ?, duration_ms = ?, success = ?, error = ?, result_bytes = ?,
                                    mcp_started_at = COALESCE(?, mcp_started_at), timing = COALESCE(?, timing),
                                    batch_size = COALESCE(?, batch_size)
                             WHERE tool_call_id = ?`),
            getCall: s(`SELECT * FROM tool_calls WHERE tool_call_id = ?`),
            insertTouch: s(`INSERT OR IGNORE INTO touches (tool_call_id, session_id, path, kind, ts) VALUES (?, ?, ?, ?, ?)`),
            upsertSnapshot: s(`INSERT INTO snapshots (tool_call_id, path, before_text, after_text, before_exists, captured_at)
                               VALUES (?, ?, ?, ?, ?, ?)
                               ON CONFLICT(tool_call_id) DO UPDATE SET after_text = excluded.after_text`),
            getSnapshot: s(`SELECT s.*, c.tool, c.session_id, c.started_at FROM snapshots s LEFT JOIN tool_calls c USING (tool_call_id)
                            WHERE s.tool_call_id = ?`),
            upsertSession: s(`INSERT INTO sessions (session_id, name, cwd, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
                              ON CONFLICT(session_id) DO UPDATE SET
                                name = COALESCE(excluded.name, sessions.name),
                                cwd = COALESCE(excluded.cwd, sessions.cwd),
                                first_seen = MIN(COALESCE(sessions.first_seen, excluded.first_seen), COALESCE(excluded.first_seen, sessions.first_seen)),
                                last_seen = MAX(COALESCE(sessions.last_seen, excluded.last_seen), COALESCE(excluded.last_seen, sessions.last_seen))`),
            getImport: s(`SELECT size, mtime_ms FROM imports WHERE file = ?`),
            setSearch: s(`UPDATE tool_calls SET search_query = ?, search_mode = ?, hits = ?, top_score = ? WHERE tool_call_id = ?`),
            setInteractionOfCall: s(`UPDATE tool_calls SET interaction_id = COALESCE(?, interaction_id), turn_id = COALESCE(?, turn_id)
                                     WHERE tool_call_id = ?`),
            upsertInteraction: s(`INSERT INTO interactions (interaction_id, session_id, ts, prompt) VALUES (?, ?, ?, ?)
                                  ON CONFLICT(interaction_id) DO UPDATE SET
                                    ts = COALESCE(interactions.ts, excluded.ts),
                                    prompt = COALESCE(interactions.prompt, excluded.prompt)`),
            setImport: s(`INSERT INTO imports (file, size, mtime_ms) VALUES (?, ?, ?)
                          ON CONFLICT(file) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms`),
        };
    }

    transaction(fn) {
        // IMMEDIATE takes the write lock up front, so busy_timeout applies (a deferred read→write upgrade fails instantly).
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const r = fn();
            this.db.exec("COMMIT");
            return r;
        } catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
    }

    recordStart({ toolCallId, sessionId, tool, args, ts, source = "live" }) {
        return this.q.insertCall.run(toolCallId, sessionId, tool, args == null ? null : JSON.stringify(args), ts, source).changes > 0;
    }

    recordComplete({ toolCallId, ts, success, error, resultBytes, mcpStartedAt = null, timing = null, batchSize = null }) {
        const call = this.q.getCall.get(toolCallId);
        if (!call) return null;
        const start = mcpStartedAt ?? call.mcp_started_at ?? call.started_at;
        const duration = start && ts ? Math.max(0, Date.parse(ts) - Date.parse(start)) : null;
        this.q.completeCall.run(ts, duration, success ? 1 : 0, error ?? null, resultBytes ?? null, mcpStartedAt, timing, batchSize, toolCallId);
        return { ...call, completed_at: ts, duration_ms: duration, success: success ? 1 : 0, error, timing: timing ?? call.timing };
    }

    getCall(toolCallId) {
        return this.q.getCall.get(toolCallId) ?? null;
    }

    /** Attach the user prompt (interaction) a call answered, and how a search call went. */
    recordCallContext(toolCallId, { interactionId = null, turnId = null, search = null } = {}) {
        if (interactionId || turnId) this.q.setInteractionOfCall.run(interactionId, turnId == null ? null : String(turnId), toolCallId);
        if (search) this.q.setSearch.run(search.query ?? null, search.mode ?? null, search.hits ?? null, search.topScore ?? null, toolCallId);
    }

    /** A user prompt; the unit "one answer" is measured against. */
    recordInteraction({ interactionId, sessionId, ts, prompt }) {
        if (!interactionId || !sessionId) return;
        this.q.upsertInteraction.run(interactionId, sessionId, ts ?? null, cleanPrompt(prompt));
    }

    addTouches(toolCallId, sessionId, touches, ts) {
        for (const t of touches) this.q.insertTouch.run(toolCallId, sessionId, t.path, t.kind, ts);
    }

    touchesOf(toolCallId) {
        return this.db.prepare(`SELECT path, kind FROM touches WHERE tool_call_id = ?`).all(toolCallId);
    }

    saveSnapshot({ toolCallId, path, beforeText, afterText, beforeExists, ts }) {
        this.q.upsertSnapshot.run(toolCallId, path, beforeText ?? null, afterText ?? null, beforeExists ? 1 : 0, ts);
    }

    getSnapshot(toolCallId) {
        return this.q.getSnapshot.get(toolCallId) ?? null;
    }

    upsertSession({ sessionId, name = null, cwd = null, ts }) {
        this.q.upsertSession.run(sessionId, name, cwd, ts, ts);
    }

    importState(file) {
        return this.q.getImport.get(file) ?? null;
    }

    markImported(file, size, mtimeMs) {
        this.q.setImport.run(file, size, mtimeMs);
    }

    // ── Read models for the canvas ──────────────────────────────────────

    /** Notes touched + recent OIL calls, optionally scoped to one session. */
    activity(sessionId = null, { limitNotes = 300, limitCalls = 200 } = {}) {
        // A write that OIL rejected (e.g. an mtime conflict) didn't change the note, so it
        // counts as a failed attempt rather than a modification.
        const notes = this.db
            .prepare(
                `SELECT t.path,
                        SUM(t.kind = 'modified' AND ${OK}) AS modified,
                        SUM(t.kind = 'created'  AND ${OK}) AS created,
                        SUM(t.kind IN ('modified','created') AND NOT ${OK}) AS failed_writes,
                        SUM(t.kind = 'read')     AS reads,
                        SUM(t.kind = 'surfaced') AS surfaced,
                        COUNT(DISTINCT t.session_id) AS sessions,
                        MAX(t.ts) AS last_ts
                   FROM touches t LEFT JOIN tool_calls c USING (tool_call_id)
                  WHERE (?1 IS NULL OR t.session_id = ?1)
               GROUP BY t.path
               ORDER BY (SUM(t.kind IN ('modified','created')) > 0) DESC, (SUM(t.kind = 'read') > 0) DESC, last_ts DESC
                  LIMIT ?2`,
            )
            .all(sessionId, limitNotes);
        const calls = this.db
            .prepare(
                `SELECT c.tool_call_id, c.session_id, c.tool, c.args_json, c.started_at, c.duration_ms, c.timing, c.success, c.error,
                        (SELECT json_group_array(json_object('path', t.path, 'kind', t.kind))
                           FROM touches t WHERE t.tool_call_id = c.tool_call_id) AS touches_json,
                        EXISTS (SELECT 1 FROM snapshots s WHERE s.tool_call_id = c.tool_call_id) AS has_snapshot
                   FROM tool_calls c
                  WHERE (?1 IS NULL OR c.session_id = ?1)
               ORDER BY c.started_at DESC
                  LIMIT ?2`,
            )
            .all(sessionId, limitCalls)
            .map(({ args_json, touches_json, ...c }) => ({
                ...c,
                args: safeParse(args_json),
                touches: safeParse(touches_json) || [],
            }));
        const totals = this.db
            .prepare(
                `SELECT COUNT(*) AS calls,
                        SUM(tool IN (${WRITE_LIST})) AS writes,
                        SUM(success = 0 OR error IS NOT NULL) AS errors
                   FROM tool_calls WHERE (?1 IS NULL OR session_id = ?1)`,
            )
            .get(sessionId);
        return { notes, calls, totals };
    }

    /** Every recorded touch of one note, with snapshots of the writes. */
    noteHistory(path, sessionId = null) {
        const events = this.db
            .prepare(
                `SELECT t.kind, t.ts, t.session_id, c.tool, c.tool_call_id, c.success, c.error, c.args_json,
                        s.name AS session_name,
                        EXISTS (SELECT 1 FROM snapshots x WHERE x.tool_call_id = c.tool_call_id) AS has_snapshot
                   FROM touches t
              LEFT JOIN tool_calls c USING (tool_call_id)
              LEFT JOIN sessions s ON s.session_id = t.session_id
                  WHERE t.path = ?1 AND (?2 IS NULL OR t.session_id = ?2)
               ORDER BY t.ts DESC LIMIT 200`,
            )
            .all(path, sessionId)
            .map(({ args_json, ...e }) => ({ ...e, args: safeParse(args_json) }));
        return { path, events };
    }

    analytics({ sessionId = null, sinceIso = null } = {}) {
        const where = `(?1 IS NULL OR c.session_id = ?1) AND (?2 IS NULL OR c.started_at >= ?2)`;
        const totals = this.db
            .prepare(
                `SELECT COUNT(*) AS calls,
                        COUNT(DISTINCT c.session_id) AS sessions,
                        SUM(c.tool IN (${WRITE_LIST})) AS writes,
                        SUM(c.success = 0 OR c.error IS NOT NULL) AS errors,
                        ROUND(AVG(CASE WHEN ${TIMED} THEN c.duration_ms END)) AS avg_ms,
                        SUM(c.timing = 'masked') AS masked,
                        MIN(c.started_at) AS first_ts,
                        MAX(c.started_at) AS last_ts
                   FROM tool_calls c WHERE ${where}`,
            )
            .get(sessionId, sinceIso);
        const byTool = this.db
            .prepare(
                `SELECT c.tool, COUNT(*) AS calls, ROUND(AVG(CASE WHEN ${TIMED} THEN c.duration_ms END)) AS avg_ms,
                        SUM(c.success = 0 OR c.error IS NOT NULL) AS errors
                   FROM tool_calls c WHERE ${where} GROUP BY c.tool ORDER BY calls DESC`,
            )
            .all(sessionId, sinceIso);
        const durations = this.db
            .prepare(`SELECT c.duration_ms AS d FROM tool_calls c WHERE ${where} AND ${TIMED} ORDER BY d`)
            .all(sessionId, sinceIso)
            .map((r) => r.d);
        const byDay = this.db
            .prepare(
                `SELECT substr(c.started_at, 1, 10) AS day, COUNT(*) AS calls, SUM(c.tool IN (${WRITE_LIST})) AS writes,
                        SUM(c.success = 0 OR c.error IS NOT NULL) AS errors
                   FROM tool_calls c WHERE ${where} GROUP BY day ORDER BY day`,
            )
            .all(sessionId, sinceIso);
        const byKind = this.db
            .prepare(
                `SELECT t.kind, COUNT(*) AS touches, COUNT(DISTINCT t.path) AS notes
                   FROM touches t JOIN tool_calls c USING (tool_call_id)
                  WHERE ${where} GROUP BY t.kind ORDER BY touches DESC`,
            )
            .all(sessionId, sinceIso);
        const timed = this.db
            .prepare(`SELECT c.tool, c.started_at AS ts, CASE WHEN ${TIMED} THEN c.duration_ms END AS d FROM tool_calls c WHERE ${where} AND c.started_at IS NOT NULL`)
            .all(sessionId, sinceIso);
        const noteRows = this.db
            .prepare(
                `SELECT t.path, COUNT(*) AS touches,
                        SUM(t.kind IN ('modified','created') AND ${OK}) AS writes,
                        SUM(t.kind = 'read') AS reads,
                        SUM(t.kind = 'surfaced') AS surfaced
                   FROM touches t JOIN tool_calls c USING (tool_call_id)
                  WHERE ${where} GROUP BY t.path`,
            )
            .all(sessionId, sinceIso);
        const bySession = this.db
            .prepare(
                `SELECT c.session_id, s.name, s.cwd, COUNT(*) AS calls, SUM(c.tool IN (${WRITE_LIST})) AS writes,
                        MIN(c.started_at) AS first_ts, MAX(c.started_at) AS last_ts
                   FROM tool_calls c LEFT JOIN sessions s USING (session_id)
                  WHERE ${where} GROUP BY c.session_id ORDER BY last_ts DESC LIMIT 50`,
            )
            .all(sessionId, sinceIso);

        const folders = new Map();
        for (const n of noteRows) {
            const folder = n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "(vault root)";
            const top = folder.split("/").slice(0, 2).join("/");
            const f = folders.get(top) || { folder: top, touches: 0, writes: 0, notes: 0 };
            f.touches += n.touches;
            f.writes += n.writes;
            f.notes += 1;
            folders.set(top, f);
        }
        const pct = (p) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(p * durations.length))] : null);

        // Weekday × hour in the machine's local time zone (Sunday = 0).
        const punchcard = Array.from({ length: 7 }, () => new Array(24).fill(0));
        const perTool = new Map();
        for (const r of timed) {
            const d = new Date(r.ts);
            if (!Number.isNaN(d.getTime())) punchcard[d.getDay()][d.getHours()]++;
            if (r.d != null) {
                if (!perTool.has(r.tool)) perTool.set(r.tool, []);
                perTool.get(r.tool).push(r.d);
            }
        }
        const quant = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
        const toolLatency = [...perTool]
            .map(([tool, ds]) => {
                ds.sort((a, b) => a - b);
                return { tool, n: ds.length, p50: quant(ds, 0.5), p95: quant(ds, 0.95), max: ds[ds.length - 1] };
            })
            .sort((a, b) => b.p95 - a.p95);
        const edges = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
        const latency = [...edges, Infinity].map((hi, i) => ({ lo: i ? edges[i - 1] : 0, hi: Number.isFinite(hi) ? hi : null, count: 0 }));
        for (const d of durations) {
            const i = edges.findIndex((e) => d < e);
            latency[i === -1 ? edges.length : i].count++;
        }

        return {
            totals: { ...totals, notes: noteRows.length, timed: durations.length, p50_ms: pct(0.5), p95_ms: pct(0.95) },
            byTool,
            byDay,
            byKind,
            punchcard,
            latency,
            toolLatency,
            bySession,
            topNotes: [...noteRows].sort((a, b) => b.writes - a.writes || b.touches - a.touches).slice(0, 25),
            topFolders: [...folders.values()].sort((a, b) => b.touches - a.touches).slice(0, 20),
        };
    }

    /** How hard the agent had to search per answer, and how each search tool and mode performed. */
    searchAnalytics({ sessionId = null, sinceIso = null } = {}) {
        const where = `(?1 IS NULL OR c.session_id = ?1) AND (?2 IS NULL OR c.started_at >= ?2) AND c.tool <> 'canvas_edit'`;
        const calls = this.db
            .prepare(
                `SELECT c.tool_call_id, c.session_id, c.interaction_id, c.tool, c.search_query, c.search_mode, c.hits, c.top_score,
                        c.duration_ms, c.timing, c.success, c.error, c.started_at, s.name AS session_name
                   FROM tool_calls c LEFT JOIN sessions s USING (session_id)
                  WHERE ${where}
               ORDER BY c.session_id, c.started_at, c.rowid`,
            )
            .all(sessionId, sinceIso);
        const touches = this.db
            .prepare(`SELECT t.tool_call_id, t.path, t.kind FROM touches t JOIN tool_calls c USING (tool_call_id) WHERE ${where}`)
            .all(sessionId, sinceIso);
        const interactions = this.db
            .prepare(
                `SELECT i.interaction_id, i.ts, i.prompt FROM interactions i
                  WHERE i.interaction_id IN (SELECT DISTINCT c.interaction_id FROM tool_calls c WHERE ${where} AND c.interaction_id IS NOT NULL)`,
            )
            .all(sessionId, sinceIso);
        return computeSearchAnalytics({ calls, touches, interactions });
    }

    /** Record a note edit made in the canvas so it appears in history and diffs like an OIL write. */
    recordCanvasEdit({ toolCallId, sessionId, path, beforeText, afterText, beforeExists, ts }) {
        this.transaction(() => {
            this.q.insertCall.run(toolCallId, sessionId, "canvas_edit", JSON.stringify({ path }), ts, "canvas");
            this.q.completeCall.run(ts, null, 1, null, Buffer.byteLength(afterText ?? ""), null, null, null, toolCallId);
            this.q.insertTouch.run(toolCallId, sessionId, path, beforeExists ? "modified" : "created", ts);
            this.q.upsertSnapshot.run(toolCallId, path, beforeText ?? null, afterText ?? null, beforeExists ? 1 : 0, ts);
        });
    }

    close() {
        try {
            this.db.close();
        } catch {}
    }
}

function safeParse(s) {
    if (s == null) return null;
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
}

const INJECTED_BLOCK = /<(skill-context|current_datetime|system_reminder|system-reminder|reminder|attachments?|context)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** The user's own words: injected skill/system blocks removed, whitespace collapsed, truncated. */
export function cleanPrompt(prompt) {
    if (typeof prompt !== "string") return null;
    const skills = [...prompt.matchAll(/<skill-context\s+name="([^"]+)"/gi)].map((m) => `/${m[1]}`);
    let text = prompt.replace(INJECTED_BLOCK, " ").replace(/<\/?[a-z_-]+(\s[^>]*)?>/gi, " ").replace(/\s+/g, " ").trim();
    if (skills.length) text = `${[...new Set(skills)].join(" ")}${text ? ` ${text}` : ""}`;
    if (!text) return null;
    return text.length > 280 ? `${text.slice(0, 279)}…` : text;
}
