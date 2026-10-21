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
 * One of the possible terminal states a function handler can return.
 * Drives the "N output handles on the function node" UX in the editor
 * — each outcome gets its own handle, admin wires each to the next
 * step they want for that case.
 *
 * Why `outcomes` instead of a dumb truthy/falsy split: handlers return
 * domain-specific states (found vs not_found, new vs repeat, business
 * hour vs OOH). A single TRUE/FALSE handle would force admins to then
 * add a Branch step to decode the outcome from a variable — the whole
 * point of outcomes is to skip that intermediate step.
 */
export interface BotFunctionOutcome {
  /** Short stable identifier returned by the handler + used in the
   *  Function step's `onOutcome` config map. snake_case. */
  key: string;
  /** Human label shown on the editor handle + in the picker. */
  label: string;
  description?: string;
}

/**
 * A registered bot function.
 *
 *   key         — stable identifier; referenced by flow steps.
 *   handler     — a plain async function. Not a class, not DI-resolved —
 *                 keeps handlers cheap to write and cheap to test.
 *                 Returns both an outcome key (which decides routing)
 *                 and the output variables (which get stashed in
 *                 session state for downstream steps to interpolate).
 *   inputs      — schema the invoker must satisfy.
 *   outputs     — schema the handler promises. Runtime uses these to
 *                 name variables when the step's output binds into
 *                 the flow's session state.
 *   outcomes    — the discrete terminal states the handler can return.
 *                 One handle per outcome rendered on the editor.
 */
export interface BotFunctionHandlerResult {
  outcome: string;
  outputs: Record<string, unknown>;
}

export interface BotFunction {
  key: string;
  label: string;
  description: string;
  inputs: readonly BotFunctionParam[];
  outputs: readonly BotFunctionParam[];
  outcomes: readonly BotFunctionOutcome[];
  handler: (
    inputs: Record<string, unknown>,
    deps: BotFunctionDeps,
  ) => Promise<BotFunctionHandlerResult>;
}
