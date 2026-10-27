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
  // guards (WhatsApp, Shopify) can HMAC-verify against the exact bytes
  // the sender signed. Nest's default body parser only exposes the
  // parsed JSON, which can serialise back to a slightly different
  // byte sequence than the sender produced.
  //
  // IMPORTANT: the attached Buffer is OFF-HEAP (Node Buffers live in
  // `external` memory, not the V8 heap). V8's GC only runs aggressively
  // when the heap is pressured — with --max-old-space-size=1024 the heap
  // sits well below its ceiling, so GC pauses are rare and off-heap
  // Buffers accumulate silently. Over ~50min of normal webhook traffic
  // this grew the process RSS to 1.33 GB and the kernel OOM-killed
  // pm2-ubuntu.service (restart counter at 6 before we traced it).
  //
  // Fix: release rawBody the moment the response completes. The guard
  // phase runs long before this, so HMAC verify still has the bytes.
  // Belt-and-braces: also listen for 'close' to catch client disconnects.
  app.use(
    express.json({
      verify: (req, res, buf) => {
        (req as { rawBody?: Buffer }).rawBody = buf;
        const release = () => {
          (req as { rawBody?: Buffer }).rawBody = undefined;
        };
        res.on('finish', release);
        res.on('close', release);
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
