import { Algorithm, Algorithms } from "../algorithms/Algorithms.js";
import { Server } from "./Server.js";
import { normalizeRoute } from "../routing/normalizeRoute.js";
import { HealthMonitor } from "../health/HealthMonitor.js";
import { resolveHealthCheck, type HealthCheckOptions, type HealthCheckConfiguration, type BackendHealthStatus } from "../health/HealthCheck.js";
import type { BackendHealthMetrics, HealthProbeMetrics } from "../metrics/MetricsTypes.js";

/** @internal Identity for one continuous registration lifetime of a Server. */
export interface BackendRegistration {
  readonly id: number;
  readonly server: Server;
  readonly registrations: number;
}

export interface ServerPoolOptions {
  route: string;
  servers?: readonly Server[];
  algorithm?: Algorithm;
  healthCheck?: HealthCheckOptions;
}

/** Owns its backend list and independent selection cursor. */
class ServerPool {
  readonly route: string;
  readonly algorithm: Algorithm;
  readonly healthCheck: HealthCheckConfiguration;
  private readonly serverList: Server[];
  private readonly healthMonitor: HealthMonitor;
  private readonly registrations = new Map<Server, { id: number; server: Server; registrations: number }>();
  private nextBackendId = 1;
  private currentIndex = 0;

  constructor(options: ServerPoolOptions) {
    this.route = normalizeRoute(options.route);
    this.algorithm = options.algorithm ?? Algorithm.ROUND_ROBIN;
    this.serverList = [...(options.servers ?? [])];
    this.healthCheck = resolveHealthCheck(options.healthCheck);
    this.healthMonitor = new HealthMonitor(this.healthCheck);
    for (const server of this.serverList) this.register(server);
  }

  add(server: Server): void {
    this.serverList.push(server);
    this.register(server);
  }

  /** Remove the first registration of this Server object, if present. */
  remove(server: Server): boolean {
    const index = this.serverList.indexOf(server);
    if (index < 0) return false;
    this.serverList.splice(index, 1);
    if (index < this.currentIndex) this.currentIndex--;
    if (this.currentIndex >= this.serverList.length) this.currentIndex = 0;
    const registration = this.registrations.get(server);
    if (registration && --registration.registrations === 0) {
      this.registrations.delete(server);
      this.healthMonitor.remove(server);
    }
    return true;
  }

  private register(server: Server): void {
    const registration = this.registrations.get(server);
    if (registration) registration.registrations++;
    else this.registrations.set(server, { id: this.nextBackendId++, server, registrations: 1 });
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
  enableHealthMetrics(): void { this.healthMonitor.enableMetrics(); }

  /** @internal Pool-lifetime health totals, including removed registrations. */
  getHealthMetrics(): HealthProbeMetrics & Readonly<{ enabled: boolean; collecting: boolean }> {
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

  getNextServer(): Server | null {
    // Keep the original registration-order cursor, advancing through the
    // configured dispatcher at most once per entry. No filtered-list cursor.
    for (let checked = 0; checked < this.serverList.length; checked++) {
      const server = this.serverList[this.currentIndex]!;
      this.currentIndex = Algorithms.getNextIndex(
        this.algorithm, this.currentIndex, this.serverList.length,
      );
      if (this.healthMonitor.isEligible(server)) return server;
    }
    return null;
  }
}

export { ServerPool };
