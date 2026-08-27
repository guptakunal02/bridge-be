import { UseGuards, applyDecorators } from '@nestjs/common';
import { AdminGuard } from '../guards/admin.guard';

/**
 * Applies AdminGuard to a route or controller. Intended composition:
 * global JwtAuthGuard → global ApprovedGuard → @AdminOnly() on the route.
 */
export const AdminOnly = () => applyDecorators(UseGuards(AdminGuard));
