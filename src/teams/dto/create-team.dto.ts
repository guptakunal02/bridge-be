import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateTeamDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
}
