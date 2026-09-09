import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { DataSource } from 'typeorm';
import { Public } from '../auth/decorators/public.decorator';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly dataSource: DataSource,
  ) {}

  @Public()
  @Get()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.databaseCheck(),
      () => this.processCheck(),
    ]);
  }

  // Simple `SELECT 1` round-trip against the primary datasource. Throws
  // if the connection is down — Terminus converts the throw into a 503
  // with `database: { status: 'down' }`.
  private async databaseCheck(): Promise<HealthIndicatorResult> {
    await this.dataSource.query('SELECT 1');
    return { database: { status: 'up' } };
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
