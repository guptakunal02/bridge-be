import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

/**
 * Periodic memory monitor. Logs every 60 seconds so we can trend each
 * component of the process memory profile and figure out WHICH bucket
 * is leaking.
 *
 *   rss          — total physical memory (what the kernel sees).
 *                  Grows with any leak: heap, external, or ArrayBuffers.
 *   heapTotal    — V8 heap allocation ceiling at this moment.
 *   heapUsed     — V8 heap in use. Grows → V8-level leak (objects not
 *                  released). Catches most "typical" JS leaks.
 *   external     — C++ allocations bound to JS. **Node Buffers live
 *                  here.** Grows → off-heap leak. The rawBody fix
 *                  targeted this. If it's STILL climbing, there's
 *                  another off-heap retainer.
 *   arrayBuffers — Subset of external for ArrayBuffer backing stores.
 *                  Specific subset of off-heap. If climbing → someone
 *                  is holding ArrayBuffers (streams, TypedArrays).
 *
 * To correlate with a specific subsystem, grep bridge-be-out.log for
 * `MEM-SNAPSHOT`. Each line is self-contained with uptime so you can
 * compute per-minute growth rate per bucket.
 *
 * Costs ~zero: `process.memoryUsage()` is a single syscall + object
 * allocation; running once a minute is noise.
 */
@Injectable()
export class MemoryMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('MemoryMonitor');
  private timer: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();

  onModuleInit(): void {
    // Diagnostic: dual-path. If the Nest Logger isn't fully wired to
    // pino at module-init time, our snapshots would silently vanish.
    // console.log goes to stdout which pm2 captures directly — if we
    // see this but not the Logger line, we know the issue is pino
    // routing, not instantiation.
    // eslint-disable-next-line no-console
    console.log('[MemoryMonitor] onModuleInit fired');
    // Fire once at boot so we have a baseline, then every 60s.
    this.snapshot('boot');
    this.timer = setInterval(() => this.snapshot('tick'), 60_000);
    // Don't let the sampler block process exit.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private snapshot(reason: 'boot' | 'tick'): void {
    const m = process.memoryUsage();
    const toMB = (b: number): number => Math.round(b / 1024 / 1024);
    const uptimeSec = Math.round((Date.now() - this.startedAt) / 1000);
    const line = `MEM-SNAPSHOT reason=${reason} uptime=${uptimeSec}s rss=${toMB(m.rss)}MB heapTotal=${toMB(m.heapTotal)}MB heapUsed=${toMB(m.heapUsed)}MB external=${toMB(m.external)}MB arrayBuffers=${toMB(m.arrayBuffers)}MB`;
    this.logger.log(line);
    // Belt-and-braces: also write to stdout directly so pm2 captures
    // it even if pino isn't picking up this Logger instance for some
    // reason. If both appear, we can delete the console path later.
    // eslint-disable-next-line no-console
    console.log(line);
  }
}
