/**
 * Bounded elapsed-time buckets. Each occupied bucket retains its latest
 * observation. When the elapsed range outgrows the budget, double the bucket
 * width and coalesce the existing buckets; never preferentially erase history.
 * Observations must be monotonic in time.
 */
export class TimeSeries<T extends { elapsedMs: number }> {
  private readonly bins = new Map<number, T>();
  private lastTime = -Infinity;
  constructor(private widthMs: number, private readonly maxBuckets = 256) {
    if (!Number.isFinite(widthMs) || widthMs <= 0 || !Number.isInteger(maxBuckets) || maxBuckets < 2) throw new Error("Invalid time-series budget");
  }
  add(point: T): void {
    if (!Number.isFinite(point.elapsedMs) || point.elapsedMs < 0 || point.elapsedMs < this.lastTime) throw new Error("Non-monotonic time-series observation");
    this.lastTime = point.elapsedMs;
    if (Math.floor(point.elapsedMs / this.widthMs) >= this.maxBuckets) {
      do { this.widthMs *= 2; } while (Math.floor(point.elapsedMs / this.widthMs) >= this.maxBuckets);
      const previous = this.values();
      this.bins.clear();
      for (const value of previous) this.bins.set(Math.floor(value.elapsedMs / this.widthMs), value);
    }
    this.bins.set(Math.floor(point.elapsedMs / this.widthMs), point);
  }
  values(): T[] { return [...this.bins.values()]; }
  clear(): void { this.bins.clear(); this.lastTime = -Infinity; }
}
