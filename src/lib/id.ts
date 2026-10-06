let counter = 0;

/**
 * Generate a local unique id for planning rows. Uses crypto.randomUUID when
 * available (built-in, offline) and falls back to a timestamped counter.
 * Ids exist only for React keys and row identity — never for calculations.
 */
export function generateId(): string {
  counter += 1;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `row-${Date.now().toString(36)}-${counter}`;
}
