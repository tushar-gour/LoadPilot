import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Algorithm } from "../src/index.js";
import { Environment, accounting } from "./helpers/environment.js";
import { waitFor } from "./helpers/processes.js";
import { environmentInfo } from "./helpers/report.js";
import { smallPayload } from "./helpers/statistics.js";
import type { Resources } from "./types.js";

const { values } = parseArgs({ options: {
  duration: { type: "string", default: "5" },
  warmup: { type: "string", default: "1" },
  concurrency: { type: "string", default: "30" },
  repetitions: { type: "string", default: "3" },
  profiles: { type: "string", default: "uniform,weighted,heterogeneous,unhealthy" },
  label: { type: "string", default: "algorithms" },
  rate: { type: "string" },
} });
function number(value: string | undefined, min: number, max: number, integer = true) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error("Invalid numeric benchmark option");
  return n;
}
const durationMs = Math.round(number(values.duration, 0.1, 3600, false) * 1000);
const warmupMs = Math.round(number(values.warmup, 0, 60, false) * 1000);
const concurrency = number(values.concurrency, 1, 1000);
const repetitions = number(values.repetitions, 1, 10);
const rate = values.rate === undefined ? undefined : number(values.rate, 1, 100000);
const label = values.label!;
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(label)) throw new Error("Invalid report label");
const profiles = {
  uniform: { weights: [1, 1, 1], delays: [0, 0, 0], unhealthy: false },
  weighted: { weights: [5, 3, 2], delays: [0, 0, 0], unhealthy: false },
  heterogeneous: { weights: [5, 3, 2], delays: [2, 10, 40], unhealthy: false },
  unhealthy: { weights: [5, 3, 2], delays: [2, 10, 40], unhealthy: true },
};
type Profile = keyof typeof profiles;
const requested = values.profiles!.split(",");
if (requested.some(p => !Object.hasOwn(profiles, p)) || new Set(requested).size !== requested.length) throw new Error("Invalid profile list");
const selected = requested as Profile[];
const algorithms = Object.values(Algorithm);
const rows: Record<string, unknown>[] = [];
const report = { schemaVersion: 1, timestamp: new Date().toISOString(), environment: environmentInfo(false),
  configuration: { durationMs, warmupMs, concurrency, repetitions, rate: rate ?? null, profiles: selected, algorithms },
  executionStatus: "running", rows,
  limitations: ["Separate loopback processes on a shared host; synthetic measurements only.",
    "Weights are configured preferences, not measured capacity. Closed-loop unless rate is supplied.",
    "Health is enabled for every strategy; unhealthy profile excludes one backend before warmup.",
    "Latency percentiles are approximate; missed controlled arrivals are reported, not treated as successful requests.",
    "No production throughput, leak-freedom or comparative speedup guarantee."] };
const directory = resolve("benchmarks/results");
await mkdir(directory, { recursive: true });
const path = resolve(directory, label + ".json");
async function save() { await writeFile(path, JSON.stringify(report, null, 2) + "\n"); }
await save();
try {
  for (const profile of selected) for (let repetition = 0; repetition < repetitions; repetition++) {
    // Rotate order across repetitions to reduce systematic warmup/host-order bias.
    for (let index = 0; index < algorithms.length; index++) {
      const algorithm = algorithms[(index + repetition) % algorithms.length]!;
      const config = profiles[profile];
      const env = await Environment.start({ count: 3, algorithm, weights: config.weights, applicationDelaysMs: config.delays,
        health: true, metrics: true, timeoutMs: 30_000 });
      try {
        if (config.unhealthy) await env.backends[2]!.call("health", { status: 503 });
        await waitFor(async () => {
          const pool = (await env.metrics()).pools[0]!;
          return pool.eligibility.healthy === (config.unhealthy ? 2 : 3) &&
            pool.eligibility.unhealthy === (config.unhealthy ? 1 : 0);
        });
        const options = { concurrency, requests: undefined, expectedBytes: smallPayload.length, keepAlive: true, rate };
        if (warmupMs) await env.load("/get", { ...options, durationMs: warmupMs });
        await env.quiet();
        await Promise.all(env.backends.map(w => w.call("resetStats")));
        const before = await env.metrics();
        await Promise.all(env.workers.map(w => w.call("resetResources")));
        const result = await env.load("/get", { ...options, durationMs });
        await env.quiet();
        const after = await env.metrics();
        const counts = await Promise.all(env.backends.map((_, i) => env.stats(i)));
        const resources = { proxy: await env.proxy.call<Resources>("resources"), client: await env.client.call<Resources>("resources"),
          backends: await Promise.all(env.backends.map(w => w.call<Resources>("resources"))) };
        const distribution = counts.map(c => c.applicationRequests);
        // Record the measured row before checking, so failures remain inspectable.
        const row = { profile, algorithm, repetition: repetition + 1, result, distribution,
          weights: config.weights, delaysMs: config.delays, resources, passed: false };
        rows.push(row);
        assert.ok(result.attempted > 0, "Empty benchmark population");
        assert.equal(result.failed + result.cancelled, 0);
        assert.equal(result.attempted, result.completed);
        assert.equal(distribution.reduce((a,b) => a+b, 0), result.completed);
        assert.equal(after.requests.total - before.requests.total, result.attempted);
        assert.ok(counts.every(c => c.active === 0 && c.unexpectedErrors === 0 && c.completed === c.applicationRequests));
        distribution.forEach((count, i) => assert.equal(result.backends[`backend-${i}`] ?? 0, count));
        if (config.unhealthy) assert.equal(distribution[2], 0);
        accounting(after);
        const stopped = await env.proxy.call<import("./types.js").ResourceState>("stop");
        for (const key of ["activeRequests", "activeUpstreamExchanges", "incomingSockets", "upstreamBusySockets", "upstreamIdleSockets", "agentPendingRequests"] as const) assert.equal(stopped[key], 0);
        row.passed = true;
        console.log(`${profile} ${algorithm} #${repetition+1}: ${result.requestsPerSecond.toFixed(1)} req/s; p95 ${result.latencyMs.p95.toFixed(2)} ms; p99 ${result.latencyMs.p99.toFixed(2)} ms; distribution ${distribution.join("/")}; missed ${result.missedArrivals}`);
        await save();
      } finally { await env.close(); }
    }
  }
  report.executionStatus = "completed";
} catch (error) {
  report.executionStatus = "failed";
  throw error;
} finally {
  await save();
  console.log(`Report: ${path}`);
}
