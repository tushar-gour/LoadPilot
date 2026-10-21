import { ServerPool } from "./ServerPool.js";

interface LoadPilotOptions {
  port: number;
  route: string;
  poolList: Map<string, ServerPool>;
}

class LoadPilot {
  constructor(options: LoadPilotOptions) {}
}

export { LoadPilot, LoadPilotOptions };
