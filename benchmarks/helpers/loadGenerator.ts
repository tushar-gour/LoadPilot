import { Agent, METHODS, request } from "node:http";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Histogram, byteChunk, jsonPayload } from "./statistics.js";
import type { LoadOptions, LoadResult } from "../types.js";

export function localTarget(target: string): URL {
  const url = new URL(target);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.hash) {
    throw new Error("Benchmark targets must be explicit http://127.0.0.1:port URLs");
  }
  return url;
}

export function validateLoad(options: LoadOptions): void {
  if (!Array.isArray(options.targets) || !options.targets.length || options.targets.length > 32) throw new Error("Provide 1–32 local targets");
  options.targets.forEach(localTarget);
  for (const [name, value, maximum] of [
    ["concurrency", options.concurrency, 1000], ["durationMs", options.durationMs, 86_400_000],
    ["requests", options.requests ?? 10_000_000, 10_000_000], ["timeoutMs", options.timeoutMs ?? 5000, 120_000],
    ["rate", options.rate ?? 1, 100_000],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}`);
  }
  if (!Number.isInteger(options.payloadBytes ?? 0) || (options.payloadBytes ?? 0) < 0 || (options.payloadBytes ?? 0) > 256 * 1024 * 1024) throw new Error("Invalid payloadBytes");
  if (!METHODS.includes(options.method ?? "GET")) throw new Error("Invalid method");
  if ((options.slowReadMs ?? 0) < 0 || (options.slowReadMs ?? 0) > 1000 || !Number.isInteger(options.slowReadMs ?? 0)) throw new Error("Invalid slowReadMs");
  for (const value of [options.keepAlive, options.jsonBody, options.validateUpload]) if (value !== undefined && typeof value !== "boolean") throw new Error("Invalid boolean load option");
  for (const status of options.expectedStatuses ?? [options.expectedStatus ?? 200]) if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error("Invalid expected status");
  for (const hash of [options.expectedHash, options.uploadHash]) if (hash !== undefined && !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Expected SHA-256 hex hash");
  if (options.cancel !== undefined && !["before-response", "upload", "response"].includes(options.cancel)) throw new Error("Invalid cancellation mode");
}

/** Catch up only within the configured outstanding-request bound. */
export function arrivalPlan(slots: number, concurrency: number, active: number) {
  const schedulingMisses = Math.max(0, slots - concurrency);
  const boundedSlots = Math.min(slots, concurrency);
  const launches = Math.min(boundedSlots, concurrency - active);
  return { launches, schedulingMisses, concurrencyMisses: boundedSlots - launches };
}

export async function runLoad(options: LoadOptions): Promise<LoadResult> {
  validateLoad(options);
  const urls = options.targets.map(localTarget);
  const agent = new Agent({ keepAlive: options.keepAlive ?? true, maxSockets: options.concurrency, maxFreeSockets: options.concurrency });
  const latency = new Histogram(), scheduling = new Histogram(), scheduleLatency = new Histogram(), headersLatency = new Histogram();
  const statuses: Record<string, number> = Object.create(null), errors: Record<string, number> = Object.create(null), backends: Record<string, number> = Object.create(null);
  const start = performance.now(), end = start + options.durationMs;
  let attempted = 0, completed = 0, failed = 0, timedOut = 0, cancelled = 0, active = 0;
  let received = 0, blocked = 0, scheduled = 0, missed = 0;
  let missedScheduling = 0, missedConcurrency = 0;
  let live = 0, peakConcurrency = 0, reusedSockets = 0, newSockets = 0;
  const sizes = new WeakMap<object, number>();
  const increment = (map: Record<string, number>, key: string) => {
    if (!(key in map)) {
      const size = sizes.get(map) ?? 0;
      if (size >= 64) key = "other"; else sizes.set(map, size + 1);
    }
    map[key] = (map[key] ?? 0) + 1;
  };
  const limit = options.requests ?? 10_000_000;
  const one = (sequence: number, scheduledAt = performance.now()): Promise<void> => new Promise((resolve) => {
    const target = urls[sequence % urls.length];
    const started = performance.now();
    live++; peakConcurrency = Math.max(peakConcurrency, live);
    if (options.rate) scheduling.record(started - scheduledAt);
    let settled = false, bytes = 0;
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    let pauseTimer: ReturnType<typeof setTimeout> | undefined;
    const req = request(target, { agent, method: options.method ?? "GET", headers: options.jsonBody ?
      { "content-type": "application/json", "content-length": jsonPayload.length } :
      (options.payloadBytes ? { "content-length": options.payloadBytes } : {}) });
    const finish = (kind: "complete" | "failure" | "timeout" | "cancel", error?: string) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(pauseTimer);
      latency.record(performance.now() - started);
      scheduleLatency.record(performance.now() - scheduledAt); live--;
      received += bytes;
      if (kind === "complete") completed++;
      else if (kind === "cancel") cancelled++;
      else { failed++; if (kind === "timeout") timedOut++; increment(errors, error ?? kind); }
      if (kind !== "complete") req.destroy();
      resolve();
    };
    const deadline = setTimeout(() => finish("timeout", "deadline"), options.timeoutMs ?? 5000);
    req.once("socket", () => { if (req.reusedSocket) reusedSockets++; else newSockets++; });
    req.on("error", (error: NodeJS.ErrnoException) => finish(options.cancel && error.code === "ECONNRESET" ? "cancel" : "failure", error.code ?? "request-error"));
    req.on("response", (res) => {
      headersLatency.record(performance.now() - started);
      increment(statuses, String(res.statusCode));
      const id = res.headers["x-backend-id"];
      if (typeof id === "string" && /^[a-z0-9-]{1,32}$/.test(id)) increment(backends, id);
      res.on("error", () => finish(options.cancel === "response" ? "cancel" : "failure", "incomplete-response"));
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (options.expectedHash) hash.update(chunk);
        if (options.validateUpload && bodyBytes < 4096) { chunks.push(chunk.subarray(0, 4096 - bodyBytes)); bodyBytes += chunk.length; }
        if (options.cancel === "response") { finish("cancel"); res.destroy(); return; }
        if (options.slowReadMs) {
          res.pause();
          pauseTimer = setTimeout(() => res.resume(), options.slowReadMs);
        }
      });
      res.on("end", () => {
        if (settled) return;
        if (!(options.expectedStatuses ?? [options.expectedStatus ?? 200]).includes(res.statusCode ?? 0)) { finish("failure", "unexpected-status"); return; }
        if (options.expectedBytes !== undefined && bytes !== options.expectedBytes) { finish("failure", "byte-mismatch"); return; }
        if (options.expectedHash && hash.digest("hex") !== options.expectedHash) { finish("failure", "hash-mismatch"); return; }
        if (options.validateUpload && (res.statusCode ?? 0) < 300) {
          const expected = options.jsonBody ? createHash("sha256").update(jsonPayload).digest("hex") : options.uploadHash;
          try {
            const result: unknown = JSON.parse(Buffer.concat(chunks).toString());
            if (!result || typeof result !== "object" || !("sha256" in result) || !("bytes" in result) ||
              result.sha256 !== expected || result.bytes !== (options.jsonBody ? jsonPayload.length : options.payloadBytes ?? 0)) {
              finish("failure", "upload-mismatch"); return;
            }
          } catch { finish("failure", "invalid-upload-response"); return; }
        }
        finish("complete");
      });
    });
    if (options.cancel === "before-response") { req.end(); pauseTimer = setTimeout(() => finish("cancel"), 25); return; }
    if (options.cancel === "upload") { req.write(byteChunk); pauseTimer = setTimeout(() => finish("cancel"), 25); return; }
    if (options.jsonBody) { req.end(jsonPayload); return; }
    let offset = 0;
    const write = () => {
      while (!settled && offset < (options.payloadBytes ?? 0)) {
        const chunk = byteChunk.subarray(0, Math.min(byteChunk.length, (options.payloadBytes ?? 0) - offset));
        offset += chunk.length;
        if (!req.write(chunk)) { blocked++; req.once("drain", write); return; }
      }
      if (!settled) req.end();
    };
    write();
  });
  try {
    if (!options.rate) {
      await Promise.all(Array.from({ length: options.concurrency }, async () => {
        while (performance.now() < end && attempted < limit) {
          const sequence = attempted++; await one(sequence);
        }
      }));
    } else {
      const pending = new Set<Promise<void>>();
      while (performance.now() < end && attempted < limit) {
        const now = performance.now();
        const due = start + scheduled * 1000 / options.rate;
        if (now < due) { await sleep(Math.min(10, due - now)); continue; }
        const slots = Math.min(Math.floor((now - due) * options.rate / 1000) + 1, Math.ceil((end - due) * options.rate / 1000), limit - attempted);
        if (slots <= 0) break;
        const plan = arrivalPlan(slots, options.concurrency, active);
        const dropped = plan.schedulingMisses + plan.concurrencyMisses;
        missed += dropped; missedScheduling += plan.schedulingMisses; missedConcurrency += plan.concurrencyMisses; scheduled += slots;
        // No arrival queue: launch only available slots, discard the oldest
        // excess slots, and retain actual schedule delay for every attempt.
        for (let index = dropped; index < slots; index++) {
          active++;
          const task = one(attempted++, due + index * 1000 / options.rate).finally(() => { active--; pending.delete(task); });
          pending.add(task);
        }
      }
      await Promise.all(pending);
      if (attempted < limit) {
        const expectedArrivals = Math.ceil(options.durationMs * options.rate / 1000);
        missed += Math.max(0, expectedArrivals - scheduled);
        missedScheduling += Math.max(0, expectedArrivals - scheduled);
        scheduled = Math.max(scheduled, expectedArrivals);
      }
    }
  } finally { agent.destroy(); }
  const elapsedMs = performance.now() - start;
  return { attempted, completed, failed, timedOut, cancelled, elapsedMs, issuingMs: Math.min(options.durationMs, elapsedMs),
    requestsPerSecond: completed / (elapsedMs / 1000), attemptedPerSecond: attempted / (elapsedMs / 1000), statuses, errors, backends,
    latencyMs: latency.snapshot(), schedulingDelayMs: scheduling.snapshot(), scheduled: options.rate ? scheduled : attempted,
    scheduleLatencyMs: scheduleLatency.snapshot(), headersLatencyMs: headersLatency.snapshot(), peakConcurrency, reusedSockets, newSockets,
    missedArrivals: missed, missedScheduling, missedConcurrency, clientLimited: missed > 0, bytesReceived: received, uploadBackpressureEvents: blocked };
}
