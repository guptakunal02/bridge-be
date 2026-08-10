import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { EnvVars } from '../../config/env.validation';
import { NodeEnv } from '../../config/env.validation';

export const REQUEST_ID_HEADER = 'x-request-id';

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) => {
        const nodeEnv = config.get('NODE_ENV', { infer: true });
        const isProd = nodeEnv === NodeEnv.Production;

        return {
          pinoHttp: {
            level: isProd ? 'info' : 'debug',
            genReqId: (req: IncomingMessage, res: ServerResponse) => {
              const incoming = req.headers[REQUEST_ID_HEADER];
              const id =
                typeof incoming === 'string' && incoming.length > 0
                  ? incoming
                  : randomUUID();
              res.setHeader(REQUEST_ID_HEADER, id);
              return id;
            },
            customProps: () => ({ context: 'HTTP' }),
            autoLogging: {
              ignore: (req) => req.url === '/health',
            },
            customSuccessMessage: (req, res, responseTime) =>
              `${req.method ?? '-'} ${req.url ?? '-'} ${res.statusCode} (${responseTime}ms)`,
            customErrorMessage: (req, res, err) =>
              `${req.method ?? '-'} ${req.url ?? '-'} ${res.statusCode} ${err.message}`,
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
              ],
              censor: '[redacted]',
            },
            transport: isProd
              ? undefined
              : {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    colorize: true,
                    translateTime: 'SYS:HH:MM:ss.l',
                    ignore: 'pid,hostname,req,res,responseTime,reqId,context',
                    messageFormat: '[{context}] {msg}',
                  },
                },
          },
        };
      },
    }),
  ],
})
export class LoggerModule {}
