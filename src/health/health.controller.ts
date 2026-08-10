import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
      () => this.processCheck(),
    ]);
  }

  private processCheck(): HealthIndicatorResult {
    return {
      process: {
        status: 'up',
        uptimeSeconds: Math.floor(process.uptime()),
        pid: process.pid,
      },
    };
  }
}
