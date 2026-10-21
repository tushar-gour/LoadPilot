import { algorithm, Algorithm } from "./algorithms/Algorithms.js";
import { Server } from "./Server.js";

class ServerPool {
  currentIndex = 0;

  readonly serverList: Server[] = [];
  readonly algorithm: algorithm = algorithm.ROUND_ROBIN;
  readonly category: string;

  constructor(
    category: string,
    serverList: Server[] = [],
    algo: algorithm = algorithm.ROUND_ROBIN,
  ) {
    this.category = category;
    this.serverList = serverList;
    this.algorithm = algo;
  }

  add(server: Server) {
    // add a new server to the pool
    this.serverList.push(server);
  }

  getNextServer(): Server | null {
    if (this.serverList.length === 0) {
      return null; // if there is no server added to the pool
    }

    // get the current server instance and update the current index to the next index for next iteration
    const server: Server = this.serverList[this.currentIndex];

    // find the next server's index
    this.currentIndex = Algorithm.getNextIndex(
      this.algorithm,
      this.currentIndex,
      this.serverList.length,
    );

    // return the selected server instance
    return server;
  }
}

export { ServerPool };
