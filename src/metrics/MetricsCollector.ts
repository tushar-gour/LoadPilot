import type { ServerResponse } from "node:http";
import { HealthState } from "../health/HealthCheck.js";
import type { ServerPool, BackendRegistration } from "../server/ServerPool.js";
import type { Server } from "../server/Server.js";
import type { ProxyEvent, ProxyObserver } from "../proxy/HttpProxy.js";
import type {
  AggregateMetrics,
  BackendMetrics,
  LatencySummary,
  LoadPilotMetrics,
  MetricsOptions,
  PoolMetrics,
  RequestCounters,
  StatusCounters,
} from "./MetricsTypes.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Outcome = "completed" | "failed" | "cancelled";
type Reason =
  | "clientCancelled"
  | "shutdownCancelled"
  | "routeNotFound"
  | "noEligibleBackend"
  | "invalidTarget"
  | "upstreamFailures"
  | "upstreamTimeouts"
  | "internalErrors"
  | "drainingRejections";

export type RequestMetricEvent =
  | ProxyEvent
  | { type: "pool"; pool: ServerPool }
  | { type: "selected"; server: Server }
  | {
      type: "rejected";
      reason:
        | "routeNotFound"
        | "noEligibleBackend"
        | "invalidTarget"
        | "internalErrors"
        | "drainingRejections";
    };

export type RequestObserver = (event: RequestMetricEvent) => void;

export function resolveMetrics(
  options?: MetricsOptions,
): Readonly<Required<MetricsOptions>> {
  if (
    options !== undefined &&
    (typeof options !== "object" || options === null || Array.isArray(options))
  ) {
    throw new Error("metrics must be a configuration object.");
  }
  const enabled = options?.enabled === undefined ? false : options.enabled;
  if (typeof enabled !== "boolean")
    throw new Error("metrics.enabled must be a boolean.");
  return Object.freeze({ enabled });
}

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

function statusCounters(): Mutable<StatusCounters> {
  return {
    status1xx: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
  };
}

function statusCategory(status: number): keyof StatusCounters | undefined {
  switch (Math.floor(status / 100)) {
    case 1:
      return "status1xx";
    case 2:
      return "status2xx";
    case 3:
      return "status3xx";
    case 4:
      return "status4xx";
    case 5:
      return "status5xx";
    default:
      return undefined;
  }
}

class Group {
  readonly requests: Mutable<RequestCounters> = {
    total: 0,
    active: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    clientCancelled: 0,
    shutdownCancelled: 0,
    routeNotFound: 0,
    noEligibleBackend: 0,
    invalidTarget: 0,
    upstreamFailures: 0,
    upstreamTimeouts: 0,
    internalErrors: 0,
    drainingRejections: 0,
  };
  private readonly status = statusCounters();
  private readonly backendStatus = statusCounters();
  private readonly localStatus = statusCounters();
  private responsesCompleted = 0;
  private responsesIncomplete = 0;
  readonly latency = new LatencyHistogram();
  readonly headersLatency = new LatencyHistogram();

  begin(): void {
    this.requests.total++;
    this.requests.active++;
  }

  settle(
    outcome: Outcome,
    reason: Reason | undefined,
    complete: boolean,
    origin: "backend" | "loadPilot",
    status: number,
    duration: number,
  ): void {
    this.requests.active--;
    this.requests[outcome]++;
    if (reason) this.requests[reason]++;
    if (!complete) this.responsesIncomplete++;
    else {
      this.responsesCompleted++;
      const category = statusCategory(status);
      if (category) {
        this.status[category]++;
        (origin === "backend" ? this.backendStatus : this.localStatus)[
          category
        ]++;
      }
    }
    this.latency.record(duration);
  }

  snapshot(): AggregateMetrics {
    return Object.freeze({
      requests: Object.freeze({ ...this.requests }),
      responses: Object.freeze({
        ...this.status,
        completed: this.responsesCompleted,
        incomplete: this.responsesIncomplete,
        backend: Object.freeze({ ...this.backendStatus }),
        loadPilot: Object.freeze({ ...this.localStatus }),
      }),
      latency: this.latency.snapshot(),
      upstreamHeadersLatency: this.headersLatency.snapshot(),
    });
  }
}

