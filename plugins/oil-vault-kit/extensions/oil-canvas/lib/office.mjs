import { readFileSync, statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { posix } from "node:path";

// Lightweight, dependency-free previews of Office Open XML files (pptx/docx/xlsx).
// Text, structure and embedded raster images only — no layout, fonts or charts.

export const MAX_OFFICE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 24 * 1024 * 1024;
const MAX_SLIDES = 300;
const MAX_BLOCKS = 5000;
const MAX_SHEETS = 20;
const MAX_ROWS = 200;
const MAX_COLS = 40;
export const OFFICE_IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml" };

// ── Zip ─────────────────────────────────────────────────────────────────

export class Zip {
    constructor(buf) {
        this.buf = buf;
        this.entries = new Map();
        const min = Math.max(0, buf.length - 65_557);
        let eocd = -1;
        for (let i = buf.length - 22; i >= min; i--) {
            if (buf.readUInt32LE(i) === 0x06054b50) {
                eocd = i;
                break;
            }
        }
        if (eocd < 0) throw new Error("Not a zip archive");
        const count = buf.readUInt16LE(eocd + 10);
        let p = buf.readUInt32LE(eocd + 16);
        for (let n = 0; n < count && p + 46 <= buf.length; n++) {
            if (buf.readUInt32LE(p) !== 0x02014b50) break;
            const method = buf.readUInt16LE(p + 10);
            const compSize = buf.readUInt32LE(p + 20);
            const size = buf.readUInt32LE(p + 24);
            const nameLen = buf.readUInt16LE(p + 28);
            const extraLen = buf.readUInt16LE(p + 30);
            const commentLen = buf.readUInt16LE(p + 32);
            const local = buf.readUInt32LE(p + 42);
            const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
            this.entries.set(name, { method, compSize, size, local });
            p += 46 + nameLen + extraLen + commentLen;
        }
    }

    has(name) {
        return this.entries.has(name);
    }

    read(name) {
        const e = this.entries.get(name);
        if (!e) return null;
        if (e.size > MAX_ENTRY_BYTES) throw new Error(`${name} is too large to preview`);
        const b = this.buf;
        if (b.readUInt32LE(e.local) !== 0x04034b50) throw new Error("Corrupt zip entry");
        const start = e.local + 30 + b.readUInt16LE(e.local + 26) + b.readUInt16LE(e.local + 28);
        const data = b.subarray(start, start + e.compSize);
        if (e.method === 0) return data;
        if (e.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
        throw new Error(`Unsupported zip compression (${e.method})`);
    }

    text(name) {
        const d = this.read(name);
        return d ? d.toString("utf8") : null;
    }
}

// ── XML helpers (regex-based; Office XML is machine-generated and regular) ──

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeXml(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) =>
        e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()],
    );
}

const attr = (tag, name) => {
    const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
    return m ? decodeXml(m[1]) : null;
};

/** Relationship id → { target, type } for a part, with targets resolved to zip entry names. */
function rels(zip, part) {
    const dir = posix.dirname(part);
    const xml = zip.text(`${dir === "." ? "" : `${dir}/`}_rels/${posix.basename(part)}.rels`);
    const out = new Map();
    if (!xml) return out;
    for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
        const id = attr(m[0], "Id");
        const target = attr(m[0], "Target");
        if (!id || !target || attr(m[0], "TargetMode") === "External") continue;
        const resolved = target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join(dir, target));
        out.set(id, { target: resolved, type: (attr(m[0], "Type") || "").split("/").pop() });
    }
    return out;
}

function coreMeta(zip) {
    const xml = zip.text("docProps/core.xml") || "";
    const get = (tag) => {
        const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
        return m ? decodeXml(m[1]).trim() || null : null;
    };
    return { title: get("dc:title"), author: get("dc:creator"), modifiedBy: get("cp:lastModifiedBy"), modified: get("dcterms:modified") };
}

const imageFor = (rel) => {
    if (!rel || rel.type !== "image") return null;
    const ext = posix.extname(rel.target).slice(1).toLowerCase();
    return OFFICE_IMAGE_TYPES[ext] ? rel.target : null;
};

// DrawingML paragraphs (pptx shapes, tables, notes).
function drawingParagraphs(xml) {
    const out = [];
    for (const m of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p\s[^>]*>([\s\S]*?)<\/a:p>/g)) {
        const body = m[1] ?? m[2];
        const text = decodeXml(
            [...body.matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:br\/>/g)].map((t) => (t[0] === "<a:br/>" ? "\n" : t[1])).join(""),
        );
        if (!text.trim()) continue;
        const ppr = /<a:pPr\b[^>]*>/.exec(body);
        const lvl = ppr ? Number(attr(ppr[0], "lvl")) || 0 : 0;
        out.push({ text, level: lvl });
    }
    return out;
}

