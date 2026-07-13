import type { NoteRef } from "./types.js";

export type ToolErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "UNKNOWN_FIELD"
  | "TYPE_MISMATCH"
  | "AMBIGUOUS_REF"
  | "CONFLICT"
  | "INVALID_CURSOR"
  | "LIMIT_EXCEEDED"
  | "CAPABILITY_MISSING"
  | "STALE_INDEX"
  | "INDEX_UNAVAILABLE"
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

/**
 * Shape deterministic aggregator output to a serialized-character budget.
 * Ordinary payloads are unchanged; oversized values lose depth/cardinality
 * before the tool returns LIMIT_EXCEEDED rather than flooding agent context.
 */
export function boundedJsonResponse(payload: unknown, maxChars: number) {
  const raw = JSON.stringify(payload, null, 2);
  if (raw.length <= maxChars) return jsonResponse(payload);

  for (const limits of [
    { maxArray: 10, maxString: 240, maxDepth: 8 },
    { maxArray: 5, maxString: 160, maxDepth: 6 },
    { maxArray: 3, maxString: 100, maxDepth: 4 },
  ]) {
    const shaped = boundValue(payload, limits, 0);
    if (shaped && typeof shaped === "object" && !Array.isArray(shaped)) {
      const currentWarnings = (shaped as Record<string, unknown>).warnings;
      Object.assign(shaped as Record<string, unknown>, {
        truncated: true,
        warnings: [
          ...new Set([
            ...(Array.isArray(currentWarnings) ? currentWarnings : []),
            "RESULTS_TRUNCATED",
          ]),
        ],
      });
    }
    if (JSON.stringify(shaped, null, 2).length <= maxChars) return jsonResponse(shaped);
  }

  return jsonResponse({
    truncated: true,
    warnings: ["RESULTS_TRUNCATED", "LIMIT_EXCEEDED"],
    maximum_serialized_chars: maxChars,
    available_keys: payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload as Record<string, unknown>).slice(0, 50)
      : [],
    agent_guidance: {
      retryable: true,
      next_step: "Narrow the request or use catalog search, metadata, and section primitives to retrieve the evidence progressively.",
    },
  });
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

function boundValue(
  value: unknown,
  limits: { maxArray: number; maxString: number; maxDepth: number },
  depth: number,
): unknown {
  if (typeof value === "string") {
    return value.length > limits.maxString
      ? `${value.slice(0, Math.max(0, limits.maxString - 3))}...`
      : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= limits.maxDepth) return "[truncated]";
  if (Array.isArray(value)) {
    return value
      .slice(0, limits.maxArray)
      .map((entry) => boundValue(entry, limits, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, boundValue(child, limits, depth + 1)]),
  );
}