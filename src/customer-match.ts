/**
 * Name evidence for search-assisted customer resolution.
 *
 * Search ranks candidate hubs, but a top-ranked hit is not proof of identity:
 * BM25 and semantic tiers happily rank a hub first because its notes *mention*
 * the query ("Proseware" inside a Northwind meeting). A hub is only accepted when
 * one of its own names — folder, title, or alias — accounts for every
 * distinctive word of the query.
 */

/** Legal suffixes and industry words that identify no particular customer. */
const GENERIC_TOKENS = new Set([
  "a", "an", "and", "the", "of", "for",
  "co", "corp", "corporation", "inc", "incorporated", "company", "companies",
  "llc", "llp", "lp", "ltd", "limited", "plc", "group", "holdings",
  "international", "intl", "global", "systems", "services", "solutions",
  "health", "healthcare", "hospital", "hospitals", "insurance",
  "customer", "account",
]);

export function nameTokens(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Query tokens that can identify a customer; empty when the query is all boilerplate. */
export function distinctiveTokens(value: string): string[] {
  return nameTokens(value).filter((token) => !GENERIC_TOKENS.has(token));
}

function editDistanceWithin(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > max) return false;
    previous = current;
  }
  return previous[b.length] <= max;
}

function tokenMatches(query: string, name: string): boolean {
  if (query === name) return true;
  if (/^\d+$/.test(query)) return false;
  if (query.length >= 4 && name.startsWith(query)) return true;
  if (query.length >= 5 && name.length >= 5) {
    return editDistanceWithin(query, name, Math.min(query.length, name.length) >= 8 ? 2 : 1);
  }
  return false;
}

export type NameEvidence = "name" | "acronym";

/**
 * How one customer name accounts for the query, or null when it does not.
 * Every distinctive query token must be matched inside the same name, so
 * "Contoso Subsidiary" is not evidence for a hub named only "Contoso".
 */
export function nameEvidence(query: string, name: string): NameEvidence | null {
  const wanted = distinctiveTokens(query);
  if (wanted.length === 0) return null;
  const tokens = nameTokens(name);
  if (tokens.length === 0) return null;
  const joined = tokens.join("");
  const covered = wanted.every(
    (q) => tokens.some((t) => tokenMatches(q, t)) || (q.length >= 5 && joined.includes(q)),
  );
  if (covered) return "name";
  // "Woodgrove Bank" → "Woodgrovebank Group".
  const compound = wanted.join("");
  if (wanted.length > 1 && compound.length >= 5) {
    if (tokens.some((t) => tokenMatches(compound, t)) || joined.includes(compound)) return "name";
  }

  // "BD" → Becton Dickinson, "MGB" → Mass General Brigham (Partners).
  if (wanted.length === 1 && /^[a-z]{2,5}$/.test(wanted[0])) {
    const initials = distinctiveTokens(name.replace(/\([^)]*\)/g, " "))
      .map((t) => t[0])
      .join("");
    if (initials.length >= 2 && initials === wanted[0]) return "acronym";
  }
  return null;
}

/** Best evidence any of a hub's names gives for the query. */
export function hubEvidence(query: string, names: Iterable<string>): NameEvidence | null {
  let best: NameEvidence | null = null;
  for (const name of names) {
    const evidence = nameEvidence(query, name);
    if (evidence === "name") return "name";
    best ??= evidence;
  }
  return best;
}
