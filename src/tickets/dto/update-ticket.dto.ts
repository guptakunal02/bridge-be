import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { TicketStatus } from '../../database/enums';

export class UpdateTicketDto {
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @IsOptional()
  @IsUUID()
  assigneeId?: string;
}
