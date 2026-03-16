import { describe, it, expect } from "vitest";
import {
  isValidGuid,
  isValidIsoDate,
  validateVaultPath,
  validateCustomerName,
  validationError,
} from "../validation.js";

describe("isValidGuid", () => {
  it("accepts well-formed GUIDs", () => {
    expect(isValidGuid("12345678-1234-1234-1234-123456789abc")).toBe(true);
    expect(isValidGuid("ABCDEF01-2345-6789-ABCD-EF0123456789")).toBe(true);
  });

  it("rejects malformed GUIDs", () => {
    expect(isValidGuid("")).toBe(false);
    expect(isValidGuid("not-a-guid")).toBe(false);
    expect(isValidGuid("12345678123412341234123456789abc")).toBe(false); // no dashes
    expect(isValidGuid("{12345678-1234-1234-1234-123456789abc}")).toBe(false); // braces
    expect(isValidGuid("12345678-1234-1234-1234-12345678ZZZZ")).toBe(false); // non-hex
  });
});

describe("isValidIsoDate", () => {
  it("accepts valid ISO dates", () => {
    expect(isValidIsoDate("2025-01-15")).toBe(true);
    expect(isValidIsoDate("2025-12-31")).toBe(true);
    expect(isValidIsoDate("2025-01-15T10:30:00Z")).toBe(true);
  });

  it("rejects invalid dates", () => {
    expect(isValidIsoDate("")).toBe(false);
    expect(isValidIsoDate("15/01/2025")).toBe(false);
    expect(isValidIsoDate("2025-13-01")).toBe(false); // month 13 is invalid
    expect(isValidIsoDate("not-a-date")).toBe(false);
  });
});

describe("validateVaultPath", () => {
  it("returns null for valid paths", () => {
    expect(validateVaultPath("Customers/Contoso.md")).toBeNull();
    expect(validateVaultPath("Meetings/2025-01-15 - Sync.md")).toBeNull();
    expect(validateVaultPath("_agent-log/2025-01-15.md")).toBeNull();
  });

  it("rejects empty/nullbyte paths", () => {
    expect(validateVaultPath("")).not.toBeNull();
    expect(validateVaultPath("foo\0bar")).not.toBeNull();
  });

  it("rejects path traversal", () => {
    expect(validateVaultPath("../etc/passwd")).not.toBeNull();
    expect(validateVaultPath("Customers/../../secret")).not.toBeNull();
    expect(validateVaultPath("..")).not.toBeNull();
  });

  it("rejects absolute paths", () => {
    expect(validateVaultPath("/etc/passwd")).not.toBeNull();
    expect(validateVaultPath("C:\\Windows\\System32")).not.toBeNull();
  });

  it("rejects excessively long paths", () => {
    expect(validateVaultPath("a".repeat(501))).not.toBeNull();
  });
});

describe("validateCustomerName", () => {
  it("returns null for valid names", () => {
    expect(validateCustomerName("Contoso")).toBeNull();
    expect(validateCustomerName("Fabrikam Inc.")).toBeNull();
    expect(validateCustomerName("Acme Corp (US)")).toBeNull();
  });

  it("rejects names with path separators", () => {
    expect(validateCustomerName("Contoso/Evil")).not.toBeNull();
    expect(validateCustomerName("Contoso\\Evil")).not.toBeNull();
  });

  it("rejects traversal in names", () => {
    expect(validateCustomerName("..")).not.toBeNull();
    expect(validateCustomerName("Contoso..Evil")).not.toBeNull();
  });

  it("rejects null bytes", () => {
    expect(validateCustomerName("Contoso\0")).not.toBeNull();
  });

  it("rejects empty names", () => {
    expect(validateCustomerName("")).not.toBeNull();
  });
});

describe("validationError", () => {
  it("returns MCP-shaped error response", () => {
    const result = validationError("test error");
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ error: "test error" });
  });
});
