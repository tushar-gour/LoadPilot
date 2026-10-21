import { Server as HttpServer } from "node:http";
import { ServerPool } from "./ServerPool.js";
import { normalizeRoute } from "./routing/normalizeRoute.js";

export interface LoadPilotOptions {
  name: string;
  port: number;
  /** Base path for every pool (defaults to '/'). */
  route?: string;
  /** Initial pools; more can be registered using addPool(). */
  pools?: readonly ServerPool[];
}

type LifecycleState = "stopped" | "starting" | "started" | "stopping";

class LoadPilot {
  private readonly poolList = new Map<string, ServerPool>();
  private readonly httpServer: HttpServer;
  private state: LifecycleState = "stopped";
  readonly options: Readonly<{ name: string; port: number; route: string }>;

  constructor(options: LoadPilotOptions) {
    if (!options.name.trim()) throw new Error("LoadPilot name is required.");
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new Error("LoadPilot port must be an integer between 0 and 65535.");
    }
    this.options = {
      name: options.name,
      port: options.port,
      route: normalizeRoute(options.route ?? "/"),
    };

    for (const pool of options.pools ?? []) this.addPool(pool);

    // Placeholder until request routing and reverse proxying are implemented.
    this.httpServer = new HttpServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("LoadPilot is running");
    });
  }

  addPool(pool: ServerPool): void {
    if (this.poolList.has(pool.route)) {
      throw new Error(`A pool with route "${pool.route}" is already registered.`);
    }
    this.poolList.set(pool.route, pool);
  }

  async start(): Promise<void> {
    if (this.state !== "stopped") {
      throw new Error(`${this.options.name} cannot start while ${this.state}.`);
    }
    this.state = "starting";

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          this.httpServer.off("error", onError);
          reject(error);
        };
        this.httpServer.once("error", onError);
        try {
          this.httpServer.listen(this.options.port, () => {
            this.httpServer.off("error", onError);
            resolve();
          });
        } catch (error) {
          this.httpServer.off("error", onError);
          reject(error);
        }
      });
      this.state = "started";
      console.log(`${this.options.name} started`);
    } catch (error) {
      this.state = "stopped";
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    if (this.state !== "started") {
      throw new Error(`${this.options.name} cannot stop while ${this.state}.`);
    }
    this.state = "stopping";
    try {
      await new Promise<void>((resolve, reject) => {
        this.httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      this.state = "stopped";
      console.log(`${this.options.name} stopped`);
    } catch (error) {
      this.state = "started";
      throw error;
    }
  }
}

export { LoadPilot };
