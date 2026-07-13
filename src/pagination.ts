import { sha256 } from "./catalog.js";

export interface CursorPayload {
  kind: string;
  generation: string;
  signature: string;
  offset: number;
  version?: number;
}

export function querySignature(value: unknown): string {
  return sha256(stableStringify(value)).slice(0, 24);
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

export function decodeCursor(
  cursor: string,
  expected: Pick<CursorPayload, "kind" | "generation" | "signature">,
): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as Partial<CursorPayload>;
    if (
      parsed.kind !== expected.kind
      || parsed.generation !== expected.generation
      || parsed.signature !== expected.signature
      || !Number.isSafeInteger(parsed.offset)
      || (parsed.offset ?? -1) < 0
    ) return null;
    return parsed as CursorPayload;
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
