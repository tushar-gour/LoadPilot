import { Algorithm, createAlgorithm } from "../algorithms/Algorithms.js";
import { PoolScheduler } from "./PoolScheduler.js";
import type { BackendRegistration, Registration } from "./BackendRegistration.js";
export type { BackendRegistration } from "./BackendRegistration.js";
import { Server } from "./Server.js";
import { normalizeRoute } from "../routing/normalizeRoute.js";
import { HealthMonitor } from "../health/HealthMonitor.js";
import {
  resolveHealthCheck,
  type HealthCheckOptions,
  type HealthCheckConfiguration,
  type BackendHealthStatus,
} from "../health/HealthCheck.js";
import type {
  BackendHealthMetrics,
  HealthProbeMetrics,
} from "../metrics/MetricsTypes.js";

export interface ServerPoolOptions {
  route: string;
  servers?: readonly Server[];
  algorithm?: Algorithm;
  healthCheck?: HealthCheckOptions;
}

/** Owns its backend list and independent scheduling state. */
class ServerPool {
  readonly route: string;
  readonly algorithm: Algorithm;
  readonly healthCheck: HealthCheckConfiguration;
  private readonly serverList: Server[];
  private readonly healthMonitor: HealthMonitor;
  private readonly registrations = new Map<Server, Registration>();
  private readonly scheduler: PoolScheduler;
  private nextBackendId = 1;

  constructor(options: ServerPoolOptions) {
    this.route = normalizeRoute(options.route);
    this.algorithm = options.algorithm ?? Algorithm.ROUND_ROBIN;
    const strategy = createAlgorithm(this.algorithm);
    this.serverList = [...(options.servers ?? [])];
    this.healthCheck = resolveHealthCheck(options.healthCheck);
    this.healthMonitor = new HealthMonitor(this.healthCheck);
    this.scheduler = new PoolScheduler(strategy, this.serverList, this.registrations, server => this.healthMonitor.isEligible(server));
    for (const server of this.serverList) this.register(server);
  }

  add(server: Server): void {
    this.serverList.push(server);
    this.register(server);
    this.scheduler.membershipChanged();
  }

  /** Remove the first registration of this Server object, if present. */
  remove(server: Server): boolean {
    const index = this.serverList.indexOf(server);
    if (index < 0) return false;
    this.serverList.splice(index, 1);
    const registration = this.registrations.get(server);
    if (registration && --registration.registrations === 0) {
      this.registrations.delete(server);
      this.healthMonitor.remove(server);
    }
    this.scheduler.membershipChanged(index);
    return true;
  }

  private register(server: Server): void {
    const registration = this.registrations.get(server);
    if (registration) registration.registrations++;
    else
      this.registrations.set(server, {
        id: this.nextBackendId++,
        server,
        registrations: 1,
        weight: server.weight,
        activeRequests: 0,
        latencyMs: undefined,
        credit: 0,
        lastSelected: 0,
      });
    this.healthMonitor.add(server);
  }

  /** @internal Current identities only; no history of removed backends. */
  getBackendRegistrations(): readonly BackendRegistration[] {
    return Array.from(this.registrations.values());
  }

  /** @internal Constant-time identity lookup; selection itself is unchanged. */
  getBackendRegistration(server: Server): BackendRegistration | undefined {
    return this.registrations.get(server);
  }

  /** @internal One idempotent opt-in for the actual shared health monitor. */
  enableHealthMetrics(): void {
    this.healthMonitor.enableMetrics();
  }

  /** @internal Pool-lifetime health totals, including removed registrations. */
  getHealthMetrics(): HealthProbeMetrics &
    Readonly<{ enabled: boolean; collecting: boolean }> {
    return this.healthMonitor.getMetrics();
  }

  /** @internal Read-only statistics for a current health record. */
  getBackendHealthMetrics(server: Server): BackendHealthMetrics | undefined {
    return this.healthMonitor.getBackendMetrics(server);
  }

  getHealthStatus(): readonly BackendHealthStatus[] {
    return this.healthMonitor.getStatus();
  }

  /** @internal LoadPilot owns monitoring lifecycle leases. */
  startHealthChecks(owner: object): void {
    this.healthMonitor.start(owner);
  }

  /** @internal Stop only this owner's monitoring lease. */
  stopHealthChecks(owner: object): void {
    this.healthMonitor.stop(owner);
  }

  /** @internal Only transport failures request an active confirmation. */
  reportTransportFailure(server: Server): void {
    this.healthMonitor.probeSoon(server);
  }

  /** @internal Reserve one proxied exchange; release exactly once at its terminal event.
   * Counts are not optional telemetry. Removed registrations retain only their
   * in-flight closure, and a re-added Server gets a fresh independent identity.
   */
  beginRequest(server: Server): ((headersMs?: number) => void) | undefined {
    return this.scheduler.beginRequest(server);
  }

  getNextServer(): Server | null {
    return this.scheduler.select();
  }
}

export { ServerPool };
