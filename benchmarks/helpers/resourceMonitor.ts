import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { Resources, ResourceSample, ResourceState } from "../types.js";

export const unavailableState = (): ResourceState => ({ activeRequests: null, activeUpstreamExchanges: null,
  incomingSockets: null, upstreamBusySockets: null, upstreamIdleSockets: null,
  bufferedRequestBytes: null, bufferedResponseBytes: null });

/** Bounded, decimated sample history. Maxima include samples lost to decimation. */
export class ResourceMonitor {
  private readonly lag = monitorEventLoopDelay({ resolution: 20 });
  private timer: ReturnType<typeof setInterval>;
  private started = performance.now();
  private cpu = process.cpuUsage();
  private elu = performance.eventLoopUtilization();
  private samples: ResourceSample[] = [];
  private taken = 0;
  private peakRss = 0;
  private peakHeap = 0;
  private peakRead = 0;
  private peakWrite = 0;

  constructor(private readonly state = unavailableState, readonly intervalMs = 200) {
    if (!Number.isInteger(intervalMs) || intervalMs < 50 || intervalMs > 30_000) throw new Error("sample interval must be 50–30000 ms");
    this.lag.enable(); this.take();
    this.timer = setInterval(() => this.take(), intervalMs); this.timer.unref();
  }
  reset(): void {
    this.started = performance.now(); this.cpu = process.cpuUsage(); this.elu = performance.eventLoopUtilization();
    this.samples = []; this.taken = 0; this.peakRss = 0; this.peakHeap = 0; this.peakRead = 0; this.peakWrite = 0;
    this.lag.reset(); this.take();
  }
  private take(): void {
    const memory = process.memoryUsage();
    const sample = { elapsedMs: performance.now() - this.started, ...memory, ...this.state() };
    this.peakRss = Math.max(this.peakRss, sample.rss); this.peakHeap = Math.max(this.peakHeap, sample.heapUsed);
    this.peakRead = Math.max(this.peakRead, sample.bufferedRequestBytes ?? 0);
    this.peakWrite = Math.max(this.peakWrite, sample.bufferedResponseBytes ?? 0);
    if (this.samples.length >= 600) this.samples = this.samples.filter((_, index) => index % 2 === 0);
    this.samples.push(sample); this.taken++;
  }
  snapshot(): Resources {
    this.take();
    const cpu = process.cpuUsage(this.cpu), elapsed = performance.now() - this.started;
    const resources: Record<string, number> = {};
    for (const name of process.getActiveResourcesInfo()) resources[name] = (resources[name] ?? 0) + 1;
    const xMean = this.samples.reduce((sum, item) => sum + item.elapsedMs / 1000, 0) / this.samples.length;
    const yMean = this.samples.reduce((sum, item) => sum + item.heapUsed, 0) / this.samples.length;
    let numerator = 0, denominator = 0;
    for (const item of this.samples) {
      const x = item.elapsedMs / 1000 - xMean;
      numerator += x * (item.heapUsed - yMean); denominator += x * x;
    }
    const hasLag = this.lag.count > 0;
    return { samples: [...this.samples], samplesTaken: this.taken, sampleIntervalMs: this.intervalMs,
      peakRss: this.peakRss, peakHeapUsed: this.peakHeap, peakBufferedRequestBytes: this.peakRead, peakBufferedResponseBytes: this.peakWrite,
      cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
      cpuPercentOfOneCore: elapsed ? (cpu.user + cpu.system) / (elapsed * 10) : 0,
      eventLoopUtilization: performance.eventLoopUtilization(this.elu).utilization,
      eventLoopDelayMs: { mean: hasLag ? this.lag.mean / 1e6 : null, p99: hasLag ? this.lag.percentile(99) / 1e6 : null, max: hasLag ? this.lag.max / 1e6 : null },
      heapSlopeBytesPerSecond: denominator ? numerator / denominator : null,
      activeResourceTypes: resources, fileDescriptors: null };
  }
  close(): void { clearInterval(this.timer); this.lag.disable(); }
}
