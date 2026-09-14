import { IsBoolean, IsUUID } from 'class-validator';

export class AddMemberDto {
  @IsUUID()
  userId!: string;
}

export class SetMemberPauseDto {
  @IsBoolean()
  pausedInTeam!: boolean;
}
