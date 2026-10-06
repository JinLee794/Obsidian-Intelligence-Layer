import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { dirname } from "node:path";

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === "EPERM";
    }
}

/**
 * Cross-process lock file holding the owner's PID. Returns `{ release, touch }`,
 * or `{ heldBy }` when another live process holds it. A lock whose owner has
 * exited, or that hasn't been touched within `staleMs`, is taken over.
 */
export function tryLock(file, { staleMs = 10 * 60_000 } = {}) {
    mkdirSync(dirname(file), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const fd = openSync(file, "wx");
            writeSync(fd, String(process.pid));
            closeSync(fd);
            let released = false;
            return {
                touch() {
                    try {
                        if (!released) utimesSync(file, new Date(), new Date());
                    } catch {}
                },
                release() {
                    if (released) return;
                    released = true;
                    try {
                        if (readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file);
                    } catch {}
                },
            };
        } catch (err) {
            if (err.code !== "EEXIST") throw err;
        }
        let holder = 0;
        let age = 0;
        try {
            holder = Number.parseInt(readFileSync(file, "utf8").trim(), 10) || 0;
            age = Date.now() - statSync(file).mtimeMs;
        } catch {
            continue; // released between our attempts
        }
        if (holder && holder !== process.pid && alive(holder) && age < staleMs) return { heldBy: holder };
        try {
            unlinkSync(file);
        } catch {}
    }
    return { heldBy: null };
}
