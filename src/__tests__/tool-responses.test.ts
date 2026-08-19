/**
 * Tests for tool-responses.ts — shared MCP response helpers.
 */
import { describe, it, expect } from "vitest";
import {
  jsonResponse,
  errorResponse,
  noteRef,
  refField,
  errorCodeFromUnknown,
} from "../tool-responses.js";

describe("jsonResponse", () => {
  it("wraps a payload in MCP content shape", () => {
    const result = jsonResponse({ foo: "bar" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ foo: "bar" });
  });

  it("emits compact JSON — indentation is ~25% of a payload and nothing renders it", () => {
    const result = jsonResponse({ a: 1, b: { c: 2 } });
    expect(result.content[0].text).toBe('{"a":1,"b":{"c":2}}');
  });
});

describe("errorResponse", () => {
  it("includes error message and code at top level", () => {
    const result = errorResponse("NOT_FOUND", "Note missing");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Note missing");
    expect(parsed.error_code).toBe("NOT_FOUND");
  });

  it("merges extra details into the response", () => {
    const result = errorResponse("CONFLICT", "Stale write", {
      expected_mtime: 100,
      current_mtime: 200,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error_code).toBe("CONFLICT");
    expect(parsed.expected_mtime).toBe(100);
    expect(parsed.current_mtime).toBe(200);
  });

  it("adds structured agent guidance when provided", () => {
    const result = errorResponse(
      "CONFLICT",
      "Stale write",
      { path: "Customers/Contoso.md" },
      {
        retryable: true,
        next_step: "Call get_note_metadata, then retry with fresh mtime_ms.",
        suggested_tools: ["get_note_metadata", "atomic_append"],
      },
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.agent_guidance.retryable).toBe(true);
    expect(parsed.agent_guidance.next_step).toContain("get_note_metadata");
    expect(parsed.agent_guidance.suggested_tools).toEqual([
      "get_note_metadata",
      "atomic_append",
    ]);
  });

  it("does not include extra keys when details is empty", () => {
    const result = errorResponse("INTERNAL_ERROR", "boom");
    const parsed = JSON.parse(result.content[0].text);
    expect(Object.keys(parsed)).toEqual(["error", "error_code"]);
  });
});

describe("noteRef", () => {
  it("returns bare path when no heading", () => {
    expect(noteRef("Customers/Contoso.md")).toBe("Customers/Contoso.md");
  });

  it("appends heading with # separator", () => {
    expect(noteRef("Customers/Contoso.md", "Team")).toBe("Customers/Contoso.md#Team");
  });

  it("handles headings with spaces", () => {
    expect(noteRef("note.md", "Agent Insights")).toBe("note.md#Agent Insights");
  });
});

describe("refField", () => {
  it("emits nothing when there is no heading, because ref would equal path", () => {
    expect(refField("Customers/Contoso.md")).toEqual({});
  });

  it("emits heading and anchored ref when the result is section-scoped", () => {
    expect(refField("Customers/Contoso.md", "Team")).toEqual({
      heading: "Team",
      ref: "Customers/Contoso.md#Team",
    });
  });
});

describe("errorCodeFromUnknown", () => {
  it("maps ENOENT to NOT_FOUND", () => {
    const err = Object.assign(new Error("no such file"), { code: "ENOENT" });
    expect(errorCodeFromUnknown(err)).toBe("NOT_FOUND");
  });

  it("maps EACCES to PERMISSION_DENIED", () => {
    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
    expect(errorCodeFromUnknown(err)).toBe("PERMISSION_DENIED");
  });

  it("maps EPERM to PERMISSION_DENIED", () => {
    const err = Object.assign(new Error("not permitted"), { code: "EPERM" });
    expect(errorCodeFromUnknown(err)).toBe("PERMISSION_DENIED");
  });

  it("maps path traversal error message to PERMISSION_DENIED", () => {
    const err = new Error("Path traversal denied: ../etc/passwd");
    expect(errorCodeFromUnknown(err)).toBe("PERMISSION_DENIED");
  });

  it("returns fallback for unknown error codes", () => {
    const err = Object.assign(new Error("unknown"), { code: "ESOMETHING" });
    expect(errorCodeFromUnknown(err)).toBe("INTERNAL_ERROR");
  });

  it("returns custom fallback when provided", () => {
    expect(errorCodeFromUnknown("string error", "STALE_INDEX")).toBe("STALE_INDEX");
  });

  it("returns INTERNAL_ERROR for plain strings", () => {
    expect(errorCodeFromUnknown("oops")).toBe("INTERNAL_ERROR");
  });

  it("returns INTERNAL_ERROR for null", () => {
    expect(errorCodeFromUnknown(null)).toBe("INTERNAL_ERROR");
  });
});
