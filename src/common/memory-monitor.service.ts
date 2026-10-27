import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { writeHeapSnapshot } from 'node:v8';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * High-frequency memory monitor + burst-triggered heap snapshot.
 *
 * Phase 1 (Oct 27) ran at 60s and we missed a burst that took memory
 * from 165 MB → 1.5 GB in 23 minutes between samples. OOM #8 fired
 * at 17:14 UTC. Current process has already hit VmHWM=1.36 GB in its
 * first 80 min but then dropped back to ~465 MB — we're catching a
 * burst mid-pulse, not a steady leak. Need two things:
 *
 *   1. 15-second sampling → never miss a burst longer than ~15s.
 *   2. Auto heap snapshot when RSS crosses HEAP_DUMP_THRESHOLD_MB
 *      → captures exact objects held during the burst for post-
 *      mortem analysis in Chrome DevTools.
 *
 * One snapshot per process lifecycle (DUMPS_PER_PROCESS = 1) because
 * writeHeapSnapshot blocks the event loop for several seconds; firing
 * repeatedly during a burst would make the symptom worse.
 *
 * Fields logged (all values in MB):
 *   rss          — total physical memory (kernel view, matches VmRSS)
 *   heapTotal    — V8 heap allocation ceiling
 *   heapUsed     — V8 heap in use
 *   external     — C++ allocations bound to JS (Node Buffers)
 *   arrayBuffers — subset of external, ArrayBuffer backing stores
 *   handles      — active async handles (sockets, timers, intervals).
 *                  Grows → something keeping work-in-flight. Common
 *                  cause of RSS bursts under broadcast / webhook load.
 *   requests     — pending async requests. Climbing → in-flight ops.
 */
@Injectable()
export class MemoryMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('MemoryMonitor');
  private timer: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();

  /** Dump a .heapsnapshot when RSS first crosses this. */
  private static readonly HEAP_DUMP_THRESHOLD_MB = 500;
  /** Hard cap on snapshots per process life (each ~hundreds of MB on disk). */
  private static readonly DUMPS_PER_PROCESS = 1;
  private static readonly DUMP_DIR = '/home/ubuntu/bridge-be/heap-dumps';

  private dumpsTaken = 0;

  onModuleInit(): void {
    // eslint-disable-next-line no-console
    console.log('[MemoryMonitor] onModuleInit fired (interval=15s, dump@500MB)');
    try {
      mkdirSync(MemoryMonitorService.DUMP_DIR, { recursive: true });
    } catch {
      // dir probably exists; writeHeapSnapshot will surface a real error if dir is unwritable
    }
    this.snapshot('boot');
    // 15s cadence — fine enough to catch the ~1-minute bursts we've
    // observed; cheap enough that the sampler itself is pure noise.
    this.timer = setInterval(() => this.snapshot('tick'), 15_000);
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
    const rssMb = toMB(m.rss);

    // Active handles / requests give us the "what is Node currently
    // waiting on" signal. These APIs are undocumented but stable since
    // Node 10. Count only — the identities would be useful but each
    // handle object stringifies large.
    //
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyProc = process as unknown as {
      _getActiveHandles?: () => unknown[];
      _getActiveRequests?: () => unknown[];
    };
    const handles = anyProc._getActiveHandles?.().length ?? -1;
    const requests = anyProc._getActiveRequests?.().length ?? -1;

    const line = `MEM-SNAPSHOT reason=${reason} uptime=${uptimeSec}s rss=${rssMb}MB heapTotal=${toMB(m.heapTotal)}MB heapUsed=${toMB(m.heapUsed)}MB external=${toMB(m.external)}MB arrayBuffers=${toMB(m.arrayBuffers)}MB handles=${handles} requests=${requests}`;
    this.logger.log(line);
    // eslint-disable-next-line no-console
    console.log(line);

    // Burst-triggered snapshot. Fires at most once per process.
    if (
      rssMb >= MemoryMonitorService.HEAP_DUMP_THRESHOLD_MB &&
      this.dumpsTaken < MemoryMonitorService.DUMPS_PER_PROCESS
    ) {
      this.takeHeapSnapshot(rssMb, uptimeSec);
    }
  }

  private takeHeapSnapshot(rssMb: number, uptimeSec: number): void {
    this.dumpsTaken++;
    const filename = join(
      MemoryMonitorService.DUMP_DIR,
      // Stable naming so grep in logs matches the file on disk.
      `burst-u${uptimeSec}s-rss${rssMb}mb.heapsnapshot`,
    );
    const marker = `MEM-SNAPSHOT burst-dump rss=${rssMb}MB file=${filename} — writing heap snapshot now (blocks event loop ~5s)`;
    this.logger.warn(marker);
    // eslint-disable-next-line no-console
    console.log(marker);
    try {
      // Synchronous and blocking. Expected cost: several seconds + a
      // 100-500 MB file written to DUMP_DIR. Admin opens in Chrome
      // DevTools → Memory → Load.
      writeHeapSnapshot(filename);
      const done = `MEM-SNAPSHOT burst-dump written file=${filename}`;
      this.logger.warn(done);
      // eslint-disable-next-line no-console
      console.log(done);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.log(`MEM-SNAPSHOT burst-dump FAILED: ${msg}`);
    }
  }
}
