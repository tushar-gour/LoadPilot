import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { getHeapStatistics, getHeapSpaceStatistics, getHeapCodeStatistics } from "node:v8";
import type { Resources, ResourceSample, ResourceState } from "../types.js";
import { TimeSeries } from "./timeSeries.js";

export const unavailableState = (): ResourceState => ({ activeRequests: null, activeUpstreamExchanges: null,
  incomingSockets: null, upstreamBusySockets: null, upstreamIdleSockets: null,
  bufferedRequestBytes: null, bufferedResponseBytes: null, agentPendingRequests: null, acceptedConnections: null, upstreamConnectionsCreated: null });

/** Checkpoint only: these V8 categories do not account for all native memory. */
export function heapDiagnostics() {
  const heap = getHeapStatistics();
  const code = getHeapCodeStatistics();
  return { used: heap.used_heap_size, total: heap.total_heap_size, limit: heap.heap_size_limit,
    available: heap.total_available_size, external: heap.external_memory, malloced: heap.malloced_memory,
    peakMalloced: heap.peak_malloced_memory, codeAndMetadata: code.code_and_metadata_size, bytecodeAndMetadata: code.bytecode_and_metadata_size,
    spaces: getHeapSpaceStatistics().map((space) => ({ name: space.space_name,
      used: space.space_used_size, size: space.space_size, physical: space.physical_space_size })) };
}

/** Bounded, decimated sample history. Maxima include samples lost to decimation. */
export class ResourceMonitor {
  private readonly lag = monitorEventLoopDelay({ resolution: 20 });
  private timer: ReturnType<typeof setInterval>;
  private started = performance.now();
  private cpu = process.cpuUsage();
  private elu = performance.eventLoopUtilization();
  private samples: TimeSeries<ResourceSample>;
  private taken = 0;
  private peakRss = 0;
  private peakHeap = 0;
  private peakExternal = 0;
  private peakArrayBuffers = 0;
  private peakRead = 0;
  private peakWrite = 0;

  constructor(private readonly state = unavailableState, readonly intervalMs = 200) {
    if (!Number.isInteger(intervalMs) || intervalMs < 50 || intervalMs > 30_000) throw new Error("sample interval must be 50–30000 ms");
    this.samples = new TimeSeries<ResourceSample>(intervalMs, 600);
    this.lag.enable(); this.take();
    this.timer = setInterval(() => this.take(), intervalMs); this.timer.unref();
  }
  reset(): void {
    this.started = performance.now(); this.cpu = process.cpuUsage(); this.elu = performance.eventLoopUtilization();
    this.samples = new TimeSeries<ResourceSample>(this.intervalMs, 600); this.taken = 0; this.peakRss = 0; this.peakHeap = 0; this.peakRead = 0; this.peakWrite = 0;
    this.peakExternal = 0; this.peakArrayBuffers = 0;
    this.lag.reset(); this.take();
  }
  private take(): void {
    const memory = process.memoryUsage();
    const sample = { elapsedMs: performance.now() - this.started, ...memory, ...this.state() };
    this.peakRss = Math.max(this.peakRss, sample.rss); this.peakHeap = Math.max(this.peakHeap, sample.heapUsed);
    this.peakExternal = Math.max(this.peakExternal, sample.external); this.peakArrayBuffers = Math.max(this.peakArrayBuffers, sample.arrayBuffers);
    this.peakRead = Math.max(this.peakRead, sample.bufferedRequestBytes ?? 0);
    this.peakWrite = Math.max(this.peakWrite, sample.bufferedResponseBytes ?? 0);
    this.samples.add(sample); this.taken++;
  }
  snapshot(): Resources {
    this.take();
    const cpu = process.cpuUsage(this.cpu), elapsed = performance.now() - this.started;
    const resources: Record<string, number> = {};
    for (const name of process.getActiveResourcesInfo()) resources[name] = (resources[name] ?? 0) + 1;
    const samples = this.samples.values();
    const xMean = samples.reduce((sum, item) => sum + item.elapsedMs / 1000, 0) / samples.length;
    const yMean = samples.reduce((sum, item) => sum + item.heapUsed, 0) / samples.length;
    let numerator = 0, denominator = 0;
    for (const item of samples) {
      const x = item.elapsedMs / 1000 - xMean;
      numerator += x * (item.heapUsed - yMean); denominator += x * x;
    }
    const hasLag = this.lag.count > 0;
    return { samples, samplesTaken: this.taken, sampleIntervalMs: this.intervalMs,
      peakRss: this.peakRss, peakHeapUsed: this.peakHeap, peakBufferedRequestBytes: this.peakRead, peakBufferedResponseBytes: this.peakWrite,
      peakExternal: this.peakExternal, peakArrayBuffers: this.peakArrayBuffers,
      cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
      cpuPercentOfOneCore: elapsed ? (cpu.user + cpu.system) / (elapsed * 10) : 0,
      eventLoopUtilization: performance.eventLoopUtilization(this.elu).utilization,
      eventLoopDelayMs: { mean: hasLag ? this.lag.mean / 1e6 : null, p99: hasLag ? this.lag.percentile(99) / 1e6 : null, max: hasLag ? this.lag.max / 1e6 : null },
      heapSlopeBytesPerSecond: denominator ? numerator / denominator : null,
      activeResourceTypes: resources, fileDescriptors: null };
  }
  close(): void { clearInterval(this.timer); this.lag.disable(); }
}
