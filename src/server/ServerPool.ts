import { Algorithm, Algorithms } from "../algorithms/Algorithms.js";
import { Server } from "./Server.js";
import { normalizeRoute } from "../routing/normalizeRoute.js";
import { HealthMonitor } from "../health/HealthMonitor.js";
import { resolveHealthCheck, type HealthCheckOptions, type HealthCheckConfiguration, type BackendHealthStatus } from "../health/HealthCheck.js";

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
  private currentIndex = 0;

  constructor(options: ServerPoolOptions) {
    this.route = normalizeRoute(options.route);
    this.algorithm = options.algorithm ?? Algorithm.ROUND_ROBIN;
    this.serverList = [...(options.servers ?? [])];
    this.healthCheck = resolveHealthCheck(options.healthCheck);
    this.healthMonitor = new HealthMonitor(this.healthCheck);
    for (const server of this.serverList) this.healthMonitor.add(server);
  }

  add(server: Server): void {
    this.serverList.push(server);
    this.healthMonitor.add(server);
  }

  /** Remove the first registration of this Server object, if present. */
  remove(server: Server): boolean {
    const index = this.serverList.indexOf(server);
    if (index < 0) return false;
    this.serverList.splice(index, 1);
    if (index < this.currentIndex) this.currentIndex--;
    if (this.currentIndex >= this.serverList.length) this.currentIndex = 0;
    if (!this.serverList.includes(server)) this.healthMonitor.remove(server);
    return true;
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
