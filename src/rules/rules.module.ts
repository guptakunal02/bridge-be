import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Team } from '../teams/entities/team.entity';
import { RoutingRule } from './entities/routing-rule.entity';
import { RoutingService } from './routing.service';
import { RuleEvaluatorService } from './rule-evaluator.service';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';

@Module({
  imports: [TypeOrmModule.forFeature([RoutingRule, Team])],
  controllers: [RulesController],
  providers: [RulesService, RuleEvaluatorService, RoutingService],
  // RoutingService is what EmailInboxService consumes at ingest time.
  exports: [RoutingService, RuleEvaluatorService],
})
export class RulesModule {}
