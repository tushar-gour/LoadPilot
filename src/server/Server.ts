export interface ServerOptions {
  /** Positive integer scheduling weight; defaults to 1. */
  weight?: number;
}

/** A backend destination in a server pool. */
class Server {
  readonly baseUrl: string;
  readonly weight: number;

  constructor(baseUrl: string, options: ServerOptions = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("Invalid backend options.");
    }
    const weight = options.weight === undefined ? 1 : options.weight;
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > 1_000_000) {
      throw new Error("Backend weight must be an integer between 1 and 1000000.");
    }
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error(`Invalid backend URL: ${baseUrl}`);
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(`Invalid HTTP backend URL: ${baseUrl}`);
    }
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.weight = weight;
    // Prevent JavaScript callers from invalidating scheduling arithmetic.
    Object.defineProperty(this, "weight", { writable: false, configurable: false });
  }
}
export { Server };
