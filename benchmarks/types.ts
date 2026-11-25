import type { Algorithm, LoadPilotMetrics } from "../src/index.js";

export interface LoadOptions {
  targets: string[];
  concurrency: number;
  durationMs: number;
  requests?: number;
  method?: string;
  payloadBytes?: number;
  jsonBody?: boolean;
  expectedStatus?: number;
  expectedStatuses?: number[];
  expectedBytes?: number;
  expectedHash?: string;
  validateUpload?: boolean;
  uploadHash?: string;
  timeoutMs?: number;
  keepAlive?: boolean;
  rate?: number;
  slowReadMs?: number;
  cancel?: "before-response" | "upload" | "response";
}

export interface Distribution {
  count: number; average: number; min: number; max: number;
  p50: number; p95: number; p99: number; buckets: number[];
}

export interface LoadResult {
  attempted: number; completed: number; failed: number; timedOut: number; cancelled: number;
  elapsedMs: number; issuingMs: number; requestsPerSecond: number;
  attemptedPerSecond: number;
  scheduleLatencyMs: Distribution; headersLatencyMs: Distribution;
  peakConcurrency: number; reusedSockets: number; newSockets: number;
  statuses: Record<string, number>; errors: Record<string, number>; backends: Record<string, number>;
  latencyMs: Distribution; schedulingDelayMs: Distribution;
  scheduled: number; missedArrivals: number; clientLimited: boolean;
  missedScheduling: number; missedConcurrency: number;
  bytesReceived: number; uploadBackpressureEvents: number;
}

export interface ResourceState {
  activeRequests: number | null; activeUpstreamExchanges: number | null;
  incomingSockets: number | null; upstreamBusySockets: number | null; upstreamIdleSockets: number | null;
  bufferedRequestBytes: number | null; bufferedResponseBytes: number | null;
  agentPendingRequests: number | null; acceptedConnections: number | null; upstreamConnectionsCreated: number | null;
}

export interface ResourceSample extends ResourceState {
  elapsedMs: number; rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number;
}

export interface Resources {
  samples: ResourceSample[]; samplesTaken: number; sampleIntervalMs: number;
  peakRss: number; peakHeapUsed: number; peakBufferedRequestBytes: number; peakBufferedResponseBytes: number;
  peakExternal: number; peakArrayBuffers: number;
  cpuUserMs: number; cpuSystemMs: number; cpuPercentOfOneCore: number;
  eventLoopUtilization: number;
  eventLoopDelayMs: { mean: number | null; p99: number | null; max: number | null };
  heapSlopeBytesPerSecond: number | null;
  activeResourceTypes: Record<string, number>; fileDescriptors: null;
}

export interface BackendStats {
  applicationRequests: number; healthProbes: number; completed: number; aborted: number;
  active: number; sockets: number; bytesRead: number; bytesWritten: number;
  blockedWrites: number; slowReads: number; routes: Record<string, number>;
  activeHealthProbes: number;
  unexpectedErrors: number;
}

export interface WorkerInfo { url?: string; port?: number; role: "backend" | "proxy" | "client" }
export interface WorkerConfig {
  role: WorkerInfo["role"]; id?: string; port?: number;
  pools?: { route: string; urls: string[]; algorithm?: Algorithm; weights?: number[] }[];
  applicationDelayMs?: number;
  metrics?: boolean; health?: boolean; upstreamTimeoutMs?: number; sampleMs?: number; upstreamKeepAlive?: boolean;
}

export interface ProxySnapshot { metrics: LoadPilotMetrics; resources: Resources }
export interface FaultResult { name: string; passed: boolean; details: string; durationMs: number }
export interface BenchmarkRow {
  scenario: string; mode: "direct" | "proxy" | "metrics"; concurrency: number; repetition: number;
  payloadBytes: number; method: string; warmupMs: number; durationMs: number; healthEnabled: boolean;
  metricsEnabled: boolean; upstreamTimeoutMs: number | null;
  result: LoadResult; resources: { client: Resources; proxy: Resources | null; backends: Resources[] };
  backendCounts: BackendStats[]; metrics: LoadPilotMetrics | null; passed: boolean;
  metricsRequestDelta: number | null;
}

