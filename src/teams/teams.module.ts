import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ticket } from '../tickets/entities/ticket.entity';
import { User } from '../users/entities/user.entity';
import { TeamMember } from './entities/team-member.entity';
import { Team } from './entities/team.entity';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';

@Module({
  // Ticket entity registered here so TeamsService can compute
  // per-member open-ticket counts without pulling in TicketsModule
  // (which would create a cycle via BotModule).
  imports: [TypeOrmModule.forFeature([Team, TeamMember, User, Ticket])],
  controllers: [TeamsController],
  providers: [TeamsService],
  exports: [TeamsService],
})
export class TeamsModule {}
