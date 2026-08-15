import type { NoteRef } from "./types.js";

export type ToolErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "LIMIT_EXCEEDED"
  | "CAPABILITY_MISSING"
  | "STALE_INDEX"
  | "PERMISSION_DENIED"
  | "INTERNAL_ERROR";

export interface ToolErrorGuidance {
  retryable?: boolean;
  next_step?: string;
  suggested_tools?: string[];
}

export function jsonResponse(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export function errorResponse(
  code: ToolErrorCode,
  message: string,
  details: Record<string, unknown> = {},
  guidance?: ToolErrorGuidance,
) {
  return jsonResponse({
    error: message,
    error_code: code,
    ...details,
    ...(guidance
      ? {
          agent_guidance: {
            retryable: guidance.retryable ?? false,
            ...(guidance.next_step ? { next_step: guidance.next_step } : {}),
            ...(guidance.suggested_tools?.length
              ? { suggested_tools: guidance.suggested_tools }
              : {}),
          },
        }
      : {}),
  });
}

export function noteRef(path: string, heading?: string): string {
  return heading ? `${path}#${heading}` : path;
}

// ─── Payload budgets ──────────────────────────────────────────────────────────

/**
 * Per-response ceilings, derived from the 32k-char turn budget asserted in
 * budget-guards.test.ts: no single tool result may consume more than a quarter
 * of a turn. Without these, one pathological note — a 50 KB section, a note
 * with 300 headings — silently blows out the caller's context.
 */
export const MAX_TEXT_CHARS = 8_000;
export const MAX_LIST_ITEMS = 50;

export interface TruncatedText {
  text: string;
  truncated: boolean;
  total_chars: number;
}

/** Keep `edge` = "head" for documents, "tail" for append-only logs. */
export function truncateText(
  text: string,
  max: number = MAX_TEXT_CHARS,
  edge: "head" | "tail" = "head",
): TruncatedText {
  if (text.length <= max) {
    return { text, truncated: false, total_chars: text.length };
  }
  return {
    text: edge === "head" ? text.slice(0, max) : text.slice(text.length - max),
    truncated: true,
    total_chars: text.length,
  };
}

export interface TruncatedList<T> {
  items: T[];
  truncated: boolean;
  total_count: number;
}

export function truncateList<T>(items: T[], max: number = MAX_LIST_ITEMS): TruncatedList<T> {
  return {
    items: items.length <= max ? items : items.slice(0, max),
    truncated: items.length > max,
    total_count: items.length,
  };
}

export function enrichNoteRef<T extends Pick<NoteRef, "path">>(ref: T): T & { ref: string } {
  return {
    ...ref,
    ref: noteRef(ref.path),
  };
}

export function enrichNoteRefs<T extends Pick<NoteRef, "path">>(refs: T[]): Array<T & { ref: string }> {
  return refs.map((ref) => enrichNoteRef(ref));
}

export function errorCodeFromUnknown(
  err: unknown,
  fallback: ToolErrorCode = "INTERNAL_ERROR",
): ToolErrorCode {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
  ) {
    switch ((err as { code: string }).code) {
      case "ENOENT":
        return "NOT_FOUND";
      case "EACCES":
      case "EPERM":
        return "PERMISSION_DENIED";
      default:
        break;
    }
  }

  if (err instanceof Error && err.message.includes("Path traversal denied")) {
    return "PERMISSION_DENIED";
  }

  return fallback;
}