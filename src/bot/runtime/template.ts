/**
 * Variable substitution for step configs.
 *
 * Templates use `${dot.path}` syntax. Path segments walk into nested
 * objects; a missing key renders as an empty string (never
 * "undefined"), so half-configured flows don't leak internals to the
 * customer.
 *
 * `renderValue` walks any config value (strings, arrays, objects)
 * and applies renderText to every string leaf. Handy for the
 * `function.inputs` map — admin writes `{ phone: "${customer.phone}" }`
 * and the runtime resolves before invoking the handler.
 */

const TEMPLATE_RE = /\$\{([^}]+)\}/g;

export function renderText(
  template: string,
  variables: Record<string, unknown>,
): string {
  return template.replace(TEMPLATE_RE, (_, rawPath: string) => {
    const path = rawPath.trim();
    const value = readPath(variables, path);
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'symbol') return value.toString();
    // Objects, arrays, functions — never rendered raw. JSON.stringify
    // is safe for the former, functions can't reasonably be shown.
    if (typeof value === 'object') return JSON.stringify(value);
    return '';
  });
}

/**
 * Deep-render every string in `value`. Non-string leaves pass through
 * untouched — a `nextStepId` UUID isn't a template, a number literal
 * stays numeric, etc.
 */
export function renderValue(
  value: unknown,
  variables: Record<string, unknown>,
): unknown {
  if (typeof value === 'string') return renderText(value, variables);
  if (Array.isArray(value)) return value.map((v) => renderValue(v, variables));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderValue(v, variables);
    }
    return out;
  }
  return value;
}

function readPath(root: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cursor: unknown = root;
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}
