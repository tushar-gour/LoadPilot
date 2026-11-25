import type { ServerResponse } from "node:http";
import type { ServerPool } from "../server/ServerPool.js";
import type { ProxyObserver } from "../proxy/HttpProxy.js";
import type { RequestMetricEvent, RequestObserver, Outcome, Reason } from "./MetricEvents.js";
import type { MetricGroup } from "./MetricGroup.js";
import type { PoolMetricGroup } from "./PoolMetricGroup.js";
import type { BackendMetricGroup } from "./BackendMetricGroup.js";
interface ScopeContext {
  readonly root: MetricGroup;
  readonly pools: ReadonlyMap<ServerPool, PoolMetricGroup>;
  readonly active: Set<RequestScope>;
  instrumentationErrors: number;
}
export class RequestScope {
  private readonly started = performance.now();
  private readonly groups: MetricGroup[];
  private pool: PoolMetricGroup | undefined;
  private serverPool: ServerPool | undefined;
  private backend: BackendMetricGroup | undefined;
  private outcome: Outcome = "completed";
  private reason: Reason | undefined;
  private origin: "backend" | "loadPilot" = "loadPilot";
  private settled = false;

  constructor(
    private readonly collector: ScopeContext,
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