// ── PowerPoint ──────────────────────────────────────────────────────────

function pptx(zip) {
    const pres = zip.text("ppt/presentation.xml") || "";
    const presRels = rels(zip, "ppt/presentation.xml");
    let order = [...pres.matchAll(/<p:sldId\b[^>]*>/g)].map((m) => presRels.get(attr(m[0], "r:id"))?.target).filter((t) => t && zip.has(t));
    if (!order.length) {
        order = [...zip.entries.keys()]
            .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
            .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
    }
    const total = order.length;
    const slides = order.slice(0, MAX_SLIDES).map((part, i) => {
        const xml = zip.text(part) || "";
        const r = rels(zip, part);
        let title = null;
        const body = [];
        for (const m of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>|<p:sp\s[\s\S]*?<\/p:sp>|<a:tbl>[\s\S]*?<\/a:tbl>/g)) {
            const block = m[0];
            if (block.startsWith("<a:tbl")) {
                const rows = [...block.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)].map((tr) =>
                    [...tr[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((tc) => drawingParagraphs(tc[0]).map((p) => p.text).join("\n")),
                );
                if (rows.length) body.push({ type: "table", rows });
                continue;
            }
            const ph = /<p:ph\b[^>]*>/.exec(block);
            const phType = ph ? attr(ph[0], "type") : null;
            if (phType === "sldNum" || phType === "dt" || phType === "ftr") continue;
            const paras = drawingParagraphs(block);
            if (!paras.length) continue;
            if (!title && (phType === "title" || phType === "ctrTitle")) title = paras.map((p) => p.text).join(" ");
            else body.push({ type: "paragraphs", items: paras, subtitle: phType === "subTitle" });
        }
        const images = [];
        for (const m of xml.matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/g)) {
            const img = imageFor(r.get(m[1]));
            if (img && !images.includes(img)) images.push(img);
        }
        let notes = null;
        for (const rel of r.values()) {
            if (rel.type !== "notesSlide") continue;
            const nx = zip.text(rel.target) || "";
            const parts = [];
            for (const m of nx.matchAll(/<p:sp>[\s\S]*?<\/p:sp>|<p:sp\s[\s\S]*?<\/p:sp>/g)) {
                const ph = /<p:ph\b[^>]*>/.exec(m[0]);
                if (ph && attr(ph[0], "type") === "body") parts.push(...drawingParagraphs(m[0]).map((p) => p.text));
            }
            notes = parts.join("\n") || null;
        }
        const hidden = /<p:sld\b[^>]*\sshow="0"/.test(xml);
        return { index: i + 1, title, body, images, notes, hidden };
    });
    return { kind: "pptx", meta: coreMeta(zip), total, truncated: total > slides.length, slides };
}

// ── Word ────────────────────────────────────────────────────────────────

/** Style IDs whose definition carries numbering (e.g. "ListBullet"), so paragraphs inherit list-ness. */
function listStyles(zip) {
    const ids = new Set();
    const xml = zip.text("word/styles.xml") || "";
    for (const m of xml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
        if (/<w:numPr>/.test(m[2])) ids.add(attr(` ${m[1]}`, "w:styleId"));
    }
    return ids;
}

function wordParagraph(xml, r, lists = new Set()) {
    const text = decodeXml(
        [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:br\s[^>]*\/>/g)]
            .map((t) => (t[1] != null ? t[1] : t[0].startsWith("<w:tab") ? "\t" : "\n"))
            .join(""),
    );
    const style = (/<w:pStyle\s[^>]*w:val="([^"]+)"/.exec(xml) || [])[1] || "";
    const images = [];
    for (const m of xml.matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/g)) {
        const img = imageFor(r.get(m[1]));
        if (img) images.push(img);
    }
    const heading = /^title$/i.test(style) ? 1 : Number((/^heading\s*(\d)$/i.exec(style) || [])[1]) || 0;
    const list = /<w:numPr>/.test(xml) || lists.has(style) ? Number((/<w:ilvl\s[^>]*w:val="(\d+)"/.exec(xml) || [])[1]) || 0 : null;
    return { text, heading: heading ? Math.min(heading + (/^title$/i.test(style) ? 0 : 1), 6) : 0, list, quote: /quote/i.test(style), images };
}

