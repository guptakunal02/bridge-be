import { ArgumentsHost, Catch } from '@nestjs/common';
import { BaseWsExceptionFilter } from '@nestjs/websockets';
import { PinoLogger } from 'nestjs-pino';

@Catch()
export class WsExceptionsFilter extends BaseWsExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    super();
    this.logger.setContext(WsExceptionsFilter.name);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const err =
      exception instanceof Error ? exception : new Error(String(exception));
    this.logger.warn({ err }, 'WS handler threw');
    super.catch(err, host);
  }
}