class BackendGroup extends Group {
  constructor(readonly registration: BackendRegistration) {
    super();
  }
}

class PoolGroup extends Group {
  readonly backends = new WeakMap<BackendRegistration, BackendGroup>();
  readonly activeBackends = new Set<BackendGroup>();

  backend(registration: BackendRegistration): BackendGroup {
    let group = this.backends.get(registration);
    if (!group) {
      group = new BackendGroup(registration);
      this.backends.set(registration, group);
    }
    return group;
  }
}

/** Per-instance aggregation. No timers, network work or routing/health decisions. */
export class MetricsCollector {
  readonly root = new Group();
  readonly pools = new Map<ServerPool, PoolGroup>();
  readonly active = new Set<RequestScope>();
  instrumentationErrors = 0;
  private runningSince: number | undefined;
  private uptime = 0;

  constructor(
    private readonly name: string,
    readonly enabled: boolean,
  ) {}

  registerPool(pool: ServerPool): void {
    this.pools.set(pool, new PoolGroup());
    if (this.enabled) pool.enableHealthMetrics();
  }

  started(): void {
    if (this.runningSince === undefined) this.runningSince = performance.now();
  }
  stopped(): void {
    // Node may resolve server.close before delivering each destroyed response's
    // close event. Networking is stopped; finish those cancelled scopes now.
    for (const scope of this.active) scope.completeShutdown();
    if (this.runningSince !== undefined)
      this.uptime += performance.now() - this.runningSince;
    this.runningSince = undefined;
  }

  begin(res: ServerResponse): RequestObserver | undefined {
    if (!this.enabled) return undefined;
    try {
      const scope = new RequestScope(this, res);
      this.active.add(scope);
      return scope.observe;
    } catch {
      // Isolate only instrumentation setup; no networking runs in this block.
      this.instrumentationErrors++;
      return undefined;
    }
  }

  shutdown(): void {
    for (const scope of this.active)
      scope.observe({ type: "cancelled", reason: "shutdown" });
  }

  snapshot(): LoadPilotMetrics {
    return Object.freeze({
      ...this.root.snapshot(),
      name: this.name,
      enabled: this.enabled,
      uptimeMs:
        this.uptime +
        (this.runningSince === undefined ?
          0
        : performance.now() - this.runningSince),
      instrumentationErrors: this.instrumentationErrors,
      pools: Object.freeze(
        Array.from(this.pools, ([pool, group]) =>
          this.poolSnapshot(pool, group),
        ),
      ),
    });
  }

  private poolSnapshot(pool: ServerPool, group: PoolGroup): PoolMetrics {
    const registrations = pool.getBackendRegistrations();
    const current = new Set(registrations);
    const eligibility = {
      registered: registrations.length,
      registrations: 0,
      unknown: 0,
      healthy: 0,
      unhealthy: 0,
      eligible: 0,
    };
    const backends: BackendMetrics[] = registrations.map((registration) => {
      const health = pool.getBackendHealthMetrics(registration.server);
      eligibility.registrations += registration.registrations;
      if (health?.state === HealthState.HEALTHY) eligibility.healthy++;
      else if (health?.state === HealthState.UNHEALTHY) eligibility.unhealthy++;
      else eligibility.unknown++;
      if (!pool.healthCheck.enabled || health?.state !== HealthState.UNHEALTHY)
        eligibility.eligible++;
      return Object.freeze({
        ...group.backend(registration).snapshot(),
        id: registration.id,
        baseUrl: registration.server.baseUrl,
        registered: true,
        registrations: registration.registrations,
        health: health ?? null,
      });
    });
    for (const backend of group.activeBackends) {
      if (!current.has(backend.registration)) {
        backends.push(
          Object.freeze({
            ...backend.snapshot(),
            id: backend.registration.id,
            baseUrl: backend.registration.server.baseUrl,
            registered: false,
            registrations: 0,
            health: null,
          }),
        );
      }
    }
    return Object.freeze({
      ...group.snapshot(),
      route: pool.route,
      eligibility: Object.freeze(eligibility),
      health: pool.getHealthMetrics(),
      backends: Object.freeze(backends),
    });
  }
}

