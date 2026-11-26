import { HealthTransitionPolicy, type HealthTransitionState } from "./HealthTransitionPolicy.js";
import { HttpHealthProbe } from "./HttpHealthProbe.js";
import type { Server } from "../server/Server.js";
import {
  HealthState,
  type BackendHealthStatus,
  type HealthCheckConfiguration,
} from "./HealthCheck.js";
import type {
  BackendHealthMetrics,
  HealthProbeMetrics,
} from "../metrics/MetricsTypes.js";

type ProbeCounters = {
  -readonly [K in keyof HealthProbeMetrics]: HealthProbeMetrics[K];
};
function probeCounters(): ProbeCounters {
  return {
    successfulProbes: 0,
    failedProbes: 0,
    timeoutProbes: 0,
    healthyTransitions: 0,
    unhealthyTransitions: 0,
    unknownTransitions: 0,
    lastProbeAt: null,
    lastStateChangeAt: null,
  };
}

interface BackendRecord extends HealthTransitionState {
  readonly server: Server;
  timer?: ReturnType<typeof setTimeout>;
  cancel?: () => void;
  metrics?: ProbeCounters;
}

/** Per-pool active monitoring. It never owns or cancels application requests. */
export class HealthMonitor {
  private readonly transport = new HttpHealthProbe();
  private readonly records = new Map<Server, BackendRecord>();
  private readonly owners = new Set<object>();
  private metricsEnabled = false;
  private readonly totals = probeCounters();

  private readonly policy: HealthTransitionPolicy;

  constructor(private readonly options: HealthCheckConfiguration) {
    this.policy = new HealthTransitionPolicy(options);
  }

  enableMetrics(): void {
    if (this.metricsEnabled) return;
    this.metricsEnabled = true;
    for (const record of this.records.values())
      record.metrics = probeCounters();
  }

  getMetrics(): HealthProbeMetrics &
    Readonly<{ enabled: boolean; collecting: boolean }> {
    return Object.freeze({
      ...this.totals,
      enabled: this.options.enabled,
      collecting: this.metricsEnabled,
    });
  }

  getBackendMetrics(server: Server): BackendHealthMetrics | undefined {
    const record = this.records.get(server);
    return record ?
        Object.freeze({
          ...(record.metrics ?? probeCounters()),
          state: record.state,
        })
      : undefined;
  }

  add(server: Server): void {
    if (this.records.has(server)) return;
    const record: BackendRecord = {
      server,
      state: HealthState.UNKNOWN,
      consecutiveSuccesses: 0,
      consecutiveFailures: 0,
      metrics: this.metricsEnabled ? probeCounters() : undefined,
    };
    this.records.set(server, record);
    if (this.owners.size) this.schedule(record, 0);
  }

  remove(server: Server): void {
    const record = this.records.get(server);
    if (!record) return;
    this.records.delete(server);
    clearTimeout(record.timer);
    record.cancel?.();
  }

  start(owner: object): void {
    if (!this.options.enabled || this.owners.has(owner)) return;
    this.owners.add(owner);
    if (this.owners.size !== 1) return;
    for (const record of this.records.values()) {
      const previousState = record.state;
      this.policy.reset(record);
      if (previousState !== record.state) this.recordTransition(record);
      this.schedule(record, 0);
    }
  }

  stop(owner: object): void {
    if (!this.owners.delete(owner) || this.owners.size) return;
    for (const record of this.records.values()) {
      clearTimeout(record.timer);
      record.timer = undefined;
      record.cancel?.();
    }
  }

  isEligible(server: Server): boolean {
    return (
      !this.options.enabled ||
      this.records.get(server)?.state !== HealthState.UNHEALTHY
    );
  }

  /** Coalesce passive transport signals into one active confirmation probe. */
  probeSoon(server: Server): void {
    const record = this.records.get(server);
    if (record && this.isActive(record) && !record.cancel)
      this.schedule(record, 0);
  }

  getStatus(): readonly BackendHealthStatus[] {
    return Object.freeze(
      Array.from(this.records.values(), (record) =>
        Object.freeze({
          server: record.server,
          state: record.state,
          consecutiveSuccesses: record.consecutiveSuccesses,
          consecutiveFailures: record.consecutiveFailures,
        }),
      ),
    );
  }

  private isActive(record: BackendRecord): boolean {
    return this.owners.size > 0 && this.records.get(record.server) === record;
  }

  private schedule(record: BackendRecord, delay: number): void {
    clearTimeout(record.timer);
    record.timer = setTimeout(() => {
      record.timer = undefined;
      this.probe(record);
    }, delay);
    record.timer.unref();
  }

  private recordTransition(record: BackendRecord): void {
    if (!record.metrics) return;
    const key =
      record.state === HealthState.HEALTHY ? "healthyTransitions"
      : record.state === HealthState.UNHEALTHY ? "unhealthyTransitions"
      : "unknownTransitions";
    record.metrics[key]++;
    this.totals[key]++;
    const now = Date.now();
    record.metrics.lastStateChangeAt = now;
    this.totals.lastStateChangeAt = now;
  }

  private recordOutcome(
    record: BackendRecord,
    success: boolean,
    timedOut: boolean,
  ): void {
    const previousState = record.state;
    this.policy.apply(record, success);
    if (record.metrics) {
      const key = success ? "successfulProbes" : "failedProbes";
      record.metrics[key]++;
      this.totals[key]++;
      if (timedOut) {
        record.metrics.timeoutProbes++;
        this.totals.timeoutProbes++;
      }
      const now = Date.now();
      record.metrics.lastProbeAt = now;
      this.totals.lastProbeAt = now;
      if (previousState !== record.state) this.recordTransition(record);
    }
  }

  private probe(record: BackendRecord): void {
    if (!this.isActive(record) || record.cancel) return;
    this.transport.run(record.server, this.options, cancel => {
      record.cancel = cancel;
    }, (success, timedOut = false) => {
      record.cancel = undefined;
      // Identity excludes removed registrations and stale monitoring lifecycles.
      if (success !== undefined && this.isActive(record)) {
        this.recordOutcome(record, success, timedOut);
        this.schedule(record, this.options.intervalMs);
      }
    });
  }
}
