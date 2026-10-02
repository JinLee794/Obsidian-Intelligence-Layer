import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const MAX_FILES = 60_000;
const MAX_PARSE_BYTES = 2 * 1024 * 1024;
const REFRESH_MS = 4_000;
const DAY_MS = 86_400_000;
const STALE_DAYS = 180;
const SKIP_DIRS = new Set([".obsidian", ".git", ".trash", "node_modules", ".smart-connections", ".oil"]);
const ATTACHMENT_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif|pdf|mp3|mp4|webm|mov|wav|m4a|ogg|canvas|excalidraw)$/i;

/**
 * Incremental index of a vault's notes: links, backlinks, tags, headings and
 * frontmatter. Only files whose size or mtime changed are re-parsed.
 */
export class VaultGraph {
    constructor(vault) {
        this.vault = vault;
        this.files = new Map(); // rel → { size, mtimeMs, md, note }
        this.folders = [];
        this.checkedAt = 0;
        this.version = 0;
        this.derived = null;
        this.truncated = false;
    }

    invalidate() {
        this.checkedAt = 0;
    }

    refresh(force = false) {
        if (!force && Date.now() - this.checkedAt < REFRESH_MS && this.derived) return this;
        const seen = new Set();
        const folders = [];
        let changed = false;
        let count = 0;
        this.truncated = false;
        const walk = (dir) => {
            let entries;
            try {
                entries = readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const e of entries) {
                if (count >= MAX_FILES) {
                    this.truncated = true;
                    return;
                }
                const abs = join(dir, e.name);
                if (e.isDirectory()) {
                    if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
                    folders.push(toRel(this.vault, abs));
                    walk(abs);
                } else if (e.isFile()) {
                    count++;
                    const rel = toRel(this.vault, abs);
                    seen.add(rel);
                    let st;
                    try {
                        st = statSync(abs);
                    } catch {
                        continue;
                    }
                    const prev = this.files.get(rel);
                    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
                    changed = true;
                    const md = /\.md$/i.test(e.name);
                    let note = null;
                    if (md && st.size <= MAX_PARSE_BYTES) {
                        try {
                            note = parseNote(readFileSync(abs, "utf8"));
                        } catch {}
                    }
                    this.files.set(rel, { size: st.size, mtimeMs: st.mtimeMs, md, note });
                }
            }
        };
        walk(this.vault);
        for (const rel of this.files.keys()) {
            if (!seen.has(rel)) {
                this.files.delete(rel);
                changed = true;
            }
        }
        this.folders = folders.sort();
        this.checkedAt = Date.now();
        if (changed || !this.derived) {
            this.version++;
            this.derive();
        }
        return this;
    }

    /** Resolve every link once, then build the backlink map. */
    derive() {
        const byPath = new Map();
        const byName = new Map();
        for (const rel of this.files.keys()) {
            byPath.set(rel.toLowerCase(), rel);
            const name = rel.split("/").pop().toLowerCase();
            if (!byName.has(name)) byName.set(name, []);
            byName.get(name).push(rel);
        }
        const index = { byPath, byName };
        const out = new Map(); // rel → Map(target rel → {count, embed})
        const unresolved = new Map(); // rel → Map(raw target → count)
        const back = new Map(); // target rel → Map(source rel → {count, snippets})
        for (const [rel, f] of this.files) {
            if (!f.note) continue;
            const o = new Map();
            const u = new Map();
            for (const l of f.note.links) {
                const to = resolveLink(index, l.target, rel);
                if (!to) {
                    u.set(l.target, (u.get(l.target) || 0) + 1);
                    continue;
                }
                const prev = o.get(to) || { count: 0, embed: false };
                prev.count++;
                prev.embed ||= l.embed;
                o.set(to, prev);
                if (to === rel) continue;
                if (!back.has(to)) back.set(to, new Map());
                const b = back.get(to).get(rel) || { count: 0, snippets: [] };
                b.count++;
                if (b.snippets.length < 3 && l.context && !b.snippets.includes(l.context)) b.snippets.push(l.context);
                back.get(to).set(rel, b);
            }
            out.set(rel, o);
            unresolved.set(rel, u);
        }
        this.derived = { index, out, unresolved, back };
    }