class RequestScope {
  private readonly started = performance.now();
  private readonly groups: Group[];
  private pool: PoolGroup | undefined;
  private serverPool: ServerPool | undefined;
  private backend: BackendGroup | undefined;
  private outcome: Outcome = "completed";
  private reason: Reason | undefined;
  private origin: "backend" | "loadPilot" = "loadPilot";
  private settled = false;

  constructor(
    private readonly collector: MetricsCollector,
    private readonly res: ServerResponse,
  ) {
    this.groups = [collector.root];
    try {
      res.once("finish", this.onFinish);
      res.once("close", this.onClose);
      res.once("error", this.onClose);
    } catch (error) {
      res.off("finish", this.onFinish);
      res.off("close", this.onClose);
      res.off("error", this.onClose);
      throw error;
    }
    collector.root.begin();
  }

  readonly observe: RequestObserver & ProxyObserver = (event) => {
    if (this.settled) return;
    try {
      this.recordEvent(event);
    } catch {
      this.collector.instrumentationErrors++;
    }
  };

  private recordEvent(event: RequestMetricEvent): void {
    switch (event.type) {
      case "pool": {
        if (this.pool) return;
        this.serverPool = event.pool;
        this.pool = this.collector.pools.get(event.pool);
        if (this.pool) {
          this.pool.begin();
          this.groups.push(this.pool);
        }
        return;
      }
      case "selected": {
        const registration = this.serverPool?.getBackendRegistration(
          event.server,
        );
        if (!this.pool || !registration || this.backend) return;
        this.backend = this.pool.backend(registration);
        this.backend.begin();
        this.pool.activeBackends.add(this.backend);
        this.groups.push(this.backend);
        return;
      }
      case "response":
        this.origin = "backend";
        for (const group of this.groups)
          group.headersLatency.record(event.headersMs);
        return;
      case "failure":
        if (this.outcome !== "completed") return;
        this.outcome = "failed";
        this.reason =
          event.reason === "timeout" ? "upstreamTimeouts" : "upstreamFailures";
        if (!this.res.headersSent) this.origin = "loadPilot";
        return;
      case "cancelled":
        if (this.outcome !== "completed" || this.res.writableFinished) return;
        this.outcome = "cancelled";
        this.reason =
          event.reason === "shutdown" ? "shutdownCancelled" : "clientCancelled";
        return;
      case "rejected":
        this.reason = event.reason;
        if (event.reason === "internalErrors") this.outcome = "failed";
        return;
      case "completed":
        return;
    }
  }

  private readonly onFinish = () => this.finish(true);
  private readonly onClose = () => this.finish(this.res.writableFinished);

  completeShutdown(): void {
    this.finish(this.res.writableFinished);
  }

  private finish(complete: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.res.off("finish", this.onFinish);
    this.res.off("close", this.onClose);
    this.res.off("error", this.onClose);
    this.collector.active.delete(this);
    if (!complete && this.outcome === "completed") {
      this.outcome = "cancelled";
      this.reason = "clientCancelled";
    }
    let duration = 0;
    try {
      duration = performance.now() - this.started;
    } catch {
      this.collector.instrumentationErrors++;
    }
    for (const group of this.groups) {
      try {
        group.settle(
          this.outcome,
          this.reason,
          complete,
          this.origin,
          this.res.statusCode,
          duration,
        );
      } catch {
        // Keep settling other gauges if an individual metric update fails.
        this.collector.instrumentationErrors++;
      }
    }
    if (this.backend?.requests.active === 0)
      this.pool?.activeBackends.delete(this.backend);
    this.groups.length = 0;
    this.backend = undefined;
    this.pool = undefined;
    this.serverPool = undefined;
  }
}
