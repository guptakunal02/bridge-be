import { IsEnum } from 'class-validator';
import { UserStatus } from '../../database/enums';

export class SetStatusDto {
  @IsEnum(UserStatus)
  status!: UserStatus;
}
