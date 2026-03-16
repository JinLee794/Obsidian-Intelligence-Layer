/**
 * OIL — Domain-level input validation
 *
 * The MCP SDK validates inputs against Zod schemas (type checks) before
 * calling handlers. This module adds *domain-level* validation:
 * GUID format, ISO dates, path safety, string sanitization.
 *
 * Pattern mirrors mcp/msx/src/validation.js.
 */

const GUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** GUID format check (standard 8-4-4-4-12 hex). */
export function isValidGuid(value: string): boolean {
  return GUID_REGEX.test(value);
}

/** ISO date check (YYYY-MM-DD). Also validates the date is real. */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_REGEX.test(value) && !ISO_DATETIME_REGEX.test(value)) {
    return false;
  }
  const d = new Date(value);
  return !isNaN(d.getTime());
}

/**
 * Vault path safety check — catches problems that securePath would throw on,
 * but returns a descriptive error string instead of an exception.
 * Returns null if valid, or an error message string.
 */
export function validateVaultPath(path: string): string | null {
  if (!path || typeof path !== "string") {
    return "Path must be a non-empty string";
  }
  if (path.includes("\0")) {
    return "Path must not contain null bytes";
  }
  if (path.length > 500) {
    return "Path exceeds maximum length (500 chars)";
  }
  // Block absolute paths — vault paths are always relative
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return "Path must be relative to vault root";
  }
  // Block obvious traversal before it reaches securePath
  const normalised = path.replace(/\\/g, "/");
  if (normalised.includes("../") || normalised === "..") {
    return "Path traversal denied";
  }
  return null;
}

/**
 * Customer name safety check.
 * Returns null if valid, or an error message string.
 */
export function validateCustomerName(name: string): string | null {
  if (!name || typeof name !== "string") {
    return "Customer name must be a non-empty string";
  }
  if (name.includes("\0")) {
    return "Customer name must not contain null bytes";
  }
  if (name.length > 200) {
    return "Customer name exceeds maximum length (200 chars)";
  }
  // Customer names become folder/file names — block path separators
  if (/[/\\]/.test(name)) {
    return "Customer name must not contain path separators";
  }
  if (name.includes("..")) {
    return "Customer name must not contain '..'";
  }
  return null;
}

/** Build a standard MCP error response (content array with error text). */
export function validationError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
  };
}
