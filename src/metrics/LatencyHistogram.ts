import type { LatencySummary } from "./MetricsTypes.js";

const boundsMs = Object.freeze([
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000,
  120_000, 300_000, 600_000, 1_800_000, 3_600_000,
]);

/** Internal fixed-size distribution, exported from this module only for focused tests. */
export class LatencyHistogram {
  private readonly counts = new Array<number>(boundsMs.length + 1).fill(0);
  private count = 0;
  private total = 0;
  private min = Infinity;
  private max = 0;

  record(milliseconds: number): void {
    if (Number.isNaN(milliseconds)) return;
    const duration = Math.max(
      0,
      Math.min(Number.MAX_SAFE_INTEGER, milliseconds),
    );
    let low = 0;
    let high = boundsMs.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (duration <= boundsMs[middle]) high = middle;
      else low = middle + 1;
    }
    this.counts[low]++;
    this.count++;
    this.total += duration;
    this.min = Math.min(this.min, duration);
    this.max = Math.max(this.max, duration);
  }

  snapshot(): LatencySummary {
    const percentile = (fraction: number): number => {
      if (!this.count) return 0;
      const rank = Math.ceil(fraction * this.count);
      let accumulated = 0;
      for (let index = 0; index < this.counts.length; index++) {
        accumulated += this.counts[index];
        if (accumulated >= rank)
          return Math.max(
            this.min,
            Math.min(boundsMs[index] ?? this.max, this.max),
          );
      }
      return this.max;
    };
    return Object.freeze({
      count: this.count,
      totalMs: this.total,
      averageMs: this.count ? this.total / this.count : 0,
      minMs: this.count ? this.min : 0,
      maxMs: this.max,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      buckets: Object.freeze(
        this.counts.map((count, index) =>
          Object.freeze({ upperBoundMs: boundsMs[index] ?? null, count }),
        ),
      ),
    });
  }
}
