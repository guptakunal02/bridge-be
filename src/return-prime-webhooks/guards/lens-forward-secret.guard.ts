import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { EnvVars } from '../../config/env.validation';

/**
 * Validates the `X-Lens-Secret` header on inbound /webhooks/return-prime
 * requests. Three branches per spec:
 *
 *   1. LENS_FORWARD_SECRET unset in env → guard skips entirely.
 *      Dev-safe (no config needed to run locally) + preserves the
 *      "open endpoint" posture we agreed on while awaiting RP's
 *      auth-model clarification.
 *   2. Env set + request has no X-Lens-Secret header → allow through.
 *      Direct-from-RP deliveries will never carry this header; if
 *      RP's dispatcher ever starts firing to Bridge again, we don't
 *      want to lock them out.
 *   3. Env set + request has X-Lens-Secret → constant-time compare.
 *      Mismatch returns 401 (distinct from 403 the Clickpost guard
 *      uses, so Lens's forwarder logs it unambiguously as "secret
 *      mismatch" rather than "forbidden").
 *
 * Rotation: edit the secret on BOTH sides (Lens's forwarder + this
 * env) in the same deploy window — a mismatch window drops forwards
 * to 401 until the second side catches up.
 */
@Injectable()
export class LensForwardSecretGuard implements CanActivate {
  private readonly logger = new Logger(LensForwardSecretGuard.name);

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get('LENS_FORWARD_SECRET', { infer: true });
    if (!expected) {
      // Branch 1 — guard is dormant until the env is set.
      return true;
    }
    const req = context.switchToHttp().getRequest<Request>();
    const received = req.get('x-lens-secret');
    if (!received) {
      // Branch 2 — treat absent header as a direct-from-RP delivery.
      // Logged at debug level only; this path is hit on every
      // real RP delivery once their dispatcher is fixed, so a
      // warn/log line here would be noise.
      return true;
    }

    // Branch 3 — header present, must match.
    const receivedBuf = Buffer.from(received, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (receivedBuf.length !== expectedBuf.length) {
      this.logger.warn(
        'Lens guard rejected: X-Lens-Secret length mismatch (likely a bad rotation on one side)',
      );
      throw new UnauthorizedException('X-Lens-Secret mismatch');
    }
    if (!timingSafeEqual(receivedBuf, expectedBuf)) {
      this.logger.warn('Lens guard rejected: X-Lens-Secret value mismatch');
      throw new UnauthorizedException('X-Lens-Secret mismatch');
    }
    return true;
  }
}
