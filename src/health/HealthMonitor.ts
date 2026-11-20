import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Server } from "../server/Server.js";
import { HealthState, type BackendHealthStatus, type HealthCheckConfiguration } from "./HealthCheck.js";
import type { BackendHealthMetrics, HealthProbeMetrics } from "../metrics/MetricsTypes.js";

type ProbeCounters = { -readonly [K in keyof HealthProbeMetrics]: HealthProbeMetrics[K] };
function probeCounters(): ProbeCounters {
  return { successfulProbes: 0, failedProbes: 0, timeoutProbes: 0,
    healthyTransitions: 0, unhealthyTransitions: 0, unknownTransitions: 0,
    lastProbeAt: null, lastStateChangeAt: null };
}

interface BackendRecord {
  readonly server: Server;
  state: HealthState;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  timer?: ReturnType<typeof setTimeout>;
  cancel?: () => void;
  metrics?: ProbeCounters;
}

/** Per-pool active monitoring. It never owns or cancels application requests. */
export class HealthMonitor {
  private readonly records = new Map<Server, BackendRecord>();
  private readonly owners = new Set<object>();
  private metricsEnabled = false;
  private readonly totals = probeCounters();

  constructor(private readonly options: HealthCheckConfiguration) {}

  enableMetrics(): void {
    if (this.metricsEnabled) return;
    this.metricsEnabled = true;
    for (const record of this.records.values()) record.metrics = probeCounters();
  }

  getMetrics(): HealthProbeMetrics & Readonly<{ enabled: boolean; collecting: boolean }> {
    return Object.freeze({ ...this.totals, enabled: this.options.enabled, collecting: this.metricsEnabled });
  }

  getBackendMetrics(server: Server): BackendHealthMetrics | undefined {
    const record = this.records.get(server);
    return record ? Object.freeze({ ...(record.metrics ?? probeCounters()), state: record.state }) : undefined;
  }

  add(server: Server): void {
    if (this.records.has(server)) return;
    const record: BackendRecord = {
      server, state: HealthState.UNKNOWN, consecutiveSuccesses: 0, consecutiveFailures: 0,
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
      record.state = HealthState.UNKNOWN;
      if (previousState !== record.state) this.recordTransition(record);
      record.consecutiveSuccesses = 0;
      record.consecutiveFailures = 0;
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
    return !this.options.enabled || this.records.get(server)?.state !== HealthState.UNHEALTHY;
  }

  /** Coalesce passive transport signals into one active confirmation probe. */
  probeSoon(server: Server): void {
    const record = this.records.get(server);
    if (record && this.isActive(record) && !record.cancel) this.schedule(record, 0);
  }

  getStatus(): readonly BackendHealthStatus[] {
    return Object.freeze(Array.from(this.records.values(), (record) => Object.freeze({
      server: record.server, state: record.state,
      consecutiveSuccesses: record.consecutiveSuccesses,
      consecutiveFailures: record.consecutiveFailures,
    })));
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
    const key = record.state === HealthState.HEALTHY ? "healthyTransitions" :
      record.state === HealthState.UNHEALTHY ? "unhealthyTransitions" : "unknownTransitions";
    record.metrics[key]++;
    this.totals[key]++;
    const now = Date.now();
    record.metrics.lastStateChangeAt = now;
    this.totals.lastStateChangeAt = now;
  }

  private recordOutcome(record: BackendRecord, success: boolean, timedOut: boolean): void {
    const previousState = record.state;
    if (success) {
      record.consecutiveFailures = 0;
      record.consecutiveSuccesses = Math.min(record.consecutiveSuccesses + 1, this.options.healthyThreshold);
      if (record.state !== HealthState.UNHEALTHY || record.consecutiveSuccesses >= this.options.healthyThreshold) {
        record.state = HealthState.HEALTHY;
      }
    } else {
      record.consecutiveSuccesses = 0;
      record.consecutiveFailures = Math.min(record.consecutiveFailures + 1, this.options.unhealthyThreshold);
      if (record.consecutiveFailures >= this.options.unhealthyThreshold) record.state = HealthState.UNHEALTHY;
    }
    if (record.metrics) {
      const key = success ? "successfulProbes" : "failedProbes";
      record.metrics[key]++;
      this.totals[key]++;
      if (timedOut) { record.metrics.timeoutProbes++; this.totals.timeoutProbes++; }
      const now = Date.now();
      record.metrics.lastProbeAt = now;
      this.totals.lastProbeAt = now;
      if (previousState !== record.state) this.recordTransition(record);
    }
  }

  private probe(record: BackendRecord): void {
    if (!this.isActive(record) || record.cancel) return;
    let req: ClientRequest | undefined;
    let res: IncomingMessage | undefined;
    let settled = false;
    const finish = (success?: boolean, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req?.destroy();
      res?.destroy();
      record.cancel = undefined;
      // Cancellation has no outcome. Identity also excludes removed/re-added
      // entries and stale callbacks from previous monitoring lifecycles.
      if (success !== undefined && this.isActive(record)) {
        this.recordOutcome(record, success, timedOut);
        this.schedule(record, this.options.intervalMs);
      }
    };
    record.cancel = () => finish();
    const deadline = setTimeout(() => finish(false, true), this.options.timeoutMs);
    deadline.unref();
    try {
      const backend = new URL(record.server.baseUrl);
      req = (backend.protocol === "https:" ? httpsRequest : httpRequest)(backend, {
        method: "GET", agent: false,
        path: backend.pathname.replace(/\/+$/, "") + this.options.path,
        headers: { host: backend.host, connection: "close" },
      });
      req.once("socket", (socket) => socket.unref());
      req.once("error", () => finish(false));
      req.once("upgrade", (_response, socket) => {
        socket.destroy();
        finish(false);
      });
      req.once("response", (response) => {
        res = response;
        response.once("error", () => finish(false));
        response.once("aborted", () => finish(false));
        if (settled) { response.destroy(); return; }
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          finish(false);
          return;
        }
        response.once("end", () => finish(response.complete));
        // Discard incrementally; the same deadline also bounds a stalled body.
        response.resume();
      });
      req.end();
    } catch {
      finish(false);
    }
  }
}
