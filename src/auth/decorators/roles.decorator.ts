import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../../database/enums';

export const ROLES_KEY = 'auth:roles';
export const Roles = (
  ...roles: UserRole[]
): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
