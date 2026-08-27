import { UserStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class SetPresenceDto {
  @IsEnum(UserStatus)
  status!: UserStatus;
}