    get index() {
        return this.refresh().derived.index;
    }

    tree() {
        this.refresh();
        const files = [];
        for (const [path, f] of this.files) files.push({ path, size: f.size, mtimeMs: Math.round(f.mtimeMs), md: f.md });
        files.sort((a, b) => a.path.localeCompare(b.path));
        return { version: this.version, folders: this.folders, files, truncated: this.truncated };
    }

    linksFor(rel) {
        this.refresh();
        const f = this.files.get(rel);
        const { out, unresolved, back } = this.derived;
        const outgoing = [...(out.get(rel) || new Map())]
            .filter(([p]) => p !== rel)
            .map(([path, v]) => ({ path, count: v.count, embed: v.embed, md: /\.md$/i.test(path) }))
            .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
        const backlinks = [...(back.get(rel) || new Map())]
            .map(([path, v]) => ({ path, count: v.count, snippets: v.snippets }))
            .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
        const missing = [...(unresolved.get(rel) || new Map())].map(([target, count]) => ({ target, count }));
        return {
            path: rel,
            exists: Boolean(f),
            outgoing,
            backlinks,
            unresolved: missing,
            tags: f?.note?.tags || [],
            headings: f?.note?.headings || [],
            properties: f?.note?.fmKeys || [],
            words: f?.note?.words ?? 0,
            tasks: f?.note ? { open: f.note.tasksOpen, done: f.note.tasksDone } : null,
            mtimeMs: f ? Math.round(f.mtimeMs) : null,
            related: this.related(rel, outgoing, backlinks),
        };
    }

