import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { once } from "node:events";
import { byteChunk, jsonPayload, smallPayload } from "../helpers/statistics.js";
import type { BackendStats } from "../types.js";

export function drain(writable: NodeJS.WritableStream & { destroyed?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ready: boolean) => {
      writable.off("drain", onDrain); writable.off("close", onClose); writable.off("error", onClose); resolve(ready);
    };
    const onDrain = () => finish(true), onClose = () => finish(false);
    writable.once("drain", onDrain); writable.once("close", onClose); writable.once("error", onClose);
    if (writable.destroyed) onClose();
  });
}

export class BackendFixture {
  readonly sockets = new Set<Socket>();
  readonly responses = new Set<ServerResponse>();
  readonly healthResponses = new Set<ServerResponse>();
  private counters = this.empty();
  private health = { status: 200, delayMs: 0, sequence: [] as number[], index: 0 };
  private port = 0;
  readonly server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid");
    const endpoint = path.pathname.split("/").filter(Boolean).at(-1) ?? "get";
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    req.on("error", () => controller.abort());
    res.on("error", () => controller.abort());
    const signal = controller.signal;
    const queryNumber = (key: string, fallback: number, maximum: number) => {
      const number = Number(path.searchParams.get(key) ?? fallback);
      if (!Number.isInteger(number) || number < 0 || number > maximum) throw new Error(`Invalid fixture ${key}`);
      return number;
    };
    res.setHeader("x-backend-id", this.id);
    if (endpoint === "health") {
      this.counters.healthProbes++; this.healthResponses.add(res);
      res.once("close", () => this.healthResponses.delete(res));
    }
    else {
      this.counters.applicationRequests++; this.responses.add(res);
      const route = path.pathname.startsWith("/a/") ? "/a" : path.pathname.startsWith("/b/") ? "/b" : "/";
      this.counters.routes[route] = (this.counters.routes[route] ?? 0) + 1;
      res.once("close", () => { this.responses.delete(res); if (!res.writableFinished) this.counters.aborted++; });
      res.once("finish", () => { this.counters.completed++; });
    }
    const write = async () => {
      if (endpoint === "health") {
        if (this.health.delayMs) await sleep(this.health.delayMs, undefined, { signal });
        res.writeHead(this.health.sequence.length ? this.health.sequence[this.health.index++ % this.health.sequence.length] : this.health.status);
        res.end(); return;
      }
      if (endpoint === "reset") { req.socket.destroy(); return; }
      if (endpoint === "hang") return;
      if (endpoint === "partial") {
        res.writeHead(200, { "content-length": 1_048_576 }); res.write(byteChunk.subarray(0, 4096));
        await sleep(25, undefined, { signal }); res.destroy(); return;
      }
      if (endpoint === "delay") await sleep(queryNumber("ms", 25, 120_000), undefined, { signal });
      if (endpoint === "post" || endpoint === "upload" || endpoint === "slow-upload") {
        const hash = createHash("sha256"); let bytes = 0;
        for await (const data of req) {
          const chunk: Buffer = data; bytes += chunk.length; this.counters.bytesRead += chunk.length; hash.update(chunk);
          if (endpoint === "slow-upload") { this.counters.slowReads++; await sleep(queryNumber("ms", 2, 1000), undefined, { signal }); }
        }
        const body = JSON.stringify({ bytes, sha256: hash.digest("hex") });
        res.setHeader("content-type", "application/json"); res.end(body); return;
      }
      if (endpoint === "download" || endpoint === "slow-download") {
        const bytes = queryNumber("bytes", 65536, 256 * 1024 * 1024);
        res.setHeader("content-type", "application/octet-stream");
        if (path.searchParams.get("chunked") !== "true") res.setHeader("content-length", bytes);
        for (let offset = 0; offset < bytes && !res.destroyed; offset += byteChunk.length) {
          const chunk = byteChunk.subarray(0, Math.min(byteChunk.length, bytes - offset));
          this.counters.bytesWritten += chunk.length;
          if (!res.write(chunk)) { this.counters.blockedWrites++; if (!await drain(res)) return; }
          if (endpoint === "slow-download") await sleep(queryNumber("ms", 2, 1000), undefined, { signal });
        }
        res.end(); return;
      }
      const payload = endpoint === "json" ? jsonPayload : smallPayload;
      res.writeHead(endpoint === "status" ? queryNumber("code", 500, 599) : 200,
        { "content-type": endpoint === "json" ? "application/json" : "text/plain", "content-length": payload.length });
      this.counters.bytesWritten += payload.length; res.end(payload);
    };
    void write().catch((error: unknown) => {
      if (signal.aborted || res.destroyed) return;
      this.counters.unexpectedErrors++;
      res.destroy(error instanceof Error ? error : new Error("Fixture handler failed"));
    });
  });
  constructor(readonly id: string) {
    this.server.on("connection", (socket) => { this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); });
  }
  private empty() { return { applicationRequests: 0, healthProbes: 0, completed: 0, aborted: 0,
    bytesRead: 0, bytesWritten: 0, blockedWrites: 0, slowReads: 0, unexpectedErrors: 0, routes: {} as Record<string, number> }; }
  async start(port = this.port): Promise<string> {
    this.server.listen(port, "127.0.0.1"); await once(this.server, "listening");
    const address = this.server.address(); if (!address || typeof address === "string") throw new Error("Fixture did not bind");
    this.port = address.port; return `http://127.0.0.1:${this.port}`;
  }
  async stop(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve()); this.server.closeAllConnections();
    });
    this.responses.clear(); this.healthResponses.clear(); this.sockets.clear();
  }
  reset(): void { if (this.responses.size) throw new Error("Cannot reset an active backend"); this.counters = this.empty(); }
  configure(config: { status?: number; delayMs?: number; sequence?: number[] }): void {
    if (config.status !== undefined && (!Number.isInteger(config.status) || config.status < 100 || config.status > 599)) throw new Error("Invalid health status");
    if (config.delayMs !== undefined && (!Number.isInteger(config.delayMs) || config.delayMs < 0 || config.delayMs > 120000)) throw new Error("Invalid health delay");
    if (config.sequence?.some((value) => !Number.isInteger(value) || value < 100 || value > 599)) throw new Error("Invalid health sequence");
    this.health = { ...this.health, ...config, index: 0 };
  }
  release(): void { for (const res of this.responses) res.end(smallPayload); }
  stats(): BackendStats { return { ...this.counters, routes: { ...this.counters.routes }, active: this.responses.size, sockets: this.sockets.size,
    activeHealthProbes: this.healthResponses.size }; }
}
