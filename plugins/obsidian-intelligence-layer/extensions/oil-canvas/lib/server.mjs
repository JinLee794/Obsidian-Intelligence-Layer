import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, statSync, existsSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { artifactsDir, normalizeNotePath, resolveInVault } from "./paths.mjs";
import { tryLock } from "./lock.mjs";
import { browseRoots, detectOilVaults, isObsidianVault, listDirectory, listObsidianVaults, loadSettings, loadVaultAppearance, saveSettings } from "./vaults.mjs";
import { renderMarkdown, esc } from "./markdown.mjs";
import { diffLines } from "./diff.mjs";
import { VaultGraph, resolveLink } from "./vaultgraph.mjs";

export { resolveLink };

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SAVE_BODY_BYTES = MAX_NOTE_BYTES * 2 + 64 * 1024;
const MAX_ASK_CHARS = 8000;
const MAX_DRAFTS = 8;
// Drop the parsed vault graph after this long without a request that needs it; it is rebuilt on demand.
const GRAPH_IDLE_MS = 5 * 60_000;
const ASSET_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
    // SVG is served with a CSP sandbox so embedded scripts cannot run.
    ".svg": "image/svg+xml",
};
// Any top-level .js/.css file in web/ (no token needed: they contain no data).
const STATIC_RE = /^\/([\w-]+)\.(js|css)$/;
const STATIC_TYPES = { js: "text/javascript", css: "text/css" };
const isStatic = (pathname) => STATIC_RE.test(pathname);

/**
 * One loopback server per extension process, shared by every canvas panel.
 * Every request needs the per-process token; the Host header must be loopback.
 */
export class CanvasServer {
    constructor({ getStore, sessionId, cwd, log, onAsk, importLockFile, graphIdleMs = GRAPH_IDLE_MS }) {
        this.getStore = getStore;
        this.sessionId = sessionId;
        this.cwd = cwd;
        this.log = log || (() => {});
        this.onAsk = onAsk || null;
        this.importLockFile = importLockFile || join(artifactsDir(), "import.lock");
        this.graphIdleMs = graphIdleMs;
        this.token = randomBytes(24).toString("base64url");
        this.clients = new Set();
        this.importJob = null;
        this.graph = null;
        this.graphUsedAt = 0;
        this.graphTimer = null;
        this.drafts = new Map();
        this.server = null;
        this.port = null;
    }

    async start() {
        if (this.server) return this.port;
        this.server = createServer((req, res) => this.handle(req, res).catch((err) => this.fail(res, err)));
        await new Promise((resolveListen, reject) => {
            this.server.once("error", reject);
            this.server.listen(0, "127.0.0.1", resolveListen);
        });
        this.port = this.server.address().port;
        // Keep-alive SSE connections should not hold the process open.
        this.server.unref();
        return this.port;
    }

    url(query = {}) {
        const params = new URLSearchParams({ t: this.token, ...Object.fromEntries(Object.entries(query).filter(([, v]) => v != null && v !== "")) });
        return `http://127.0.0.1:${this.port}/?${params}`;
    }

    get running() {
        return Boolean(this.server);
    }

    /** Stop listening and drop the vault graph. Drafts and the token survive, so `start()` can resume. */
    stop() {
        for (const res of this.clients) res.end();
        this.clients.clear();
        this.server?.close();
        this.server?.closeAllConnections?.();
        this.server = null;
        this.releaseGraph();
    }

    releaseGraph() {
        this.graph = null;
        if (this.graphTimer) clearInterval(this.graphTimer);
        this.graphTimer = null;
    }

