import type { OpsReadService } from '../ops/ops-read.service';

/**
 * Type of a function's declared input or output field. The FE reads
 * this to render the right input widget (number / string / dropdown)
 * and the runtime uses it to validate inputs before calling.
 */
export type BotParamType =
  'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array';

export interface BotFunctionParam {
  key: string;
  label: string;
  type: BotParamType;
  /** Required inputs must be present before invoke; missing = BadRequest. */
  required?: boolean;
  /** For type='enum' — the allowed values. */
  enumValues?: readonly string[];
  description?: string;
}

/**
 * Dependencies handed to every function handler. Explicit and small
 * on purpose — grows over time (Shopify client, template rendering,
 * etc.) but each addition is deliberate, not "everything DI can find".
 */
export interface BotFunctionDeps {
  opsRead: OpsReadService;
}

/**
 * A registered bot function.
 *
 *   key         — stable identifier; referenced by flow steps.
 *   handler     — a plain async function. Not a class, not DI-resolved —
 *                 keeps handlers cheap to write and cheap to test.
 *   inputs      — schema the invoker must satisfy.
 *   outputs     — schema the handler promises. Runtime uses these to
 *                 name variables when the step's output binds into
 *                 the flow's session state.
 */
export interface BotFunction {
  key: string;
  label: string;
  description: string;
  inputs: readonly BotFunctionParam[];
  outputs: readonly BotFunctionParam[];
  handler: (
    inputs: Record<string, unknown>,
    deps: BotFunctionDeps,
  ) => Promise<Record<string, unknown>>;
}
