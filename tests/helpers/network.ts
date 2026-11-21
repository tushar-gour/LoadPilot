import assert from "node:assert/strict";
import { createServer, request, type RequestListener, type IncomingMessage, type IncomingHttpHeaders, type OutgoingHttpHeaders, type Agent } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import type { SecureVersion } from "node:tls";
import type { Socket } from "node:net";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { TestContext } from "node:test";
import { LoadPilot, ServerPool, Server, type LoadPilotOptions, type AggregateMetrics } from "../../src/index.js";

export const fixtureTls = {
  key: readFileSync(new URL("../fixtures/localhost-key.pem", import.meta.url)),
  cert: readFileSync(new URL("../fixtures/localhost-cert.pem", import.meta.url)),
};
export const limits = { timeout: 15000 };
export function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
export async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error("Expected network state did not occur"); await nextTurn(); }
}
export async function backend(t: TestContext, handler: RequestListener, secure = false) {
  const server = secure ? createHttpsServer(fixtureTls, handler) : createServer(handler);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    for (const socket of sockets) socket.destroy();
  }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { server, url: `${secure ? "https" : "http"}://127.0.0.1:${address.port}` };
}
export function pool(...urls: string[]) { return new ServerPool({ route: "/", servers: urls.map((url) => new Server(url)) }); }
export async function start(t: TestContext, options: Partial<LoadPilotOptions> = {}) {
  const pilot = new LoadPilot({ name: t.name, port: 0, host: "127.0.0.1", metrics: { enabled: true }, ...options });
  t.after(() => pilot.stop()); await pilot.start(); return pilot;
}
export interface Reply { status: number; headers: IncomingHttpHeaders; body: Buffer }
export interface ClientOptions {
  path?: string; port?: number; method?: string; headers?: OutgoingHttpHeaders; body?: string | Buffer;
  agent?: Agent | false; hostname?: string; minVersion?: SecureVersion; maxVersion?: SecureVersion;
  ca?: Buffer; onResponse?: (res: IncomingMessage) => void; onData?: (chunk: Buffer, res: IncomingMessage) => void;
  servername?: string;
}
export function open(pilot: LoadPilot, options: ClientOptions = {}) {
  let client!: ReturnType<typeof request>;
  const promise = new Promise<Reply>((resolve, reject) => {
    const configuration = { hostname: options.hostname ?? "127.0.0.1", port: options.port ?? pilot.port ?? 0, path: options.path ?? "/",
      method: options.method, headers: options.headers, agent: options.agent ?? false, ca: options.ca ?? fixtureTls.cert,
      minVersion: options.minVersion, maxVersion: options.maxVersion,
      servername: options.servername ?? (pilot.options.protocol === "https" ? "localhost" : undefined) };
    client = (pilot.options.protocol === "https" ? httpsRequest : request)(configuration, (res) => {
      const chunks: Buffer[] = [];
      options.onResponse?.(res);
      res.on("data", (chunk: Buffer) => { chunks.push(chunk); options.onData?.(chunk, res); });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    client.on("error", reject); client.setTimeout(10000, () => client.destroy(new Error("Test client deadline")));
  });
  return { request: client, promise };
}
export function exchange(pilot: LoadPilot, options: ClientOptions = {}) {
  const pending = open(pilot, options); pending.request.end(options.body); return pending.promise;
}
export function settled(group: AggregateMetrics, total?: number) {
  const request = group.requests;
  if (total !== undefined) assert.equal(request.total, total);
  assert.equal(request.active, 0); assert.equal(request.total, request.completed + request.failed + request.cancelled);
  assert.equal(request.cancelled, request.clientCancelled + request.shutdownCancelled);
  assert.equal(group.responses.completed + group.responses.incomplete, request.total); assert.equal(group.latency.count, request.total);
}