export interface BenchmarkReport {
  schemaVersion: 1; scenario: string; timestamp: string;
  environment: { node: string; platform: string; osRelease: string; cpu: string; logicalCpus: number; totalRamBytes: number;
    gitCommit: string; workingTreeDirty: boolean; gcExposed: boolean };
  configuration: Record<string, unknown>;
  rows: BenchmarkRow[]; faults: FaultResult[];
  soak: { mode: string; cycles: number; actualDurationMs: number; initial: Resources; final: Resources;
    settled: boolean; workloads: string[]; postStop: ResourceState; settledSamples: ResourceSample[]; diagnostics?: DiagnosticCheckpoint[];
    requests?: { attempted: number; completed: number; failed: number; cancelled: number; latencyMs: Distribution } }[];
  limitations: string[]; passed: boolean;
  executionStatus?: "running" | "completed" | "failed" | "interrupted";
  memory?: MemoryRun[]; capacity?: CapacityRun[];
}

export interface DiagnosticCheckpoint {
  label: string; elapsedMs: number; sample: ResourceSample;
  healthStates?: string[];
  heap: { used: number; total: number; limit: number; available: number; external: number;
    malloced: number; peakMalloced: number; codeAndMetadata: number; bytecodeAndMetadata: number;
    spaces: { name: string; used: number; size: number; physical: number }[] };
  rssMinusHeapTotal: number; resources: Record<string, number>;
  listeners: Record<string, number>; metricScopes: { active: number; retiredActive: number; currentBackends: number } | null;
}
export interface MemoryTrend {
  fullRssBytesPerSecond: number | null; fullHeapBytesPerSecond: number | null; fullExternalBytesPerSecond: number | null;
  earlyRssBytesPerSecond: number | null; earlyHeapBytesPerSecond: number | null; earlyExternalBytesPerSecond: number | null;
  rssBytesPerSecond: number | null; lateRssBytesPerSecond: number | null;
  heapBytesPerSecond: number | null; lateHeapBytesPerSecond: number | null;
  externalBytesPerSecond: number | null; lateExternalBytesPerSecond: number | null;
  rssBytesPerCompletedRequest: number | null;
  classification: "No concerning growth observed" | "Likely warmup or allocator retention" | "Suspicious retained growth" | "Inconclusive";
  reason: string;
}
export interface MemoryRun {
  scenario: string; metricsEnabled: boolean; healthEnabled: boolean; keepAlive: boolean;
  configuredDurationMs: number; actualLoadMs: number; actualTotalMs: number; batches: number;
  attempted: number; completed: number; failed: number; cancelled: number; upstreamTimeouts: number | null;
  latencyMs: Distribution; checkpoints: DiagnosticCheckpoint[]; resources: Resources;
  clientResources: Resources; backendResources: Resources[]; backendStats: BackendStats[];
  trend: MemoryTrend; postStop: ResourceState; passed: boolean;
  metrics?: LoadPilotMetrics;
}
export interface Slo {
  p95Ms: number; p99Ms: number; maxErrorRate: number; arrivalTolerance: number; completionTolerance: number;
}
export interface CapacityDecision { passed: boolean; classification: "passing" | "client-limited" | "SLO-failed" | "inconclusive"; reasons: string[] }
export interface CapacityRun {
  profile: string; mode: "direct" | "proxy" | "metrics" | "health"; repetition: number;
  offeredRate: number; durationMs: number; concurrency: number; result: LoadResult;
  backendRequests?: number;
  resources: BenchmarkRow["resources"]; http5xx: number; upstreamTimeouts: number | null;
  decision: CapacityDecision;
}
