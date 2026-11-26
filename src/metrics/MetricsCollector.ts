import type { ServerResponse } from "node:http";
import { poolSnapshot } from "./poolSnapshot.js";
import type { ServerPool } from "../server/ServerPool.js";
import type { LoadPilotMetrics, MetricsOptions } from "./MetricsTypes.js";
import type { RequestObserver } from "./MetricEvents.js";
import { MetricGroup } from "./MetricGroup.js";
import { PoolMetricGroup } from "./PoolMetricGroup.js";
import { RequestScope } from "./RequestScope.js";
export { LatencyHistogram } from "./LatencyHistogram.js";
export type { RequestMetricEvent, RequestObserver } from "./MetricEvents.js";
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
/** Per-instance aggregation. No timers, network work or routing/health decisions. */
export class MetricsCollector {
  readonly root = new MetricGroup();
  readonly pools = new Map<ServerPool, PoolMetricGroup>();
  readonly active = new Set<RequestScope>();
  instrumentationErrors = 0;
  private runningSince: number | undefined;
  private uptime = 0;

  constructor(
    private readonly name: string,
    readonly enabled: boolean,
  ) {}

  registerPool(pool: ServerPool): void {
    this.pools.set(pool, new PoolMetricGroup());
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
          poolSnapshot(pool, group),
        ),
      ),
    });
  }

}
