// Shared UI state and the action registry. Views import `A` instead of app.js
// to avoid circular imports; app.js fills it in at boot.
import { params } from "./dom.js";

export const VIEWS = ["activity", "explorer", "analytics", "hygiene", "vault"];

export function pref(key, fallback) {
    try {
        const v = localStorage.getItem(`oil.${key}`);
        return v == null ? fallback : JSON.parse(v);
    } catch {
        return fallback;
    }
}

export function savePref(key, value) {
    try {
        localStorage.setItem(`oil.${key}`, JSON.stringify(value));
    } catch {
        /* storage may be unavailable */
    }
}

export const S = {
    tab: VIEWS.includes(params.get("view")) ? params.get("view") : "activity",
    scope: "session",
    days: 30,
    state: null,
    activity: null,
    analytics: null,
    hygiene: null,
    hygieneError: null,
    scanning: false,
    vaults: null,
    fs: null,
    fsError: null,
    tree: null,
    treeError: null,
    treeOpen: new Set(),
    treeFilter: "",
    /** path → strongest OIL touch kind in the current scope */
    touched: new Map(),
    /** { path, kind, mode, info, links, graph, diffs, version, editor, editError, outline, heading } */
    note: null,
    /** { tag, data } when the explorer shows notes for a tag */
    tag: null,
    /** folder path when the explorer shows a folder listing */
    folder: null,
    side: { open: pref("sideOpen", true), tab: pref("sideTab", "links"), depth: 1 },
    treePane: pref("treePane", true),
    hist: { back: [], fwd: [] },
    live: false,
    importing: null,
    lastSyncAt: null,
    lastSyncStats: null,
    syncError: null,
    syncNew: 0,
    /** Analytics sub-view: "overview" | "search" */
    analyticsView: pref("analyticsView", "overview") === "search" ? "search" : "overview",
    searchStats: null,
    /** Search chains list: "longest" | "recent" */
    searchChains: "longest",
    showAll: {},
    error: null,
};

/** Actions registered by app.js: render, setTab, openNote, openTag, revealFolder, askCopilot, createNote, ... */
export const A = {};

export const TOUCH_RANK = { created: 5, modified: 4, failed: 3, read: 2, surfaced: 1 };

export function touchKind(note) {
    if (note.created) return "created";
    if (note.modified) return "modified";
    if (note.failed_writes) return "failed";
    if (note.reads) return "read";
    return "surfaced";
}
