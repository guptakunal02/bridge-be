/**
 * Shared JSON-path resolver for event→template variable binding.
 *
 * Supports dot-notation (`foo.bar.baz`) and bracket array indexing
 * (`items[0].id`). Returns `null` for any invalid path or null/undefined
 * crossing. Non-primitive leaves (object/array) stringify to JSON so
 * the caller can hand them to WhatsApp's template API without a special
 * case. Primitive leaves (string/number/boolean) stringify naturally.
 *
 * Why bake our own instead of lodash.get:
 *   - Zero runtime dep for a leak-sensitive long-running process.
 *   - We need predictable string coercion rules (never-null, always
 *     send-safe) that lodash's shape-preserving get doesn't give.
 *
 * Intentionally does NOT support:
 *   - wildcards / globs — admins can bind to specific indices if they
 *     really need a nested array
 *   - functions / method invocations — defensive against malicious
 *     paths from a bad rule config
 */
export function resolveJsonPath(
  root: unknown,
  path: string,
): string | null {
  if (!path || typeof path !== 'string') return null;
  const segments = tokenize(path);
  if (segments === null) return null;
  let node: unknown = root;
  for (const seg of segments) {
    if (node === null || node === undefined) return null;
    if (typeof seg === 'number') {
      if (!Array.isArray(node)) return null;
      node = node[seg];
    } else {
      if (typeof node !== 'object' || Array.isArray(node)) return null;
      node = (node as Record<string, unknown>)[seg];
    }
  }
  return stringify(node);
}

function tokenize(path: string): Array<string | number> | null {
  const out: Array<string | number> = [];
  // Allow dot segments and [N] array indices. Simpler to split by `.`
  // first, then split each segment by `[` for the bracket form.
  for (const dotPart of path.split('.')) {
    if (dotPart.length === 0) return null;
    let rest = dotPart;
    const bracket = rest.indexOf('[');
    const key = bracket === -1 ? rest : rest.slice(0, bracket);
    if (key.length === 0) {
      // Starts with `[` — top-level array access without a key prefix.
      // Not supported for now (paths always start with a dotted key).
      return null;
    }
    out.push(key);
    rest = bracket === -1 ? '' : rest.slice(bracket);
    while (rest.length > 0) {
      if (rest[0] !== '[') return null;
      const close = rest.indexOf(']');
      if (close === -1) return null;
      const idxStr = rest.slice(1, close);
      const idx = Number(idxStr);
      if (!Number.isInteger(idx) || idx < 0) return null;
      out.push(idx);
      rest = rest.slice(close + 1);
    }
  }
  return out;
}

function stringify(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Objects + arrays — stringify as JSON so template authors can show
  // the raw shape if they really want to. Rare in practice; most
  // template vars resolve to primitives.
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}
