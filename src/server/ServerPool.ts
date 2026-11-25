import { Algorithm, Algorithms, type SchedulingCandidate, type SchedulingState } from "../algorithms/Algorithms.js";
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

interface Registration extends BackendRegistration, SchedulingState { registrations: number }

/** Owns its backend list and independent scheduling state. */
class ServerPool {
  readonly route: string;
  readonly algorithm: Algorithm;
  readonly healthCheck: HealthCheckConfiguration;
  private readonly serverList: Server[];
  private readonly healthMonitor: HealthMonitor;
  private readonly registrations = new Map<Server, Registration>();
  private weightedEligible = new Set<Registration>();
  private selectionCount = 0;
  private nextBackendId = 1;
  private currentIndex = 0;

  constructor(options: ServerPoolOptions) {
    this.route = normalizeRoute(options.route);
    this.algorithm = options.algorithm ?? Algorithm.ROUND_ROBIN;
    if (!Object.values(Algorithm).includes(this.algorithm)) throw new Error("Unsupported load balancing algorithm.");
    this.serverList = [...(options.servers ?? [])];
    this.healthCheck = resolveHealthCheck(options.healthCheck);
    this.healthMonitor = new HealthMonitor(this.healthCheck);
    for (const server of this.serverList) this.register(server);
  }

  add(server: Server): void {
    this.serverList.push(server);
    this.register(server);
    this.resetWeightedCredits();
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
    this.resetWeightedCredits();
    return true;
  }

  private register(server: Server): void {
    const registration = this.registrations.get(server);
    if (registration) registration.registrations++;
    else this.registrations.set(server, { id: this.nextBackendId++, server, registrations: 1,
      weight: server.weight, activeRequests: 0, latencyMs: undefined, credit: 0, lastSelected: 0 });
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

  /** @internal Reserve one proxied exchange; release exactly once at its terminal event.
   * Counts are not optional telemetry. Removed registrations retain only their
   * in-flight closure, and a re-added Server gets a fresh independent identity.
   */
  beginRequest(server: Server): ((headersMs?: number) => void) | undefined {
    if (this.algorithm !== Algorithm.LEAST_CONNECTIONS &&
        this.algorithm !== Algorithm.WEIGHTED_LEAST_CONNECTIONS &&
        this.algorithm !== Algorithm.LEAST_RESPONSE_TIME) return undefined;
    const registration = this.registrations.get(server);
    if (!registration) throw new Error("Cannot reserve an unregistered backend.");
    registration.activeRequests++;
    let settled = false;
    return (headersMs?: number) => {
      if (settled) return;
      settled = true;
      registration.activeRequests--;
      if (this.algorithm === Algorithm.LEAST_RESPONSE_TIME &&
          headersMs !== undefined && Number.isFinite(headersMs) && headersMs >= 0) {
        registration.latencyMs = registration.latencyMs === undefined
          ? headersMs : 0.2 * headersMs + 0.8 * registration.latencyMs;
      }
    };
  }

  private resetWeightedCredits(): void {
    if (this.algorithm !== Algorithm.WEIGHTED_ROUND_ROBIN) return;
    for (const registration of this.registrations.values()) registration.credit = 0;
    this.weightedEligible.clear();
  }

  getNextServer(): Server | null {
    const count = this.serverList.length;
    if (this.algorithm === Algorithm.ROUND_ROBIN) {
      // Preserve registration order and the existing cursor/health semantics.
      for (let checked = 0; checked < count; checked++) {
        const server = this.serverList[this.currentIndex]!;
        this.currentIndex = Algorithms.getNextIndex(this.algorithm, this.currentIndex, count);
        if (this.healthMonitor.isEligible(server)) return server;
      }
      return null;
    }

    const candidates: SchedulingCandidate[] = [];
    const eligible = new Set<Registration>();
    for (let offset = 0; offset < count; offset++) {
      const index = (this.currentIndex + offset) % count;
      const server = this.serverList[index]!;
      if (!this.healthMonitor.isEligible(server)) continue;
      const registration = this.registrations.get(server)!;
      // RANDOM samples registration slots; other strategies share state for
      // repeated registration of the same Server object within this pool.
      if (this.algorithm === Algorithm.RANDOM || !eligible.has(registration)) {
        candidates.push({ index, state: registration });
      }
      eligible.add(registration);
    }
    if (this.algorithm === Algorithm.WEIGHTED_ROUND_ROBIN &&
        (eligible.size !== this.weightedEligible.size ||
         [...eligible].some(registration => !this.weightedEligible.has(registration)))) {
      this.resetWeightedCredits();
      this.weightedEligible = eligible;
    }
    const selected = Algorithms.select(this.algorithm, candidates, this.selectionCount + 1);
    if (!selected) return null;
    this.currentIndex = (selected.index + 1) % count;
    if (this.algorithm === Algorithm.LEAST_RESPONSE_TIME) {
      selected.state.lastSelected = ++this.selectionCount;
    }
    return this.serverList[selected.index]!;
  }
}

export { ServerPool };
