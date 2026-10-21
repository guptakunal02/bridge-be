import type {
  BotFunction,
  BotFunctionOutcome,
  BotFunctionParam,
} from '../types';

/**
 * Public shape sent to the FE builder. Strips the server-side
 * `handler` callable so it never gets serialised and never leaks
 * implementation details.
 */
export interface BotFunctionResponse {
  key: string;
  label: string;
  description: string;
  inputs: BotFunctionParam[];
  outputs: BotFunctionParam[];
  /** Terminal states the handler can return. Each becomes a source
   *  handle on the Function node in the editor; admin wires each to
   *  the next step they want for that case. */
  outcomes: BotFunctionOutcome[];
}

export function toBotFunctionResponse(f: BotFunction): BotFunctionResponse {
  return {
    key: f.key,
    label: f.label,
    description: f.description,
    inputs: [...f.inputs],
    outputs: [...f.outputs],
    outcomes: [...f.outcomes],
  };
}
