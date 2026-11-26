// Minimal stand-in for gray-matter, covering the YAML subset the synthetic
// fixtures emit: scalars, quoted strings, inline `[a, b]` lists, block lists of
// scalars or flat maps, and one level of nested map.
//
// Deliberate difference from js-yaml: an unquoted YYYY-MM-DD stays a string
// instead of becoming a Date. Real OIL keeps the Date in memory but round-trips
// it through _oil-graph.json as an ISO string, so cold and warm BM25 tokens
// differ there. That quirk is orthogonal to graph layout, so it is excluded.

function scalar(raw) {
  let text = raw.trim();
  if (text === "" || text === "~" || text === "null") return null;
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  const hash = text.search(/\s#/);
  if (hash !== -1) text = text.slice(0, hash).trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?(0|[1-9]\d*)$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text)) return Number(text);
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((part) => scalar(part));
  }
  return text;
}

const indentOf = (line) => line.length - line.trimStart().length;
const KEY = /^([A-Za-z0-9_][\w\-. ]*?):(?:\s+(.*))?$/;

function parseYaml(text) {
  const lines = text.split("\n");
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) { i++; continue; }
    const match = KEY.exec(line.trim());
    if (!match || indentOf(line) !== 0) { i++; continue; }
    const key = match[1];
    if (match[2] !== undefined && match[2].trim() !== "") {
      data[key] = scalar(match[2]);
      i++;
      continue;
    }
    // Block value: the indented (or "- ") lines that follow.
    const block = [];
    i++;
    while (
      i < lines.length &&
      (lines[i].trim() === "" || indentOf(lines[i]) > 0 || lines[i].startsWith("- "))
    ) {
      if (lines[i].trim() !== "") block.push(lines[i]);
      i++;
    }
    if (block.length === 0) { data[key] = null; continue; }
    if (block[0].trimStart().startsWith("- ")) {
      const list = [];
      for (const raw of block) {
        const trimmed = raw.trimStart();
        if (trimmed.startsWith("- ")) {
          const item = trimmed.slice(2);
          const kv = KEY.exec(item);
          if (kv && !item.startsWith('"') && !item.startsWith("'")) {
            list.push({ [kv[1]]: scalar(kv[2] ?? "") });
          } else {
            list.push(scalar(item));
          }
        } else {
          const kv = KEY.exec(trimmed);
          const last = list[list.length - 1];
          if (kv && last && typeof last === "object" && !Array.isArray(last)) {
            last[kv[1]] = scalar(kv[2] ?? "");
          }
        }
      }
      data[key] = list;
    } else {
      const map = {};
      for (const raw of block) {
        const kv = KEY.exec(raw.trim());
        if (kv) map[kv[1]] = scalar(kv[2] ?? "");
      }
      data[key] = map;
    }
  }
  return data;
}

export default function matter(input) {
  const str = String(input);
  if (!str.startsWith("---")) return { data: {}, content: str };
  const firstNewline = str.indexOf("\n");
  if (firstNewline === -1 || str.slice(3, firstNewline).trim() !== "") {
    return { data: {}, content: str };
  }
  const close = str.indexOf("\n---", firstNewline - 1);
  if (close === -1) return { data: {}, content: str };
  const yaml = str.slice(firstNewline + 1, close);
  let rest = str.slice(close + 4);
  if (rest.startsWith("\r")) rest = rest.slice(1);
  if (rest.startsWith("\n")) rest = rest.slice(1);
  return { data: parseYaml(yaml), content: rest };
}
