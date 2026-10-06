/**
 * Minimal Obsidian-flavoured Markdown → HTML renderer.
 *
 * Emits the same class names Obsidian's reading view uses (internal-link, tag,
 * callout, task-list-item, …) so vault themes and CSS snippets style it. Raw
 * HTML in notes is always escaped: note content is untrusted.
 */

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;

export function renderMarkdown(src, opts = {}) {
    const ctx = {
        resolve: opts.resolve || (() => null),
        assetUrl: opts.assetUrl || (() => null),
        slugs: new Map(),
    };
    let text = String(src ?? "").replace(/\r\n?/g, "\n");
    let frontmatter = null;
    const fm = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
    if (fm) {
        frontmatter = parseFrontmatter(fm[1]);
        text = text.slice(fm[0].length);
    }
    text = text.replace(/%%[\s\S]*?%%/g, "");
    const body = renderBlocks(text.split("\n"), ctx);
    return { html: (frontmatter ? renderProperties(frontmatter, ctx) : "") + body, frontmatter };
}

// ── Frontmatter ─────────────────────────────────────────────────────────

function parseFrontmatter(yaml) {
    const out = [];
    let current = null;
    for (const line of yaml.split("\n")) {
        const item = /^\s+-\s+(.*)$/.exec(line);
        if (item && current) {
            if (!Array.isArray(current.value)) current.value = current.value ? [current.value] : [];
            current.value.push(unquote(item[1]));
            continue;
        }
        const kv = /^([^\s:#][^:]*):\s*(.*)$/.exec(line);
        if (kv) {
            let value = kv[2].trim();
            if (/^\[.*\]$/.test(value)) value = value.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
            else value = unquote(value);
            current = { key: kv[1].trim(), value };
            out.push(current);
        }
    }
    return out;
}

function unquote(s) {
    return s.replace(/^(["'])(.*)\1$/, "$2");
}

function renderProperties(props, ctx) {
    if (!props.length) return "";
    const rows = props
        .map(({ key, value }) => {
            const values = Array.isArray(value) ? value : [value];
            const cells = values
                .filter((v) => v !== "")
                .map((v) => `<span class="multi-select-pill">${inline(String(v), ctx)}</span>`)
                .join(" ");
            return `<div class="metadata-property" data-property-key="${esc(key)}"><div class="metadata-property-key">${esc(key)}</div><div class="metadata-property-value">${cells}</div></div>`;
        })
        .join("");
    return `<div class="metadata-container"><div class="metadata-properties-heading">Properties</div><div class="metadata-content">${rows}</div></div>`;
}

// ── Blocks ──────────────────────────────────────────────────────────────

const RE = {
    fence: /^(\s*)(```+|~~~+)\s*([\w+#-]*)/,
    heading: /^(#{1,6})\s+(.*?)\s*#*\s*$/,
    hr: /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,
    quote: /^\s{0,3}>/,
    list: /^(\s*)([-*+]|\d+[.)])\s+(.*)$/,
    tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
    math: /^\s*\$\$/,
};

function isBlockStart(line, next) {
    return (
        RE.fence.test(line) ||
        RE.heading.test(line) ||
        RE.hr.test(line) ||
        RE.quote.test(line) ||
        RE.list.test(line) ||
        RE.math.test(line) ||
        (line.includes("|") && next !== undefined && RE.tableSep.test(next))
    );
}

function renderBlocks(lines, ctx) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
            i++;
            continue;
        }

        let m;
        if ((m = RE.fence.exec(line))) {
            const fence = m[2];
            const lang = m[3];
            const body = [];
            i++;
            while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
            i++;
            const cls = lang ? ` class="language-${esc(lang)}"` : "";
            out.push(`<pre${cls}><code${cls}>${esc(body.join("\n"))}</code></pre>`);
            continue;
        }
        if (RE.math.test(line)) {
            const body = [line.replace(/^\s*\$\$/, "")];
            i++;
            if (!/\$\$\s*$/.test(line.trim().slice(2))) {
                while (i < lines.length && !/\$\$\s*$/.test(lines[i])) body.push(lines[i++]);
                if (i < lines.length) body.push(lines[i++].replace(/\$\$\s*$/, ""));
            }
            out.push(`<div class="math math-block"><pre><code>${esc(body.join("\n").replace(/\$\$\s*$/, "").trim())}</code></pre></div>`);
            continue;
        }
        if ((m = RE.heading.exec(line))) {
            const level = m[1].length;
            const id = slug(m[2], ctx);
            out.push(`<h${level} data-heading="${esc(m[2])}" id="${id}">${inline(m[2], ctx)}</h${level}>`);
            i++;
            continue;
        }
        if (RE.hr.test(line)) {
            out.push("<hr>");
            i++;
            continue;
        }
        if (RE.quote.test(line)) {
            const body = [];
            while (i < lines.length && RE.quote.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
            out.push(renderQuote(body, ctx));
            continue;
        }
        if (line.includes("|") && i + 1 < lines.length && RE.tableSep.test(lines[i + 1])) {
            const rows = [line];
            const sep = lines[i + 1];
            i += 2;
            while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(lines[i++]);
            out.push(renderTable(rows, sep, ctx));
            continue;
        }
        if (RE.list.test(line)) {
            const block = [];
            while (i < lines.length) {
                const l = lines[i];
                if (!l.trim()) {
                    const next = lines[i + 1];
                    if (next !== undefined && (RE.list.test(next) || /^\s{2,}\S/.test(next))) {
                        i++;
                        continue;
                    }
                    break;
                }
                if (block.length && !RE.list.test(l) && !/^\s+\S/.test(l) && isBlockStart(l, lines[i + 1])) break;
                block.push(l);
                i++;
            }
            out.push(renderList(block, ctx));
            continue;
        }

        const para = [line];
        i++;
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) para.push(lines[i++]);
        out.push(`<p>${para.map((l) => inline(l, ctx)).join("<br>")}</p>`);
    }
    return out.join("\n");
}

function renderQuote(body, ctx) {
    const callout = /^\[!([\w-]+)\]([+-]?)\s*(.*)$/.exec(body[0] || "");
    if (!callout) return `<blockquote>${renderBlocks(body, ctx)}</blockquote>`;
    const type = callout[1].toLowerCase();
    const title = callout[3] || type.charAt(0).toUpperCase() + type.slice(1);
    const fold = callout[2];
    const content = renderBlocks(body.slice(1), ctx);
    return (
        `<div class="callout${fold ? " is-collapsible" : ""}${fold === "-" ? " is-collapsed" : ""}" data-callout="${esc(type)}"${fold ? ` data-callout-fold="${fold}"` : ""}>` +
        `<div class="callout-title"><div class="callout-title-inner">${inline(title, ctx)}</div></div>` +
        (content ? `<div class="callout-content"${fold === "-" ? ' style="display:none"' : ""}>${content}</div>` : "") +
        `</div>`
    );
}

function splitRow(row) {
    let r = row.trim();
    if (r.startsWith("|")) r = r.slice(1);
    if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
    const cells = [];
    let cur = "";
    let inWiki = 0;
    for (let i = 0; i < r.length; i++) {
        const c = r[i];
        if (c === "[" && r[i + 1] === "[") inWiki++;
        if (c === "]" && r[i + 1] === "]" && inWiki) inWiki--;
        if (c === "\\" && r[i + 1] === "|") {
            cur += "|";
            i++;
            continue;
        }
        if (c === "|" && !inWiki) {
            cells.push(cur.trim());
            cur = "";
            continue;
        }
        cur += c;
    }
    cells.push(cur.trim());
    return cells;
}

function renderTable(rows, sep, ctx) {
    const aligns = splitRow(sep).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
    const cell = (tag, text, idx) => `<${tag}${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ""}>${inline(text, ctx)}</${tag}>`;
    const head = splitRow(rows[0]).map((c, i) => cell("th", c, i)).join("");
    const body = rows
        .slice(1)
        .map((r) => `<tr>${splitRow(r).map((c, i) => cell("td", c, i)).join("")}</tr>`)
        .join("");
    return `<div class="table-wrapper"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderList(lines, ctx) {
    const items = [];
    for (const l of lines) {
        const m = RE.list.exec(l);
        if (m) {
            items.push({ indent: m[1].replace(/\t/g, "    ").length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] });
        } else if (items.length) {
            items[items.length - 1].text += "\n" + l.trim();
        }
    }
    let idx = 0;
    const build = (indent) => {
        const first = items[idx];
        const tag = first.ordered ? "ol" : "ul";
        const startAttr = first.ordered && first.start > 1 ? ` start="${first.start}"` : "";
        let html = `<${tag}${startAttr}${tag === "ul" ? "" : ""}>`;
        while (idx < items.length && items[idx].indent >= indent) {
            const it = items[idx];
            if (it.indent > indent) {
                html = html.replace(/<\/li>$/, "") + build(it.indent) + "</li>";
                continue;
            }
            idx++;
            const task = /^\[([ xX\/-])\]\s+(.*)$/s.exec(it.text);
            const content = (task ? task[2] : it.text).split("\n").map((t) => inline(t, ctx)).join("<br>");
            if (task) {
                const checked = task[1] !== " ";
                html += `<li class="task-list-item${checked ? " is-checked" : ""}" data-task="${esc(task[1])}"><input type="checkbox" class="task-list-item-checkbox" disabled${checked ? " checked" : ""}> ${content}</li>`;
            } else {
                html += `<li>${content}</li>`;
            }
        }
        return html + `</${tag}>`;
    };
    let html = "";
    while (idx < items.length) html += build(items[idx].indent);
    return html;
}

// ── Inline ──────────────────────────────────────────────────────────────

function inline(text, ctx) {
    const slots = [];
    const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;

    let s = String(text);
    s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(`<code>${esc(code.trim())}</code>`));
    s = s.replace(/\$([^$\s](?:[^$]*[^$\s])?)\$/g, (_, m) => hold(`<span class="math math-inline"><code>${esc(m)}</code></span>`));
    s = s.replace(/(!?)\[\[([^\]\n]+?)\]\]/g, (_, bang, inner) => hold(wikilink(inner, bang === "!", ctx)));
    s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => hold(image(alt, url, ctx)));
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => hold(mdLink(label, url, ctx)));
    s = s.replace(/\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g, (url) => hold(`<a class="external-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`));

    s = esc(s);
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/g, "$1<em>$2</em>");
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
    s = s.replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark class="cm-highlight">$1</mark>');
    s = s.replace(/(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu, (_, pre, tag) =>
        /^\d+$/.test(tag) ? `${pre}#${tag}` : `${pre}<a class="tag" href="#" data-tag="${tag}">#${tag}</a>`,
    );
    return s.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)]);
}

