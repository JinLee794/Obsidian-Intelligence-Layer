/**
 * Line diff (Myers O(ND)) producing unified-style hunks.
 * Falls back to a whole-file replace when the edit distance is very large.
 */
export function diffLines(beforeText, afterText, { context = 3, maxD = 3000 } = {}) {
    const a = splitLines(beforeText);
    const b = splitLines(afterText);
    const ops = myers(a, b, maxD) ?? [...a.map((t) => ({ op: "-", text: t })), ...b.map((t) => ({ op: "+", text: t }))];

    let oldNo = 1;
    let newNo = 1;
    const lines = ops.map((o) => {
        const row = { op: o.op, text: o.text, old: o.op === "+" ? null : oldNo, new: o.op === "-" ? null : newNo };
        if (o.op !== "+") oldNo++;
        if (o.op !== "-") newNo++;
        return row;
    });
    const added = lines.filter((l) => l.op === "+").length;
    const removed = lines.filter((l) => l.op === "-").length;
    return { added, removed, hunks: toHunks(lines, context) };
}

function splitLines(text) {
    if (text == null || text === "") return [];
    const lines = String(text).replace(/\r\n/g, "\n").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
}

function myers(a, b, maxD) {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    // Each trace step copies v; bound total memory to ~80 MB of Int32 entries.
    const dLimit = Math.min(max, maxD, Math.floor(2e7 / v.length));
    for (let d = 0; d <= dLimit; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) return backtrack(trace, a, b, offset);
        }
    }
    return null;
}

function backtrack(trace, a, b, offset) {
    const ops = [];
    let x = a.length;
    let y = b.length;
    for (let d = trace.length - 1; d >= 0; d--) {
        const v = trace[d];
        const k = x - y;
        const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
        const prevX = v[offset + prevK];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
            ops.push({ op: " ", text: a[x - 1] });
            x--;
            y--;
        }
        if (d > 0) {
            if (x === prevX) ops.push({ op: "+", text: b[y - 1] });
            else ops.push({ op: "-", text: a[x - 1] });
        }
        x = prevX;
        y = prevY;
    }
    return ops.reverse();
}

function toHunks(lines, context) {
    const hunks = [];
    let current = null;
    let lastChange = -Infinity;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].op === " ") continue;
        const start = Math.max(0, i - context);
        if (!current || start > lastChange + context + 1) {
            current = { start, end: i };
            hunks.push(current);
        }
        current.end = i;
        lastChange = i;
    }
    return hunks.map((h) => {
        const slice = lines.slice(h.start, Math.min(lines.length, h.end + context + 1));
        const first = slice[0];
        return {
            oldStart: first.old ?? (slice.find((l) => l.old != null)?.old ?? 0),
            newStart: first.new ?? (slice.find((l) => l.new != null)?.new ?? 0),
            lines: slice,
        };
    });
}