function docx(zip) {
    const xml = zip.text("word/document.xml");
    if (!xml) throw new Error("Not a Word document");
    const r = rels(zip, "word/document.xml");
    const body = (/<w:body>([\s\S]*)<\/w:body>/.exec(xml) || [, xml])[1];
    const lists = listStyles(zip);
    const blocks = [];
    let total = 0;
    for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
        const b = m[0];
        if (b.endsWith("/>") && !b.includes("</w:p>")) continue;
        total++;
        if (blocks.length >= MAX_BLOCKS) continue;
        if (b.startsWith("<w:tbl")) {
            const rows = [...b.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((tr) =>
                [...tr[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((tc) =>
                    [...tc[0].matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((p) => wordParagraph(p[0], r).text).join("\n"),
                ),
            );
            if (rows.length) blocks.push({ type: "table", rows });
            continue;
        }
        const p = wordParagraph(b, r, lists);
        if (!p.text.trim() && !p.images.length) continue;
        blocks.push({ type: "p", ...p });
    }
    return { kind: "docx", meta: coreMeta(zip), total, truncated: total > MAX_BLOCKS, blocks };
}

// ── Excel ───────────────────────────────────────────────────────────────

function colIndex(ref) {
    const letters = /^[A-Z]+/.exec(ref)?.[0] || "A";
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

function xlsx(zip) {
    const wb = zip.text("xl/workbook.xml");
    if (!wb) throw new Error("Not an Excel workbook");
    const r = rels(zip, "xl/workbook.xml");
    const strings = [];
    const ss = zip.text("xl/sharedStrings.xml") || "";
    for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) strings.push(decodeXml([...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
    const all = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: attr(m[0], "name"), part: r.get(attr(m[0], "r:id"))?.target, hidden: /^(hidden|veryHidden)$/.test(attr(m[0], "state") || "") }));
    const sheets = all.slice(0, MAX_SHEETS).map((s) => {
        const xml = (s.part && zip.text(s.part)) || "";
        const rows = [];
        let totalRows = 0;
        let maxCol = 0;
        for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
            totalRows++;
            if (rows.length >= MAX_ROWS || row[1] == null) continue;
            const cells = [];
            for (const c of row[1].matchAll(/<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
                if (c[3] == null) continue;
                const a = ` ${c[2]}`;
                const col = colIndex(attr(a, "r") || "");
                if (col >= MAX_COLS) continue;
                const t = attr(a, "t");
                const v = /<v>([\s\S]*?)<\/v>/.exec(c[3])?.[1];
                let val;
                if (t === "s") val = strings[Number(v)] ?? "";
                else if (t === "inlineStr") val = decodeXml([...c[3].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""));
                else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
                else if (v) val = decodeXml(v);
                else {
                    // Formula with no cached result (file saved by a library, never recalculated).
                    const f = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(c[3])?.[1];
                    val = f ? `=${decodeXml(f)}` : "";
                }
                cells[col] = val;
                maxCol = Math.max(maxCol, col + 1);
            }
            rows.push({ r: Number(attr(` ${row[0].slice(4)}`, "r")) || rows.length + 1, cells });
        }
        return { name: s.name, hidden: s.hidden, totalRows, cols: maxCol, rows: rows.map((x) => ({ r: x.r, cells: Array.from({ length: maxCol }, (_, i) => x.cells[i] ?? "") })) };
    });
    return { kind: "xlsx", meta: coreMeta(zip), totalSheets: all.length, truncated: all.length > sheets.length, maxRows: MAX_ROWS, sheets };
}

// ── Entry points ────────────────────────────────────────────────────────

function openZip(abs) {
    const st = statSync(abs);
    if (st.size > MAX_OFFICE_BYTES) throw Object.assign(new Error("File is too large to preview"), { status: 413 });
    const buf = readFileSync(abs);
    // OLE/CFB container: sensitivity-label / IRM encrypted OOXML (or legacy binary Office).
    if (buf.length >= 8 && buf.readUInt32LE(0) === 0xe011cfd0 && buf.readUInt32LE(4) === 0xe11ab1a1) {
        throw Object.assign(new Error("This file is protected (sensitivity label / IRM encryption) — open it in Office to view"), { status: 422, code: "protected" });
    }
    return new Zip(buf);
}

/** Structured preview of a .pptx/.docx/.xlsx (and macro/template variants). */
export function readOffice(abs) {
    const ext = posix.extname(abs.replace(/\\/g, "/")).toLowerCase();
    const zip = openZip(abs);
    if (/^\.(pptx|pptm|potx|ppsx)$/.test(ext)) return pptx(zip);
    if (/^\.(docx|docm|dotx)$/.test(ext)) return docx(zip);
    if (/^\.(xlsx|xlsm|xltx)$/.test(ext)) return xlsx(zip);
    throw Object.assign(new Error("Unsupported Office format"), { status: 415 });
}

/** Raw bytes and MIME type of an embedded image, or null. */
export function readOfficeMedia(abs, entry) {
    if (typeof entry !== "string" || !/^(ppt|word|xl)\/media\/[^/]+$/.test(entry)) return null;
    const type = OFFICE_IMAGE_TYPES[posix.extname(entry).slice(1).toLowerCase()];
    if (!type) return null;
    const data = openZip(abs).read(entry);
    return data ? { type, data } : null;
}
