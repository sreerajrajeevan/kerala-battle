/**
 * Task 11: in-process metrics.
 *
 * Counters, gauges, and timing summaries kept in memory on this single
 * application instance. No Prometheus infrastructure: GET /internal/metrics
 * returns a JSON snapshot for operators. Never record player names or
 * personal data here — only aggregate counts and timings.
 */

export interface TimingSummary {
  count: number;
  sumMs: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
}

interface TimingBucket {
  count: number;
  sum: number;
  min: number;
  max: number;
}

const MAX_EVENT_LOOP_SAMPLES = 240; // 2 minutes at 500ms

export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private timings = new Map<string, TimingBucket>();
  private eventLoopSamples: number[] = [];
  private eventLoopTimer: NodeJS.Timeout | null = null;

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  set(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  /** Record a duration in milliseconds. */
  observe(name: string, ms: number): void {
    let bucket = this.timings.get(name);
    if (!bucket) {
      bucket = { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: 0 };
      this.timings.set(name, bucket);
    }
    bucket.count += 1;
    bucket.sum += ms;
    bucket.min = Math.min(bucket.min, ms);
    bucket.max = Math.max(bucket.max, ms);
  }

  /** Start the background event-loop lag sampler (500ms cadence). */
  startEventLoopSampler(): void {
    if (this.eventLoopTimer) return;
    let last = Date.now();
    this.eventLoopTimer = setInterval(() => {
      const now = Date.now();
      const lag = Math.max(0, now - last - 500);
      last = now;
      this.eventLoopSamples.push(lag);
      if (this.eventLoopSamples.length > MAX_EVENT_LOOP_SAMPLES) {
        this.eventLoopSamples.shift();
      }
    }, 500);
    this.eventLoopTimer.unref?.();
  }

  stopEventLoopSampler(): void {
    if (this.eventLoopTimer) clearInterval(this.eventLoopTimer);
    this.eventLoopTimer = null;
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[index];
  }

  eventLoopLagStats(): { samples: number; p50Ms: number; p95Ms: number; maxMs: number } {
    const sorted = [...this.eventLoopSamples].sort((a, b) => a - b);
    return {
      samples: sorted.length,
      p50Ms: this.percentile(sorted, 50),
      p95Ms: this.percentile(sorted, 95),
      maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
    };
  }

  /** Aggregate snapshot for /internal/metrics. No personal data. */
  snapshot(): Record<string, unknown> {
    const counters: Record<string, number> = {};
    for (const [k, v] of this.counters) counters[k] = v;
    const gauges: Record<string, number> = {};
    for (const [k, v] of this.gauges) gauges[k] = v;
    const timings: Record<string, TimingSummary> = {};
    for (const [k, b] of this.timings) {
      timings[k] = {
        count: b.count,
        sumMs: Math.round(b.sum * 100) / 100,
        minMs: Math.round(b.min * 100) / 100,
        maxMs: Math.round(b.max * 100) / 100,
        avgMs: b.count > 0 ? Math.round((b.sum / b.count) * 100) / 100 : 0,
      };
    }
    const memory = process.memoryUsage();
    return {
      ts: new Date().toISOString(),
      counters,
      gauges: {
        ...gauges,
        'memory.rssMB': Math.round((memory.rss / 1024 / 1024) * 10) / 10,
        'memory.heapUsedMB': Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10,
      },
      timings,
      eventLoopLag: this.eventLoopLagStats(),
      uptimeSec: Math.round(process.uptime()),
    };
  }
}

/** Process-wide metrics instance. */
export const metrics = new Metrics();
