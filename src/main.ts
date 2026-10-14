import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express from 'express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { REQUEST_ID_HEADER } from './common/logger/logger.module';
import { EnvVars } from './config/env.validation';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const config = app.get<ConfigService<EnvVars, true>>(ConfigService);

  app.use(cookieParser());
  app.set('trust proxy', 1);

  // Capture the raw request body on JSON POSTs so webhook signature
  // guards (currently just WhatsApp) can HMAC-verify against the
  // exact bytes Meta signed. Nest's default body parser only exposes
  // the parsed JSON, which can serialise back to a slightly different
  // byte sequence than the sender produced.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as { rawBody?: Buffer }).rawBody = buf;
      },
      limit: '2mb',
    }),
  );

  app.enableCors({
    origin: config.get('FRONTEND_ORIGIN', { infer: true }),
    credentials: true,
    exposedHeaders: [REQUEST_ID_HEADER],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
}

void bootstrap();
