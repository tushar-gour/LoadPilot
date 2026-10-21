import { ServerPool } from "./ServerPool.js";
import { Server as HttpServer } from "node:http";

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

    this.httpServer = new HttpServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("LoadPilot is running");
    });
  }

  async start(): Promise<void> {
    this.httpServer?.listen(this.options.port, () => {
      console.log(
        `${this.options.name} LoadPilot live @ PORT :: ${this.options.port}`,
      );
    });
  }

  stop(): void {
    this.httpServer.close((error) => {
      if (error) {
        console.error("Failed to stop LoadPilot:", error);
        return;
      }

      console.log(`${this.options.name} stopped successfully`);
    });
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
