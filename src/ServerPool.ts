import { Algorithm, Algorithms } from "./algorithms/Algorithms.js";
import { Server } from "./Server.js";
import { normalizeRoute } from "./routing/normalizeRoute.js";

export interface ServerPoolOptions {
  route: string;
  servers?: readonly Server[];
  algorithm?: Algorithm;
}

/** Owns its backend list and independent selection cursor. */
class ServerPool {
  readonly route: string;
  readonly algorithm: Algorithm;
  private readonly serverList: Server[];
  private currentIndex = 0;

  constructor(options: ServerPoolOptions) {
    this.route = normalizeRoute(options.route);
    this.algorithm = options.algorithm ?? Algorithm.ROUND_ROBIN;
    this.serverList = [...(options.servers ?? [])];
  }

  add(server: Server): void {
    this.serverList.push(server);
  }

  getNextServer(): Server | null {
    if (this.serverList.length === 0) return null;
    const server = this.serverList[this.currentIndex]!;
    this.currentIndex = Algorithms.getNextIndex(
      this.algorithm,
      this.currentIndex,
      this.serverList.length,
    );
    return server;
  }
}

export { ServerPool };
