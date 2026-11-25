import { Agent as HttpAgent, type IncomingMessage, type ServerResponse } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { Server } from "../server/Server.js";
import { ForwardedHeaders } from "./ForwardedHeaders.js";
import { watchClose, type CloseWatch } from "./closeWatch.js";
import { managedAgent } from "./managedAgent.js";
import type { ProxyObserver } from "./ProxyEvents.js";
import { sendError } from "./sendError.js";
import { ProxyExchange } from "./ProxyExchange.js";
export { sendError } from "./sendError.js";
export type { ProxyEvent, ProxyObserver } from "./ProxyEvents.js";
/** Native streaming transport. Routing and backend selection belong to callers. */
export class HttpProxy {
  private httpAgent!: HttpAgent;
  private httpsAgent!: HttpsAgent;
  private closeGates!: () => void;
  private readonly active = new Set<() => CloseWatch>();
  private closing = false;
  private closingPromise: Promise<void> | undefined;

  constructor(
    private readonly timeoutMs: number,
    private readonly forwarding = new ForwardedHeaders(),
  ) {
    this.resetAgents();
  }

  private resetAgents(): void {
    const plain = managedAgent(new HttpAgent({ keepAlive: true })),
      secure = managedAgent(new HttpsAgent({ keepAlive: true }));
    this.httpAgent = plain.agent;
    this.httpsAgent = secure.agent;
    this.closeGates = () => {
      plain.closeGate();
      secure.closeGate();
    };
  }

  open(): void {
    this.closing = false;
    this.closingPromise = undefined;
  }

  get activeCount(): number {
    return this.active.size;
  }

  closeIdleConnections(): void {
    for (const agent of [this.httpAgent, this.httpsAgent]) {
      for (const sockets of Object.values(agent.freeSockets))
        for (const socket of sockets ?? []) socket.destroy();
    }
  }

  /**
   * Starts an exchange and owns its streams until finish/close/error/deadline.
   * Deliberately returns void: every asynchronous event has a managed handler.
   */
  forward(
    req: IncomingMessage,
    res: ServerResponse,
    server: Server,
    path: string,
    baseRoute: string,
    onTransportFailure?: () => void,
    observer?: ProxyObserver,
    onSettled?: (headersMs?: number) => void,
  ): void {
    if (this.closing) {
      onSettled?.();
      sendError(res, 503);
      return;
    }
    new ProxyExchange(
      this.timeoutMs, this.forwarding, this.httpAgent, this.httpsAgent,
      cancel => { this.active.add(cancel); },
      cancel => { this.active.delete(cancel); },
    ).forward(req, res, server, path, baseRoute, onTransportFailure, observer, onSettled);
  }

  close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closing = true;
    this.closeGates();
    const agents = [this.httpAgent, this.httpsAgent];
    const sockets = new Set(
      agents.flatMap((agent) =>
        [
          ...Object.values(agent.sockets),
          ...Object.values(agent.freeSockets),
        ].flatMap((list) => list ?? []),
      ),
    );
    const watches = [...sockets].map(watchClose);
    // A prior client cancellation may already have removed its exchange from
    // active while the native Agent still retains that destroyed queue entry.
    for (const agent of agents)
      for (const requests of Object.values(agent.requests)) {
        for (const request of requests ?? []) watches.push(watchClose(request));
      }
    for (const cancel of this.active) watches.push(cancel());
    for (const agent of agents) agent.destroy();
    this.closingPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        for (const watch of watches) watch.cleanup();
        // Old generations stay gated even if native callbacks arrive later.
        this.resetAgents();
        if (error) reject(error);
        else resolve();
      };
      const deadline = setTimeout(
        () => finish(new Error("Upstream shutdown cleanup exceeded 1000 ms.")),
        1000,
      );
      deadline.unref();
      void Promise.all(watches.map((watch) => watch.promise)).then(
        () => finish(),
        () => finish(new Error("Upstream shutdown cleanup failed.")),
      );
    });
    return this.closingPromise;
  }
}
