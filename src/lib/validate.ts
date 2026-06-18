/** Shared input validation helpers. */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** True for a valid 24-hour "HH:MM" string. */
export function isValidTime(s: string): boolean {
  return TIME_RE.test(s);
}

/**
 * True when end is strictly after start. Both must be "HH:MM"; zero-padded
 * 24-hour strings compare correctly with plain lexicographic ordering.
 */
export function endAfterStart(start: string, end: string): boolean {
  return end > start;
}

/** Escapes a string for safe use inside a RegExp (e.g. case-insensitive match). */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Mongo duplicate-key error guard. */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}
