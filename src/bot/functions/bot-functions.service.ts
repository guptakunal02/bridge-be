import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OpsReadService } from '../ops/ops-read.service';
import {
  BotFunctionResponse,
  toBotFunctionResponse,
} from './dto/function-response.dto';
import { FUNCTIONS, findFunction } from './registry';
import type { BotFunctionDeps, BotFunctionParam } from './types';

/**
 * The single entry point through which flow steps invoke registered
 * functions. Owns:
 *   - The public catalog served to the FE builder (list()).
 *   - Input validation against each function's declared schema.
 *   - Dependency wiring — hands the handler its {opsRead, …} bundle.
 *
 * Never leaks the raw BotFunction (which carries the handler ref)
 * to HTTP responses — that's what BotFunctionResponse is for.
 */
@Injectable()
export class BotFunctionsService {
  constructor(private readonly opsRead: OpsReadService) {}

  list(): BotFunctionResponse[] {
    return FUNCTIONS.map(toBotFunctionResponse);
  }

  /**
   * Runs a registered function. The runtime calls this when a
   * "call function" step executes; nothing else in the app should.
   */
  async invoke(
    key: string,
    inputs: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const fn = findFunction(key);
    if (!fn) {
      throw new NotFoundException(`Function "${key}" is not registered`);
    }

    for (const param of fn.inputs) {
      const value = inputs[param.key];
      if (param.required && (value === undefined || value === null)) {
        throw new BadRequestException(
          `Function "${key}" requires input "${param.key}"`,
        );
      }
      if (value !== undefined && value !== null) {
        assertMatchesType(key, param, value);
      }
    }

    const deps: BotFunctionDeps = { opsRead: this.opsRead };
    return fn.handler(inputs, deps);
  }
}

/**
 * Cheap runtime type check. Doesn't try to be Zod — we only need to
 * refuse obviously-wrong shapes before they hit the handler.
 */
function assertMatchesType(
  fnKey: string,
  param: BotFunctionParam,
  value: unknown,
): void {
  const where = `Function "${fnKey}" input "${param.key}"`;
  switch (param.type) {
    case 'string':
      if (typeof value !== 'string') {
        throw new BadRequestException(`${where} must be a string`);
      }
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new BadRequestException(`${where} must be a finite number`);
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new BadRequestException(`${where} must be a boolean`);
      }
      return;
    case 'enum':
      if (typeof value !== 'string') {
        throw new BadRequestException(`${where} must be a string`);
      }
      if (param.enumValues && !param.enumValues.includes(value)) {
        throw new BadRequestException(
          `${where} must be one of ${param.enumValues.join(', ')}`,
        );
      }
      return;
    case 'array':
      if (!Array.isArray(value)) {
        throw new BadRequestException(`${where} must be an array`);
      }
      return;
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new BadRequestException(`${where} must be an object`);
      }
      return;
  }
}
