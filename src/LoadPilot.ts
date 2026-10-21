import { ServerPool } from "./ServerPool.js";
import { Server as HttpServer } from "node:http";
import { once } from "node:events";

interface LoadPilotOptions {
  name: string;
  port: number;
  route: string;
}

class LoadPilot {
  private readonly poolList = new Map<string, ServerPool>();
  private readonly httpServer: HttpServer;
  readonly options: LoadPilotOptions;

  constructor(options: LoadPilotOptions) {
    this.options = options;

    this.httpServer = new HttpServer((_, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("LoadPilot is running");
    });
  }

  async start(): Promise<void> {
    this.httpServer.listen(this.options.port);
    await once(this.httpServer, "listening");

    console.log(`${this.options.name} started`);
  }

  async stop(): Promise<void> {
    if (!this.httpServer.listening) return;

    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    console.log(`${this.options.name} stopped`);
  }

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