    /** Push an event to every open canvas panel. */
    broadcast(type, data = {}) {
        const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of this.clients) res.write(payload);
    }

    // ── State ───────────────────────────────────────────────────────────

    settings() {
        return loadSettings();
    }

    vaultPath() {
        const v = this.settings().vaultPath;
        return v && existsSync(v) ? v : null;
    }

    state() {
        const settings = this.settings();
        const oilVaults = detectOilVaults(this.cwd);
        const vault = settings.vaultPath;
        const sameAs = (p) => p && vault && p.toLowerCase().replace(/[\\/]+$/, "") === vault.toLowerCase().replace(/[\\/]+$/, "");
        let appearance = null;
        if (vault && existsSync(vault)) {
            const a = loadVaultAppearance(vault);
            appearance = { themeName: a.themeName, snippets: a.snippets, baseTheme: a.baseTheme, accentColor: a.accentColor };
        }
        return {
            sessionId: this.sessionId,
            vault: vault ? { path: vault, name: vault.split(/[\\/]/).filter(Boolean).pop(), exists: existsSync(vault), isVault: isObsidianVault(vault) } : null,
            useVaultTheme: settings.useVaultTheme !== false,
            appearance,
            oilVaults,
            oilMismatch: Boolean(vault && oilVaults.length && !oilVaults.some((v) => sameAs(v.path))),
            importing: this.importJob ? this.importJob.progress : null,
        };
    }

    // ── Routing ─────────────────────────────────────────────────────────

    async handle(req, res) {
        const url = new URL(req.url, "http://127.0.0.1");
        const host = req.headers.host || "";
        if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return this.send(res, 421, "text/plain", "Misdirected request");
        const token = url.searchParams.get("t") || req.headers["x-oil-token"];
        if (token !== this.token && !(req.method === "GET" && isStatic(url.pathname))) return this.send(res, 403, "text/plain", "Forbidden");

        const route = `${req.method} ${url.pathname}`;
        const q = (k) => url.searchParams.get(k);
        if (req.method === "GET" && isStatic(url.pathname)) {
            const [, name, ext] = STATIC_RE.exec(url.pathname);
            const file = join(WEB_DIR, `${name}.${ext}`);
            if (!existsSync(file)) return this.send(res, 404, "text/plain", "Not found");
            return this.send(res, 200, `${STATIC_TYPES[ext]}; charset=utf-8`, readFileSync(file));
        }
        switch (route) {
            case "GET /":
                return this.send(res, 200, "text/html; charset=utf-8", readFileSync(join(WEB_DIR, "index.html")), { csp: true });
            case "GET /render":
                return this.render(res, q("path"), q("mode"), { draft: q("draft"), embed: q("embed") === "1" });
            case "GET /asset":
                return this.asset(res, q("path"));
            case "GET /events":
                return this.events(req, res);
            case "GET /api/state":
                return this.json(res, this.state());
            case "GET /api/vaults":
                return this.json(res, { obsidian: listObsidianVaults(), oil: detectOilVaults(this.cwd) });
            case "GET /api/fs":
                return this.fs(res, q("path"));
            case "GET /api/activity": {
                const store = await this.getStore();
                return this.json(res, { scope: this.scope(q("scope")), ...store.activity(this.scopeId(q("scope"))), missing: this.missingNotes(store, q("scope")) });
            }
            case "GET /api/note":
                return this.note(res, q("path"), q("scope"));
            case "GET /api/diff":
                return this.diff(res, q("toolCallId"));
            case "GET /api/analytics": {
                const store = await this.getStore();
                const days = Number(q("days")) || null;
                const sinceIso = days ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
                return this.json(res, store.analytics({ sessionId: this.scopeId(q("scope")), sinceIso }));
            }
            case "GET /api/search-analytics": {
                const store = await this.getStore();
                const days = Number(q("days")) || null;
                const sinceIso = days ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
                return this.json(res, store.searchAnalytics({ sessionId: this.scopeId(q("scope")), sinceIso }));
            }
            case "POST /api/vault": {
                const body = await this.body(req);
                return this.json(res, this.selectVault(body.path));
            }
            case "POST /api/settings": {
                const body = await this.body(req);
                const s = this.settings();
                if (typeof body.useVaultTheme === "boolean") s.useVaultTheme = body.useVaultTheme;
                saveSettings(s);
                this.broadcast("state", this.state());
                return this.json(res, this.state());
            }
            case "POST /api/import-history": {
                const { promise, ...r } = this.startImport();
                return this.json(res, r);
            }
            case "POST /api/open-in-obsidian": {
                const body = await this.body(req);
                return this.json(res, this.openInObsidian(body.path));
            }
            case "POST /api/open-url": {
                const body = await this.body(req);
                return this.json(res, this.openUrl(body.url));
            }
            case "GET /api/tree":
                return this.json(res, this.requireGraph().tree());
            case "GET /api/links":
                return this.json(res, this.requireGraph().linksFor(this.requirePath(q("path"))));
            case "GET /api/graph": {
                const depth = Math.min(3, Math.max(1, Number(q("depth")) || 1));
                return this.json(res, this.requireGraph().localGraph(this.requirePath(q("path")), depth));
            }
            case "GET /api/tag":
                return this.json(res, this.requireGraph().tagged(q("tag")));
            case "GET /api/hygiene":
                return this.json(res, this.hygiene());
            case "GET /api/raw":
                return this.raw(res, q("path"));
            case "POST /api/save":
                return this.json(res, await this.save(await this.body(req, MAX_SAVE_BODY_BYTES)));
            case "POST /api/draft":
                return this.json(res, this.saveDraft(await this.body(req, MAX_SAVE_BODY_BYTES)));
            case "POST /api/ask-copilot":
                return this.json(res, await this.askCopilot(await this.body(req)));
            default:
                return this.send(res, 404, "text/plain", "Not found");
        }
    }

    scope(s) {
        return s === "all" ? "all" : "session";
    }

    scopeId(s) {
        return this.scope(s) === "all" ? null : this.sessionId;
    }

    // ── Vault selection & browsing ──────────────────────────────────────

    selectVault(path) {
        if (typeof path !== "string" || !path.trim()) throw httpError(400, "path is required");
        let st;
        try {
            st = statSync(path);
        } catch {
            throw httpError(400, "Folder does not exist");
        }
        if (!st.isDirectory()) throw httpError(400, "Not a folder");
        const s = this.settings();
        s.vaultPath = path;
        saveSettings(s);
        this.graph = null;
        this.drafts.clear();
        const state = this.state();
        this.broadcast("state", state);
        return state;
    }

    fs(res, path) {
        try {
            return this.json(res, { roots: browseRoots(), dir: listDirectory(path || null) });
        } catch (err) {
            throw httpError(400, err.code === "ENOENT" ? "Folder does not exist" : err.code === "EPERM" || err.code === "EACCES" ? "Permission denied" : err.message);
        }
    }

    // ── Notes ───────────────────────────────────────────────────────────

    readNote(notePath) {
        const vault = this.vaultPath();
        const abs = vault ? resolveInVault(vault, notePath) : null;
        if (!abs) return { exists: false, abs: null };
        try {
            const st = statSync(abs);
            if (!st.isFile()) return { exists: false, abs };
            if (st.size > MAX_NOTE_BYTES) return { exists: true, abs, tooLarge: true, size: st.size, mtime: st.mtime.toISOString() };
            return { exists: true, abs, text: readFileSync(abs, "utf8"), size: st.size, mtime: st.mtime.toISOString() };
        } catch {
            return { exists: false, abs };
        }
    }

    async note(res, path, scope) {
        const rel = normalizeNotePath(path);
        if (!rel) throw httpError(400, "Invalid path");
        const store = await this.getStore();
        const n = this.readNote(rel);
        return this.json(res, {
            path: rel,
            exists: n.exists,
            tooLarge: Boolean(n.tooLarge),
            size: n.size ?? null,
            mtime: n.mtime ?? null,
            history: store.noteHistory(rel, this.scopeId(scope)).events,
        });
    }

    missingNotes(store, scope) {
        const vault = this.vaultPath();
        if (!vault) return [];
        const { notes } = store.activity(this.scopeId(scope), { limitCalls: 0 });
        return notes.filter((n) => {
            const abs = resolveInVault(vault, n.path);
            return !abs || !existsSync(abs);
        }).map((n) => n.path);
    }

    async diff(res, toolCallId) {
        if (!toolCallId) throw httpError(400, "toolCallId is required");
        const store = await this.getStore();
        const snap = store.getSnapshot(toolCallId);
        if (!snap) throw httpError(404, "No snapshot was captured for this call");
        const d = diffLines(snap.before_text ?? "", snap.after_text ?? "");
        return this.json(res, {
            toolCallId,
            path: snap.path,
            tool: snap.tool,
            ts: snap.started_at || snap.captured_at,
            beforeExists: Boolean(snap.before_exists),
            afterCaptured: snap.after_text != null,
            ...d,
        });
    }

    /** A full HTML document for the sandboxed note iframe, styled with the vault's theme and snippets. */
    render(res, path, mode, { draft = null, embed = false } = {}) {
        const rel = normalizeNotePath(path);
        if (!rel) throw httpError(400, "Invalid path");
        const n = this.readNote(rel);
        const d = draft ? this.drafts.get(rel) : null;
        if (d && d.id === draft) Object.assign(n, { exists: true, tooLarge: false, text: d.text });
        const settings = this.settings();
        const vault = this.vaultPath();
        const appearance = vault && settings.useVaultTheme !== false ? loadVaultAppearance(vault) : null;
        let dark = mode !== "light";
        if (appearance?.baseTheme === "dark") dark = true;
        if (appearance?.baseTheme === "light") dark = false;

        let body;
        if (!vault) body = `<p class="oil-empty">Choose a vault to preview notes.</p>`;
        else if (!n.exists) body = `<div class="callout" data-callout="warning"><div class="callout-title"><div class="callout-title-inner">Note not found in the selected vault</div></div><div class="callout-content"><p><code>${esc(rel)}</code></p></div></div>`;
        else if (n.tooLarge) body = `<p class="oil-empty">This note is too large to preview (${Math.round(n.size / 1024)} KB).</p>`;
        else {
            const index = this.vaultIndex();
            body = renderMarkdown(n.text, {
                resolve: (target) => resolveLink(index, target, rel),
                assetUrl: (p) => `/asset?t=${encodeURIComponent(this.token)}&path=${encodeURIComponent(p)}`,
            }).html;
        }
        const title = rel.split("/").pop().replace(/\.md$/i, "");
        const nonce = randomBytes(16).toString("base64");
        const accent = appearance?.accentColor && /^#[0-9a-f]{3,8}$/i.test(appearance.accentColor) ? `body{--accent-color:${appearance.accentColor}}` : "";
        const fontSize = appearance?.baseFontSize ? `body{--font-text-size:${Number(appearance.baseFontSize)}px}` : "";
        const embedCss = embed
            ? "body.oil-embed .markdown-preview-sizer{padding:14px 18px 18px!important;max-width:none!important;width:auto!important}body.oil-embed .inline-title{font-size:1.4em;margin-bottom:.4em}body.oil-embed{overflow-x:hidden}"
            : "";
        const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${readFileSync(join(WEB_DIR, "obsidian-base.css"), "utf8")}${accent}${fontSize}${embedCss}</style>
${appearance?.css ? `<style>${appearance.css}</style>` : ""}
</head>
<body class="${dark ? "theme-dark" : "theme-light"} oil-render${embed ? " oil-embed" : ""}">
<div class="app-container"><div class="workspace-leaf-content" data-type="markdown"><div class="view-content">
<div class="markdown-reading-view"><div class="markdown-preview-view markdown-rendered node-insert-event allow-fold-headings allow-fold-lists is-readable-line-width">
<div class="markdown-preview-sizer markdown-preview-section">
<div class="inline-title">${esc(title)}</div>
${body}
</div></div></div></div></div></div>
<script nonce="${nonce}">
(function () {
  var post = function (m) { parent.postMessage(m, "*"); };
  var scrollToHeading = function (text) {
    var want = String(text || "").trim().toLowerCase();
    var hs = document.querySelectorAll("[data-heading]");
    for (var i = 0; i < hs.length; i++) if (hs[i].getAttribute("data-heading").trim().toLowerCase() === want) { hs[i].scrollIntoView({ behavior: "smooth", block: "start" }); return true; }
    return false;
  };
  document.addEventListener("click", function (e) {
    var a = e.target.closest("a");
    if (a) {
      e.preventDefault();
      var href = a.dataset.href || "";
      if (a.classList.contains("internal-link") && !a.dataset.path && href.charAt(0) === "#") { scrollToHeading(href.slice(1)); return; }
      if (a.classList.contains("internal-link")) post({ type: "oil-open-note", path: a.dataset.path || null, href: href, newTab: e.ctrlKey || e.metaKey });
      else if (a.classList.contains("tag")) post({ type: "oil-tag", tag: a.dataset.tag });
      else if (a.classList.contains("external-link")) post({ type: "oil-open-url", url: a.getAttribute("href") });
      return;
    }
    var t = e.target.closest(".callout.is-collapsible > .callout-title");
    if (t) { var c = t.nextElementSibling; if (c) { var hidden = c.style.display === "none"; c.style.display = hidden ? "" : "none"; t.parentElement.classList.toggle("is-collapsed", !hidden); } }
  });
  var timer = null;
  document.addEventListener("mouseover", function (e) {
    var a = e.target.closest("a.internal-link[data-path]");
    if (!a) return;
    clearTimeout(timer);
    timer = setTimeout(function () {
      var r = a.getBoundingClientRect();
      post({ type: "oil-hover", path: a.dataset.path, href: a.dataset.href, rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
    }, 450);
  });
  document.addEventListener("mouseout", function (e) {
    if (!e.target.closest("a.internal-link")) return;
    clearTimeout(timer);
    post({ type: "oil-hover-end" });
  });
  window.addEventListener("message", function (e) {
    if (e.source !== parent || !e.data) return;
    if (e.data.type === "oil-scroll") { var el = document.getElementById(e.data.id); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }
    if (e.data.type === "oil-scroll-heading") scrollToHeading(e.data.heading);
  });
  var items = [].map.call(document.querySelectorAll("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]"), function (h) {
    return { id: h.id, level: Number(h.tagName.slice(1)), text: h.textContent };
  });
  post({ type: "oil-outline", items: items });
})();
</script>
</body></html>`;
        const csp = [
            "default-src 'none'",
            "style-src 'unsafe-inline' https: data:",
            "font-src https: data:",
            "img-src 'self' https: data:",
            `script-src 'nonce-${nonce}'`,
            "base-uri 'none'",
            "form-action 'none'",
        ].join("; ");
        return this.send(res, 200, "text/html; charset=utf-8", html, { headers: { "Content-Security-Policy": csp } });
    }

    asset(res, path) {
        const vault = this.vaultPath();
        const type = ASSET_TYPES[extname(String(path || "")).toLowerCase()];
        const abs = vault && type ? resolveInVault(vault, path) : null;
        if (!abs) return this.send(res, 404, "text/plain", "Not found");
        try {
            const st = statSync(abs);
            if (!st.isFile() || st.size > 20 * 1024 * 1024) return this.send(res, 404, "text/plain", "Not found");
            return this.send(res, 200, type, readFileSync(abs), {
                headers: { "Cache-Control": "private, max-age=300", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" },
            });
        } catch {
            return this.send(res, 404, "text/plain", "Not found");
        }
    }

    /** Lower-cased lookup tables of vault files for resolving wikilinks. */
    vaultIndex() {
        return this.vaultGraph()?.index ?? null;
    }

    vaultGraph() {
        const vault = this.vaultPath();
        if (!vault) return null;
        if (!this.graph || this.graph.vault !== vault) this.graph = new VaultGraph(vault);
        this.graphUsedAt = Date.now();
        if (!this.graphTimer) {
            this.graphTimer = setInterval(() => {
                if (Date.now() - this.graphUsedAt >= this.graphIdleMs) this.releaseGraph();
            }, Math.min(60_000, this.graphIdleMs));
            this.graphTimer.unref();
        }
        return this.graph.refresh();
    }

    requireGraph() {
        const g = this.vaultGraph();
        if (!g) throw httpError(409, "Choose a vault first");
        return g;
    }

    requirePath(path) {
        const rel = normalizeNotePath(path);
        if (!rel) throw httpError(400, "Invalid path");
        return rel;
    }

    hygiene() {
        const g = this.requireGraph();
        const vault = this.vaultPath();
        return { vault: { path: vault, name: vault.split(/[\\/]/).filter(Boolean).pop() }, ...g.hygiene() };
    }

    /** Raw markdown for the editor, with the mtime used to detect conflicting saves. */
    raw(res, path) {
        const rel = this.requirePath(path);
        const n = this.readNote(rel);
        if (!n.exists) return this.json(res, { path: rel, exists: false, text: "", mtimeMs: null });
        if (n.tooLarge) throw httpError(413, "Note is too large to edit here");
        return this.json(res, { path: rel, exists: true, text: n.text, mtimeMs: statSync(n.abs).mtimeMs });
    }

    /** Write a note from the editor. Refuses to clobber a file that changed since it was loaded. */
    async save(body) {
        const rel = this.requirePath(body?.path);
        if (!/\.md$/i.test(rel)) throw httpError(400, "Only markdown notes can be edited");
        if (typeof body.text !== "string") throw httpError(400, "text is required");
        const text = body.text;
        if (Buffer.byteLength(text, "utf8") > MAX_NOTE_BYTES) throw httpError(413, "Note is too large");
        const vault = this.vaultPath();
        const abs = vault ? resolveInVault(vault, rel) : null;
        if (!abs) throw httpError(400, "Invalid path");
        let st = null;
        try {
            st = statSync(abs);
        } catch {}
        if (st && !st.isFile()) throw httpError(400, "Not a file");
        if (st && body.create) throw httpError(409, "A note with that name already exists");
        if (!st && !body.create) throw httpError(404, "The note no longer exists");
        if (st && body.expectedMtimeMs != null && Math.abs(st.mtimeMs - Number(body.expectedMtimeMs)) > 1) {
            throw Object.assign(httpError(409, "The note changed on disk since you opened it"), { extra: { conflict: true, mtimeMs: st.mtimeMs } });
        }
        if (st && st.size > MAX_NOTE_BYTES) throw httpError(413, "Note is too large to edit here");
        const before = st ? readFileSync(abs, "utf8") : null;
        if (before === text) return { ok: true, path: rel, mtimeMs: st.mtimeMs, unchanged: true };

        mkdirSync(dirname(abs), { recursive: true });
        const tmp = `${abs}.oil-canvas-${randomBytes(4).toString("hex")}.tmp`;
        try {
            writeFileSync(tmp, text, "utf8");
            renameSync(tmp, abs);
        } catch {
            // Sync clients (OneDrive, Dropbox) can briefly lock the target; fall back to an in-place write.
            try {
                unlinkSync(tmp);
            } catch {}
            writeFileSync(abs, text, "utf8");
        }
        const mtimeMs = statSync(abs).mtimeMs;
        const store = await this.getStore();
        store.recordCanvasEdit({
            toolCallId: `canvas-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
            sessionId: this.sessionId,
            path: rel,
            beforeText: before,
            afterText: text,
            beforeExists: Boolean(st),
            ts: new Date().toISOString(),
        });
        this.graph?.invalidate();
        this.drafts.delete(rel);
        this.broadcast("activity", {});
        this.broadcast("saved", { path: rel, mtimeMs });
        return { ok: true, path: rel, mtimeMs, created: !st };
    }

    /** Hold unsaved editor text so /render can preview it in the vault theme. */
    saveDraft(body) {
        const rel = this.requirePath(body?.path);
        if (typeof body.text !== "string" || Buffer.byteLength(body.text, "utf8") > MAX_NOTE_BYTES) throw httpError(400, "Invalid draft");
        const id = randomBytes(9).toString("base64url");
        this.drafts.delete(rel);
        this.drafts.set(rel, { id, text: body.text });
        while (this.drafts.size > MAX_DRAFTS) this.drafts.delete(this.drafts.keys().next().value);
        return { id };
    }

    /** Hand a request to the agent in this session (shown as a normal user message). */
    async askCopilot(body) {
        if (!this.onAsk) throw httpError(503, "Copilot session is not available");
        const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt) throw httpError(400, "prompt is required");
        if (prompt.length > MAX_ASK_CHARS) throw httpError(413, "Prompt is too long");
        const messageId = await this.onAsk(prompt);
        return { ok: true, messageId: messageId ?? null };
    }

    // ── History import ──────────────────────────────────────────────────

    startImport() {
        if (this.importJob) return { started: false, running: true, progress: this.importJob.progress, promise: this.importJob.promise };
        // Only one session at a time scans the session logs; they all share the same database.
        const lock = tryLock(this.importLockFile);
        if (!lock.release) {
            const error = `A history import is already running in another Copilot session${lock.heldBy ? ` (pid ${lock.heldBy})` : ""}`;
            return { started: false, running: false, otherSession: true, error, promise: Promise.resolve({ error, otherSession: true }) };
        }
        const job = { progress: { done: 0, files: 0, calls: 0 }, startedAt: Date.now() };
        this.importJob = job;
        job.promise = (async () => {
            const { importHistory } = await import("./history.mjs");
            const store = await this.getStore();
            const stats = await importHistory(store, {
                onProgress: (p) => {
                    job.progress = p;
                    lock.touch();
                    this.broadcast("import", { running: true, ...p });
                },
            });
            const elapsedMs = Date.now() - job.startedAt;
            this.log(`oil-canvas: imported ${stats.calls} OIL calls from ${stats.scanned} session logs in ${elapsedMs} ms`);
            this.broadcast("import", { running: false, ...stats, elapsedMs });
            this.broadcast("activity", {});
            return { ...stats, elapsedMs };
        })()
            .catch((err) => {
                this.log(`oil-canvas: history import failed: ${err.message}`, { level: "error" });
                this.broadcast("import", { running: false, error: err.message });
                return { error: err.message };
            })
            .finally(() => {
                lock.release();
                this.importJob = null;
            });
        return { started: true, running: true, promise: job.promise };
    }

    // ── Openers ─────────────────────────────────────────────────────────

    openInObsidian(path) {
        const vault = this.vaultPath();
        if (vault && !path) {
            openExternal(`obsidian://open?path=${encodeURIComponent(vault)}`);
            return { opened: true };
        }
        const rel = normalizeNotePath(path);
        const abs = vault && rel ? resolveInVault(vault, rel) : null;
        if (!abs) throw httpError(400, "Invalid note path");
        openExternal(`obsidian://open?path=${encodeURIComponent(abs)}`);
        return { opened: true };
    }

    openUrl(raw) {
        let u;
        try {
            u = new URL(String(raw));
        } catch {
            throw httpError(400, "Invalid URL");
        }
        if (!["http:", "https:", "mailto:"].includes(u.protocol)) throw httpError(400, "Only http(s) and mailto links can be opened");
        openExternal(u.href);
        return { opened: true };
    }

    // ── SSE & plumbing ──────────────────────────────────────────────────

    events(req, res) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.write(`event: hello\ndata: ${JSON.stringify({ sessionId: this.sessionId })}\n\n`);
        this.clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        ping.unref();
        req.on("close", () => {
            clearInterval(ping);
            this.clients.delete(res);
        });
    }

    async body(req, max = MAX_BODY_BYTES) {
        let size = 0;
        const chunks = [];
        for await (const c of req) {
            size += c.length;
            if (size > max) throw httpError(413, "Request body too large");
            chunks.push(c);
        }
        if (!/application\/json/.test(req.headers["content-type"] || "")) throw httpError(415, "Expected application/json");
        try {
            return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
            throw httpError(400, "Invalid JSON");
        }
    }

    json(res, data) {
        return this.send(res, 200, "application/json; charset=utf-8", JSON.stringify(data));
    }

    send(res, status, type, body, { csp = false, headers = {} } = {}) {
        if (res.headersSent) return;
        res.writeHead(status, {
            "Content-Type": type,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            ...(csp
                ? {
                      "Content-Security-Policy":
                          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'",
                  }
                : {}),
            ...headers,
        });
        res.end(body);
    }

    fail(res, err) {
        const status = err.status || 500;
        if (status >= 500) this.log(`oil-canvas: ${err.stack || err.message}`, { level: "error" });
        this.send(res, status, "application/json; charset=utf-8", JSON.stringify({ error: err.message, ...(err.extra || {}) }));
    }
}

function httpError(status, message) {
    return Object.assign(new Error(message), { status });
}

/** Hand a URI to the OS default handler without a shell. */
function openExternal(uri) {
    const [cmd, argv] =
        platform() === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", uri]] : platform() === "darwin" ? ["open", [uri]] : ["xdg-open", [uri]];
    const child = spawn(cmd, argv, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
}
