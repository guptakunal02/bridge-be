import { UseGuards, applyDecorators } from '@nestjs/common';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';

/**
 * Marks a route (or controller class) as requiring a valid access token.
 *
 * The JwtAuthGuard is also registered globally, so unmarked routes are
 * protected too. Applying `@LoggedIn()` is a documentation signal — it
 * makes the auth requirement visible at the call site so readers don't
 * have to consult the module wiring to know.
 */
export const LoggedIn = () => applyDecorators(UseGuards(JwtAuthGuard));