    /** Notes carrying `tag` or one of its nested children (`#a` matches `#a/b`). */
    tagged(tag, limit = 500) {
        this.refresh();
        const want = String(tag || "").replace(/^#/, "").toLowerCase();
        if (!want) return { tag: "", notes: [], total: 0 };
        const notes = [];
        for (const [path, f] of this.files) {
            const hit = f.note?.tags?.find((t) => {
                const l = t.toLowerCase();
                return l === want || l.startsWith(`${want}/`);
            });
            if (hit) notes.push({ path, tag: hit, mtimeMs: Math.round(f.mtimeMs) });
        }
        notes.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return { tag: want, total: notes.length, notes: notes.slice(0, limit) };
    }

    /** Notes that aren't directly linked but share links, backlinks or tags with this one. */
    related(rel, outgoing, backlinks) {
        const { out, back } = this.derived;
        const direct = new Set([rel, ...outgoing.map((o) => o.path), ...backlinks.map((b) => b.path)]);
        const scores = new Map();
        const bump = (p, s, why) => {
            if (direct.has(p) || !/\.md$/i.test(p)) return;
            const r = scores.get(p) || { path: p, score: 0, reasons: new Set() };
            r.score += s;
            r.reasons.add(why);
            scores.set(p, r);
        };
        // Co-citation: other notes linking to the same targets.
        for (const o of outgoing) for (const [src] of back.get(o.path) || []) bump(src, 2, "links to the same notes");
        // Two hops away through a backlink or an outgoing link.
        for (const b of backlinks) for (const [p] of out.get(b.path) || []) bump(p, 1, "linked from the same notes");
        for (const o of outgoing) for (const [p] of out.get(o.path) || []) bump(p, 1, "two links away");
        const tags = new Set(this.files.get(rel)?.note?.tags || []);
        if (tags.size) {
            for (const [p, f] of this.files) {
                if (!f.note?.tags?.length) continue;
                const shared = f.note.tags.filter((t) => tags.has(t)).length;
                if (shared) bump(p, shared * 1.5, "shares tags");
            }
        }
        return [...scores.values()]
            .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
            .slice(0, 15)
            .map((r) => ({ path: r.path, score: Math.round(r.score * 10) / 10, reasons: [...r.reasons] }));
    }

    /** Nodes and edges within `depth` hops, for the local graph. */
    localGraph(rel, depth = 1, maxNodes = 80) {
        this.refresh();
        const { out, back, unresolved } = this.derived;
        const nodes = new Map();
        const edges = new Map();
        const addNode = (id, hop, kind) => {
            if (!nodes.has(id)) nodes.set(id, { id, hop, kind, label: id.split("/").pop().replace(/\.md$/i, "") });
            return nodes.get(id);
        };
        const addEdge = (a, b) => {
            const k = `${a}\u0000${b}`;
            if (!edges.has(k)) edges.set(k, { source: a, target: b });
        };
        addNode(rel, 0, "center");
        let frontier = [rel];
        for (let hop = 1; hop <= depth && nodes.size < maxNodes; hop++) {
            const next = [];
            for (const p of frontier) {
                for (const [to] of out.get(p) || []) {
                    if (to === p) continue;
                    if (!nodes.has(to) && nodes.size >= maxNodes) continue;
                    if (!nodes.has(to)) next.push(to);
                    addNode(to, hop, /\.md$/i.test(to) ? "note" : "attachment");
                    addEdge(p, to);
                }
                for (const [from] of back.get(p) || []) {
                    if (!nodes.has(from) && nodes.size >= maxNodes) continue;
                    if (!nodes.has(from)) next.push(from);
                    addNode(from, hop, "note");
                    addEdge(from, p);
                }
                if (hop === 1) {
                    for (const [target] of unresolved.get(p) || []) {
                        if (nodes.size >= maxNodes) break;
                        const id = `?${target}`;
                        addNode(id, 1, "unresolved").label = target;
                        addEdge(p, id);
                    }
                }
            }
            frontier = next;
        }
        // Links among the collected neighbours make the graph feel like Obsidian's.
        for (const id of nodes.keys()) for (const [to] of out.get(id) || []) if (to !== id && nodes.has(to)) addEdge(id, to);
        return { center: rel, nodes: [...nodes.values()], edges: [...edges.values()] };
    }

    /** Vault-wide hygiene findings with a 0-100 health score. */
    hygiene({ now = Date.now(), limit = 200 } = {}) {
        this.refresh();
        const { out, unresolved, back } = this.derived;
        const notes = [...this.files].filter(([, f]) => f.md);
        const attachments = [...this.files].filter(([p, f]) => !f.md && ATTACHMENT_EXT.test(p));
        const linkedTargets = new Set();
        for (const o of out.values()) for (const p of o.keys()) linkedTargets.add(p);

        const brokenByTarget = new Map();
        const notesWithBroken = new Set();
        for (const [src, u] of unresolved) {
            for (const [target, count] of u) {
                notesWithBroken.add(src);
                const k = target.toLowerCase();
                const b = brokenByTarget.get(k) || { target, count: 0, sources: [] };
                b.count += count;
                if (!b.sources.includes(src)) b.sources.push(src);
                brokenByTarget.set(k, b);
            }
        }
        const byBase = new Map();
        for (const [p] of notes) {
            const base = p.split("/").pop().toLowerCase();
            if (!byBase.has(base)) byBase.set(base, []);
            byBase.get(base).push(p);
        }

        const orphans = [];
        const noBacklinks = [];
        const empty = [];
        const noFrontmatter = [];
        const untagged = [];
        const stale = [];
        const large = [];
        const tagCounts = new Map();
        let words = 0;
        let links = 0;
        let tasksOpen = 0;
        let tasksDone = 0;
        for (const [p, f] of notes) {
            const n = f.note;
            const outCount = [...(out.get(p) || new Map()).keys()].filter((x) => x !== p).length + (unresolved.get(p)?.size || 0);
            const inCount = back.get(p)?.size || 0;
            if (!outCount && !inCount) orphans.push({ path: p });
            else if (!inCount) noBacklinks.push({ path: p });
            if (!n) {
                large.push({ path: p, detail: `${Math.round(f.size / 1024)} KB` });
                continue;
            }
            words += n.words;
            links += n.links.length;
            tasksOpen += n.tasksOpen;
            tasksDone += n.tasksDone;
            for (const t of n.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
            if (n.words < 5) empty.push({ path: p, detail: n.words ? `${n.words} words` : "empty" });
            if (!n.hasFrontmatter) noFrontmatter.push({ path: p });
            if (!n.tags.length) untagged.push({ path: p });
            const ageDays = Math.floor((now - f.mtimeMs) / DAY_MS);
            if (ageDays > STALE_DAYS) stale.push({ path: p, detail: `${ageDays} days`, ageDays });
            if (n.words > 8000 || f.size > 256 * 1024) large.push({ path: p, detail: `${n.words.toLocaleString()} words` });
        }
        const duplicates = [...byBase.values()].filter((ps) => ps.length > 1).map((ps) => ({ name: ps[0].split("/").pop(), paths: ps.sort() }));
        const unusedAttachments = attachments.filter(([p]) => !linkedTargets.has(p)).map(([p, f]) => ({ path: p, detail: `${Math.max(1, Math.round(f.size / 1024))} KB`, size: f.size }));
        stale.sort((a, b) => b.ageDays - a.ageDays);
        const broken = [...brokenByTarget.values()].sort((a, b) => b.sources.length - a.sources.length || b.count - a.count);

        const N = Math.max(1, notes.length);
        // sqrt so a few problems in a large vault still register.
        const ratio = (n, d = N) => Math.sqrt(Math.min(1, n / Math.max(1, d)));
        const dupNotes = duplicates.reduce((s, d) => s + d.paths.length, 0);
        const weights = [
            ["broken", 30, ratio(notesWithBroken.size)],
            ["orphans", 18, ratio(orphans.length)],
            ["empty", 10, ratio(empty.length)],
            ["duplicates", 10, ratio(dupNotes)],
            ["noFrontmatter", 10, ratio(noFrontmatter.length)],
            ["unusedAttachments", 8, ratio(unusedAttachments.length, attachments.length)],
            ["untagged", 7, ratio(untagged.length)],
            ["stale", 7, ratio(stale.length)],
        ];
        const penalty = weights.reduce((s, [, w, r]) => s + w * r, 0);
        const cut = (arr) => ({ count: arr.length, items: arr.slice(0, limit) });
        return {
            scannedAt: new Date(now).toISOString(),
            score: Math.max(0, Math.round(100 - penalty)),
            penalties: Object.fromEntries(weights.map(([k, w, r]) => [k, Math.round(w * r * 10) / 10])),
            stats: {
                notes: notes.length,
                attachments: attachments.length,
                folders: this.folders.length,
                words,
                links,
                resolvedLinks: [...out.values()].reduce((s, o) => s + [...o.values()].reduce((a, v) => a + v.count, 0), 0),
                brokenLinks: broken.reduce((s, b) => s + b.count, 0),
                tags: tagCounts.size,
                tasksOpen,
                tasksDone,
                truncated: this.truncated,
            },
            topTags: [...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([tag, count]) => ({ tag, count })),
            issues: {
                broken: { count: broken.length, notes: notesWithBroken.size, items: broken.slice(0, limit) },
                orphans: cut(orphans),
                noBacklinks: cut(noBacklinks),
                empty: cut(empty),
                duplicates: cut(duplicates),
                noFrontmatter: cut(noFrontmatter),
                untagged: cut(untagged),
                stale: cut(stale),
                large: cut(large),
                unusedAttachments: cut(unusedAttachments),
            },
        };
    }
}

/** Resolve an Obsidian link target the way Obsidian does: exact path, relative path, then shortest path with that file name. */
export function resolveLink(index, target, fromPath) {
    if (!index || !target) return null;
    let t = String(target).trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!t) return null;
    const hasExt = /\.[a-z0-9]{1,5}$/i.test(t) && !/\.md$/i.test(t);
    const candidates = hasExt ? [t] : [/\.md$/i.test(t) ? t : `${t}.md`];
    const fromDir = fromPath && fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/") + 1) : "";
    for (const c of candidates) {
        const lower = c.toLowerCase();
        if (index.byPath.has(lower)) return index.byPath.get(lower);
        if (fromDir && index.byPath.has((fromDir + c).toLowerCase())) return index.byPath.get((fromDir + c).toLowerCase());
        const name = lower.split("/").pop();
        const matches = (index.byName.get(name) || []).filter((p) => p.toLowerCase().endsWith(lower));
        if (matches.length) return matches.sort((a, b) => a.length - b.length)[0];
    }
    return null;
}

// ── Parsing ─────────────────────────────────────────────────────────────

const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;
const MDLINK = /(!?)\[[^\]\n]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;
const TAG = /(^|[\s(,])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

/** Links, tags, headings, task counts and frontmatter facts for one note. */
export function parseNote(src) {
    let text = String(src).replace(/\r\n?/g, "\n");
    const fm = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
    const fmKeys = [];
    const tags = new Set();
    const links = [];
    if (fm) {
        text = text.slice(fm[0].length);
        let listKey = null;
        for (const line of fm[1].split("\n")) {
            const kv = /^([^\s:#][^:]*):\s*(.*)$/.exec(line);
            const item = /^\s+-\s+(.*)$/.exec(line);
            if (kv) {
                const key = kv[1].trim();
                fmKeys.push(key);
                listKey = key.toLowerCase();
                const v = kv[2].trim();
                if (listKey === "tags" || listKey === "tag") for (const t of splitList(v)) addTag(tags, t);
                for (const m of v.matchAll(WIKILINK)) links.push(linkFrom(m[2], false, `${key}: ${v}`));
            } else if (item && listKey) {
                if (listKey === "tags" || listKey === "tag") addTag(tags, unquote(item[1]));
                for (const m of item[1].matchAll(WIKILINK)) links.push(linkFrom(m[2], false, `${listKey}: ${item[1]}`));
            }
        }
    }
    text = text.replace(/%%[\s\S]*?%%/g, "");
    const headings = [];
    let words = 0;
    let tasksOpen = 0;
    let tasksDone = 0;
    let fence = null;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const f = /^\s*(`{3,}|~{3,})/.exec(raw);
        if (fence) {
            if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
            continue;
        }
        if (f) {
            fence = f[1];
            continue;
        }
        const line = raw.replace(/`[^`\n]*`/g, "");
        words += (line.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
        const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (h) headings.push({ level: h[1].length, text: h[2].replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2"), line: i });
        const task = /^\s*[-*+]\s+\[(.)\]/.exec(line);
        if (task) task[1] === " " ? tasksOpen++ : tasksDone++;
        if (line.includes("[[") || line.includes("](")) {
            const context = snippet(line);
            for (const m of line.matchAll(WIKILINK)) links.push(linkFrom(m[2], m[1] === "!", context));
            for (const m of line.matchAll(MDLINK)) {
                const url = m[2];
                if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#")) continue;
                let target;
                try {
                    target = decodeURIComponent(url.split("#")[0]);
                } catch {
                    target = url.split("#")[0];
                }
                if (target) links.push({ target, embed: m[1] === "!", context });
            }
        }
        if (!h && line.includes("#")) for (const m of line.matchAll(TAG)) addTag(tags, m[2]);
    }
    return { links: links.filter((l) => l.target), tags: [...tags], headings, words, tasksOpen, tasksDone, hasFrontmatter: Boolean(fm), fmKeys };
}

function linkFrom(inner, embed, context) {
    // Inside tables Obsidian escapes the alias pipe as `\|`.
    const target = inner.replace(/\\\|/g, "|").split("|")[0].split("#")[0].split("^")[0].trim();
    return { target, embed, context: typeof context === "string" ? snippet(context) : context };
}

function snippet(line) {
    const s = line.replace(/^\s*(?:[-*+]|\d+\.)\s+(\[.\]\s+)?/, "").replace(/^#+\s+/, "").trim();
    return s.length > 180 ? `${s.slice(0, 177)}…` : s;
}

function splitList(v) {
    if (!v) return [];
    return v.replace(/^\[|\]$/g, "").split(/[,\s]+/).map(unquote).filter(Boolean);
}

function addTag(set, t) {
    const tag = String(t).trim().replace(/^#/, "");
    if (tag && !/^\d+$/.test(tag)) set.add(tag);
}

function unquote(s) {
    return String(s).trim().replace(/^(["'])(.*)\1$/, "$2");
}

function toRel(root, abs) {
    return relative(root, abs).split(sep).join("/");
}