function wikilink(inner, embed, ctx) {
    const [targetPart, alias] = splitOnce(inner.replace(/\\\|/g, "|"), "|");
    const [file, sub] = splitOnce(targetPart, "#");
    const resolved = file ? ctx.resolve(file.trim()) : null;
    if (embed && IMAGE_EXT.test(file)) {
        const url = resolved ? ctx.assetUrl(resolved) : null;
        const width = alias && /^\d+(x\d+)?$/.test(alias) ? ` width="${alias.split("x")[0]}"` : "";
        return url
            ? `<span class="internal-embed image-embed"><img src="${esc(url)}" alt="${esc(file)}"${width}></span>`
            : `<span class="internal-embed is-unresolved">${esc(file)}</span>`;
    }
    const label = alias && !embed ? alias : sub ? `${file}${file ? " › " : ""}${sub.replace(/^\^/, "")}` : file;
    const cls = `internal-link${resolved || !file ? "" : " is-unresolved"}${embed ? " internal-embed" : ""}`;
    return `<a class="${cls}" href="#" data-href="${esc(targetPart.trim())}"${resolved ? ` data-path="${esc(resolved)}"` : ""}>${esc(label.trim())}</a>`;
}

function image(alt, url, ctx) {
    if (/^https:\/\//i.test(url)) return `<img src="${esc(url)}" alt="${esc(alt)}" referrerpolicy="no-referrer">`;
    const resolved = ctx.resolve(decodeURI(url));
    const local = resolved ? ctx.assetUrl(resolved) : null;
    return local ? `<img src="${esc(local)}" alt="${esc(alt)}">` : `<span class="is-unresolved">${esc(alt || url)}</span>`;
}

function mdLink(label, url, ctx) {
    if (/^(https?:|mailto:)/i.test(url)) {
        return `<a class="external-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${inline(label, ctx)}</a>`;
    }
    if (/^obsidian:/i.test(url)) return `<a class="external-link" href="${esc(url)}">${inline(label, ctx)}</a>`;
    let target = url;
    try {
        target = decodeURI(url);
    } catch {}
    const [file] = splitOnce(target, "#");
    const resolved = file ? ctx.resolve(file) : null;
    return `<a class="internal-link${resolved ? "" : " is-unresolved"}" href="#" data-href="${esc(target)}"${resolved ? ` data-path="${esc(resolved)}"` : ""}>${inline(label, ctx)}</a>`;
}

function splitOnce(s, ch) {
    const i = s.indexOf(ch);
    return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
}

function slug(text, ctx) {
    const base =
        String(text)
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s-]/gu, "")
            .trim()
            .replace(/\s+/g, "-") || "section";
    const n = ctx.slugs.get(base) || 0;
    ctx.slugs.set(base, n + 1);
    return n ? `${base}-${n}` : base;
}

export function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}
