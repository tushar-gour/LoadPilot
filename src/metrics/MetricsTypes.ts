import type { HealthState } from "../health/HealthCheck.js";

export interface MetricsOptions {
  /** Collect request and health statistics; disabled by default. */
  enabled?: boolean;
}

export interface RequestCounters {
  readonly total: number;
  readonly active: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly clientCancelled: number;
  readonly shutdownCancelled: number;
  readonly routeNotFound: number;
  readonly noEligibleBackend: number;
  readonly invalidTarget: number;
  readonly upstreamFailures: number;
  readonly upstreamTimeouts: number;
  readonly internalErrors: number;
  /** Completed local 503 rejections observed after admission closed. */
  readonly drainingRejections: number;
}

export interface StatusCounters {
  readonly status1xx: number;
  readonly status2xx: number;
  readonly status3xx: number;
  readonly status4xx: number;
  readonly status5xx: number;
}

export interface ResponseMetrics extends StatusCounters {
  /** ServerResponse finish events, including fully written proxy error responses. */
  readonly completed: number;
  readonly incomplete: number;
  readonly backend: StatusCounters;
  readonly loadPilot: StatusCounters;
}

export interface LatencySummary {
  readonly count: number;
  readonly totalMs: number;
  readonly averageMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  /** Upper-bucket estimates clamped to observed min/max; overflow uses max. */
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  /** null denotes the overflow bucket, keeping snapshots JSON-safe. */
  readonly buckets: readonly Readonly<{ upperBoundMs: number | null; count: number }>[];
}

export interface HealthProbeMetrics {
  readonly successfulProbes: number;
  readonly failedProbes: number;
  /** A subset of failedProbes. Cancelled probes have no outcome. */
  readonly timeoutProbes: number;
  readonly healthyTransitions: number;
  readonly unhealthyTransitions: number;
  readonly unknownTransitions: number;
  /** Unix epoch milliseconds, unlike monotonic duration measurements. */
  readonly lastProbeAt: number | null;
  readonly lastStateChangeAt: number | null;
}

export interface BackendHealthMetrics extends HealthProbeMetrics {
  readonly state: HealthState;
}

export interface AggregateMetrics {
  readonly requests: RequestCounters;
  readonly responses: ResponseMetrics;
  /** Incoming handler entry through downstream finish/close, including failures. */
  readonly latency: LatencySummary;
  /** Upstream dispatch through response headers; not backend processing time. */
  readonly upstreamHeadersLatency: LatencySummary;
}

export interface BackendMetrics extends AggregateMetrics {
  /** Stable per-pool registration identity; re-add after final removal gets a new ID. */
  readonly id: number;
  readonly baseUrl: string;
  readonly registered: boolean;
  readonly registrations: number;
  /** Removed in-flight backends have no current health record. */
  readonly health: BackendHealthMetrics | null;
}

export interface PoolMetrics extends AggregateMetrics {
  readonly route: string;
  readonly eligibility: Readonly<{
    registered: number; registrations: number; unknown: number;
    healthy: number; unhealthy: number; eligible: number;
  }>;
  readonly health: HealthProbeMetrics & Readonly<{ enabled: boolean; collecting: boolean }>;
  readonly backends: readonly BackendMetrics[];
}

export interface LoadPilotMetrics extends AggregateMetrics {
  readonly name: string;
  readonly enabled: boolean;
  /** Cumulative bound-listener running time; downtime is excluded. */
  readonly uptimeMs: number;
  readonly instrumentationErrors: number;
  readonly pools: readonly PoolMetrics[];
}
