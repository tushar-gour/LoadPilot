import { ServerPool } from "./ServerPool.js";

interface LoadPilotOptions {
  port: number;
  route: string;
}

class LoadPilot {
  private readonly poolList = new Map<string, ServerPool>();

  constructor(readonly options: LoadPilotOptions) {}

  addPool(pool: ServerPool): void {
    if (this.poolList.has(pool.category)) {
      throw new Error(
        `A pool with category "${pool.category}" is already registered.`,
      );
    }

    this.poolList.set(pool.category, pool);
  }
}

export { LoadPilot, LoadPilotOptions };
