import type { BotFunction, BotFunctionParam } from '../types';

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
}

export function toBotFunctionResponse(f: BotFunction): BotFunctionResponse {
  return {
    key: f.key,
    label: f.label,
    description: f.description,
    inputs: [...f.inputs],
    outputs: [...f.outputs],
  };
}
