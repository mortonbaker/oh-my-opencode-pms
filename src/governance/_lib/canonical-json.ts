/**
 * canonical-json.ts — byte-equivalent of Python
 *   json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
 *
 * Used to compute the HMAC over an audit row so external tooling (Python
 * verifiers, other runtimes) that consumes the audit chain produces
 * identical hashes for identical inputs.
 *
 * Constraints (locked):
 *   - All numeric fields in AuditRow are INTEGERS, no floats. JS Number → JSON
 *     has no `.0` suffix; floats would diverge from Python's `1.0`.
 *   - Strings: ensure_ascii=False on both sides. Non-ASCII characters stay
 *     literal. Both runtimes escape only the same control set.
 *   - Keys sort by code-point string comparison. For ASCII keys (the only
 *     kind used in AuditRow) Python `sorted()` and JS `Array.prototype.sort()`
 *     produce identical orderings. Supplementary-plane keys (above U+FFFF)
 *     would diverge — JS sorts by UTF-16 code units — so AuditRow keys are
 *     locked to ASCII.
 *
 * Ported from ~/pms/.opencode/plugins/_lib/canonical-json.ts (Tier 5).
 */

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as object).sort()) {
    out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
  }
  return out;
}

/** Byte-stable canonical JSON. See file header for the invariants. */
export function canonicalJsonStringify(obj: unknown): string {
  return JSON.stringify(sortKeysDeep(obj));
}
