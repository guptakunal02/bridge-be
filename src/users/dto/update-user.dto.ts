import { UserRole } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(500)
  photoUrl?: string;

  // Admin-only field; enforced in the service, not by the DTO.
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}
