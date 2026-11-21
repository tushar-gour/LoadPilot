import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import { Environment, accounting } from "./helpers/environment.js";
import { environmentInfo, writeReport } from "./helpers/report.js";
import { Histogram, hashBytes, jsonPayload, smallPayload } from "./helpers/statistics.js";
import { faultNames, runFault } from "./scenarios/faults.js";
import type { BackendStats, BenchmarkReport, BenchmarkRow, LoadOptions, Resources, ResourceState, ResourceSample, DiagnosticCheckpoint } from "./types.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  full: { type: "boolean", default: false }, concurrency: { type: "string" }, duration: { type: "string" },
  warmup: { type: "string" }, repetitions: { type: "string" }, profiles: { type: "string" },
  requests: { type: "string" }, rate: { type: "string" }, "timeout-ms": { type: "string" },
  "sample-ms": { type: "string" }, "keep-alive": { type: "string", default: "true" }, gc: { type: "boolean", default: false },
  scenario: { type: "string" }, "payload-mib": { type: "string" },
  label: { type: "string" },
  diagnostics: { type: "boolean", default: false }, idle: { type: "string" },
} });
const command = positionals[0] ?? "bench";
if (!["bench", "stream", "fault", "soak"].includes(command) || positionals.length > 1) throw new Error("Use bench, stream, fault or soak");
if (values.gc && command !== "soak") throw new Error("Explicit GC is supported only for soak");
if (values.label !== undefined && !/^[a-z0-9-]{1,48}$/.test(values.label)) throw new Error("Invalid result label");
function number(value: string | undefined, fallback: number, min: number, max: number, integer = true): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) throw new Error(`Invalid numeric option ${value}`);
  return result;
}
const durationMs = Math.round(number(values.duration, command === "soak" ? 60 : values.full ? 2 : 1, 0.1, 86400, false) * 1000);
const warmupMs = Math.round(number(values.warmup, 0.25, 0, 60, false) * 1000);
const repetitions = number(values.repetitions, 3, 1, 10);
const concurrencies = (values.concurrency ?? (values.full ? "1,10,50" : "1,10")).split(",").map((value) => number(value, 10, 1, 1000));
if (concurrencies.length > 10) throw new Error("At most 10 concurrency levels");
const sampleMs = number(values["sample-ms"], 200, 50, 30000);
const timeoutMs = number(values["timeout-ms"], 5000, 1, 120000);
const idleMs = Math.round(number(values.idle, 0, 0, 300, false) * 1000);
if ((values.diagnostics || idleMs) && command !== "soak") throw new Error("Diagnostics and idle recovery apply only to soak");
if (!["true", "false"].includes(values["keep-alive"] ?? "")) throw new Error("keep-alive must be true or false");
const requestLimit = values.requests === undefined ? undefined : number(values.requests, 1, 1, 10_000_000);
const rate = values.rate === undefined ? undefined : number(values.rate, 1, 1, 100_000);
const report: BenchmarkReport = { schemaVersion: 1, scenario: command, timestamp: new Date().toISOString(),
  environment: environmentInfo(values.gc ?? false), configuration: { ...values, durationMs, warmupMs, repetitions, concurrencies, sampleMs, timeoutMs,
    fixtureHealth: { intervalMs: 50, timeoutMs: 100, unhealthyThreshold: 2, healthyThreshold: 2 } },
  rows: [], faults: [], soak: [], passed: true, limitations: [
    "Local synthetic HTTP-only harness run on a shared host; CPU scheduling, loopback TCP, client hashing, TSX, native allocators, monitoring and warmup affect results. No statistical significance is claimed.",
    "Separate generator, proxy and backend processes; no external targets. A harness-only adapter pins the existing LoadPilot listener to 127.0.0.1.",
    "Warmup is excluded from client throughput and backend counts; proxy lifetime snapshots include warmup, with measured metricsRequestDelta recorded separately.",
    "Client percentiles use 201 fixed histogram bins (0.05 ms then 10% spacing, overflow at observed max); they are approximations.",
    "Resource windows include settling and IPC snapshots; CPU percent is relative to one core. Socket counts are instrumented Node listener/agent sockets, not OS TIME_WAIT or file descriptors.",
    "Sampling retains at most 600 points by deterministic decimation. RSS growth alone does not prove a leak; short runs cannot prove memory leak freedom.",
  ] };
let activeEnvironment: Environment | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  void activeEnvironment?.close().finally(() => process.exit(1));
  if (!activeEnvironment) process.exit(1);
});

function payloadOptions(profile: string): { path: string; options: Partial<LoadOptions>; count: number } {
  if (profile === "get" || profile === "backends" || profile === "pools") return { path: "/get", count: profile === "get" ? 1 : 3,
    options: { expectedBytes: smallPayload.length, expectedHash: createHash("sha256").update(smallPayload).digest("hex") } };
  if (profile === "json") return { path: "/json", count: 1, options: { expectedBytes: jsonPayload.length, expectedHash: createHash("sha256").update(jsonPayload).digest("hex") } };
  if (profile === "post") return { path: "/post", count: 1, options: { method: "POST", jsonBody: true, validateUpload: true } };
  const bytes = profile === "64k" ? 65536 : profile === "1m" ? 1048576 : 0;
  if (!bytes) throw new Error(`Unknown profile ${profile}`);
  return { path: `/download?bytes=${bytes}`, count: 1, options: { expectedBytes: bytes, expectedHash: hashBytes(bytes) } };
}

async function benchmark(): Promise<void> {
  const profiles = (values.profiles ?? (values.full ? "get,json,post,64k,1m,pools,backends" : "get")).split(",");
  if (profiles.length * concurrencies.length * repetitions * 3 > 1000) throw new Error("Benchmark matrix exceeds 1000 phases");
  for (const profile of profiles) payloadOptions(profile);
  for (const profile of profiles) for (const concurrency of concurrencies) for (let repetition = 0; repetition < repetitions; repetition++) {
    const modes: BenchmarkRow["mode"][] = ["direct", "proxy", "metrics"];
    const ordered = [...modes.slice(repetition % 3), ...modes.slice(0, repetition % 3)];
    for (const mode of ordered) {
      const configuration = payloadOptions(profile);
      const environment = await Environment.start({ direct: mode === "direct", metrics: mode === "metrics", count: configuration.count, sampleMs,
        routes: profile === "pools" ? [{ route: "/a", indices: [0, 1, 2] }, { route: "/b", indices: [0, 1] }] : undefined });
      activeEnvironment = environment;
      try {
        const targets = profile === "pools" ? mode === "direct" ? Array.from({ length: 12 }, (_, index) =>
          environment.backends[Math.floor(index / 2) % (index % 2 ? 2 : 3)].info.url + (index % 2 ? "/b/get" : "/a/get")) :
          [environment.proxy.info.url + "/a/get", environment.proxy.info.url + "/b/get"] :
          mode === "direct" ? environment.backends.map((worker) => worker.info.url + configuration.path) : [environment.proxy.info.url + configuration.path];
        const options: LoadOptions = { targets, concurrency, durationMs, requests: requestLimit, timeoutMs,
          keepAlive: values["keep-alive"] === "true", rate, ...configuration.options };
        if (warmupMs) await environment.client.call("load", { ...options, durationMs: warmupMs, requests: undefined }, warmupMs + timeoutMs + 5000);
        await environment.quiet();
        const before = mode === "metrics" ? (await environment.metrics()).requests.total : 0;
        for (const worker of environment.backends) await worker.call("resetStats");
        await Promise.all(environment.workers.map((worker) => worker.call("resetResources")));
        const result = await environment.client.call<BenchmarkRow["result"]>("load", options, durationMs + timeoutMs + 5000);
        await environment.quiet();
        const backendCounts = await Promise.all(environment.backends.map((worker) => worker.call<BackendStats>("stats")));
        const metrics = mode === "metrics" ? await environment.metrics() : null;
        if (metrics) accounting(metrics);
        const metricsRequestDelta = metrics ? metrics.requests.total - before : null;
        const passed = result.failed === 0 && result.cancelled === 0 && backendCounts.every((item) => item.unexpectedErrors === 0) && backendCounts.reduce((sum, item) => sum + item.applicationRequests, 0) === result.attempted &&
          (metricsRequestDelta === null || metricsRequestDelta === result.attempted);
        const row: BenchmarkRow = { scenario: profile, mode, concurrency, repetition: repetition + 1,
          payloadBytes: profile === "post" ? jsonPayload.length : options.expectedBytes ?? 0, method: options.method ?? "GET",
          warmupMs, durationMs, healthEnabled: false, metricsEnabled: mode === "metrics", upstreamTimeoutMs: mode === "direct" ? null : 30000,
          result, backendCounts, metrics, metricsRequestDelta, passed,
          resources: { client: await environment.client.call("resources"), proxy: mode === "direct" ? null : await environment.proxy.call("resources"),
            backends: await Promise.all(environment.backends.map((worker) => worker.call<Resources>("resources"))) } };
        report.rows.push(row); report.passed &&= passed;
        console.log(`${profile} c=${concurrency} run=${repetition + 1} ${mode}: ${result.requestsPerSecond.toFixed(1)}/s p95=${result.latencyMs.p95.toFixed(2)}ms errors=${result.failed} ${passed ? "PASS" : "FAIL"}`);
      } finally { await environment.close(); activeEnvironment = undefined; }
    }
  }
}

async function streaming(): Promise<void> {
  if (values["payload-mib"] !== undefined) {
    const bytes = number(values["payload-mib"], 32, 1, 256) * 1024 * 1024;
    const environment = await Environment.start({ timeoutMs, sampleMs }); activeEnvironment = environment;
    const started = performance.now();
    try {
      const upload = await environment.load("/upload", { method: "POST", payloadBytes: bytes, uploadHash: hashBytes(bytes), validateUpload: true, requests: concurrencies[0], concurrency: concurrencies[0], timeoutMs });
      const download = await environment.load(`/download?bytes=${bytes}`, { expectedBytes: bytes, expectedHash: hashBytes(bytes), requests: concurrencies[0], concurrency: concurrencies[0], timeoutMs });
      assert.equal(upload.failed + download.failed, 0); await environment.quiet(); accounting(await environment.metrics(), 2 * concurrencies[0]);
      report.faults.push({ name: `stream-${bytes}-bytes`, passed: true, details: "Exact streaming upload/download SHA-256 checks passed", durationMs: performance.now() - started });
    } finally { await environment.close(); activeEnvironment = undefined; }
    return;
  }
  // These scenarios verify 1/8/32 MiB and instrumented slow-reader backpressure.
  for (const name of ["large-streaming", "slow-backpressure", "deadline-delays-and-streams"]) report.faults.push(await runFault(name));
}

async function soak(): Promise<void> {
  for (const metrics of [false, true]) {
    const environment = await Environment.start({ metrics, health: true, sampleMs, timeoutMs, gc: values.gc }); activeEnvironment = environment;
    try {
      await environment.healthy();
      if (warmupMs) await environment.load("/get", { durationMs: warmupMs, requests: undefined });
      await environment.quiet();
      await sleep(200); await environment.proxy.call("gc"); await environment.proxy.call("resetResources");
      const initial = await environment.proxy.call<Resources>("resources");
      const diagnostics: DiagnosticCheckpoint[] = [];
      const diagnosticStarted = performance.now();
      const checkpoint = async (label: string) => {
        if (!values.diagnostics) return;
        diagnostics.push({ ...await environment.proxy.call<Omit<DiagnosticCheckpoint, "label" | "elapsedMs">>("diagnostics"), label, elapsedMs: performance.now() - diagnosticStarted });
      };
      await checkpoint("baseline");
      const started = performance.now(), workloads = new Set<string>(), settledSamples: ResourceSample[] = [];
      let cycles = 0, attempted = 0, completed = 0, failed = 0, cancelled = 0;
      const latencies = new Histogram();
      while (performance.now() - started < durationMs) {
        const phase = cycles % 6;
        const paths = ["/get", "/post", "/reset", "/download?bytes=1048576", "/download?bytes=1048576", "/get"];
        const labels = ["GET", "POST", "reset", "cancel-response", "stream-1MiB", "health-transition"];
        workloads.add(labels[phase]);
        if (phase === 5) {
          await environment.backends[0].call("health", { status: 503 });
          await waitForHealth(environment, 1);
        }
        const result = await environment.load(paths[phase], { durationMs: Math.round(Math.min(500, Math.max(100, durationMs - (performance.now() - started)))), requests: undefined,
          concurrency: concurrencies[0], jsonBody: phase === 1, method: phase === 1 ? "POST" : "GET",
          timeoutMs,
          validateUpload: phase === 1, cancel: phase === 3 ? "response" : undefined,
          expectedStatus: phase === 2 ? 502 : phase === 5 ? 503 : 200,
          expectedHash: phase === 4 ? hashBytes(1048576) : undefined });
        assert.equal(result.failed, 0, JSON.stringify(result.errors));
        attempted += result.attempted; completed += result.completed; failed += result.failed; cancelled += result.cancelled; latencies.merge(result.latencyMs);
        if (phase === 5) { await environment.backends[0].call("health", { status: 200 }); await environment.healthy(); }
        await environment.quiet();
        if (cycles % 7 === 6) { await environment.restartProxy(); await environment.healthy(); workloads.add("restart"); }
        if (cycles % 3 === 2) {
          await environment.proxy.call("remove"); await environment.proxy.call("add", environment.backends[0].info.url);
          await environment.healthy(); workloads.add("backend-churn");
        }
        await sleep(100); await environment.proxy.call("gc");
        const sample = (await environment.proxy.call<Resources>("resources")).samples.at(-1);
        if (sample) settledSamples.push(sample);
        if (settledSamples.length >= 600) settledSamples.splice(1, settledSamples.length - 300);
        if (metrics) accounting(await environment.metrics());
        cycles++;
      }
      const final = await environment.proxy.call<Resources>("resources");
      const actualDurationMs = performance.now() - started;
      await checkpoint("load-end");
      if (idleMs) { await sleep(idleMs); await checkpoint("idle-end"); if (values.gc) { await environment.proxy.call("gc"); await checkpoint("idle-GC"); await sleep(1000); await checkpoint("post-GC-idle"); } }
      const postStop = await environment.proxy.call<ResourceState>("stop");
      await checkpoint("stopped");
      const settled = postStop.activeRequests === 0 && postStop.activeUpstreamExchanges === 0 && postStop.upstreamBusySockets === 0 && postStop.upstreamIdleSockets === 0 && postStop.incomingSockets === 0;
      assert.ok(settled);
      report.soak.push({ mode: metrics ? "metrics" : "proxy", cycles, actualDurationMs,
        initial, final, settled, workloads: [...workloads], postStop, settledSamples, diagnostics,
        requests: { attempted, completed, failed, cancelled, latencyMs: latencies.snapshot() } });
      console.log(`soak ${metrics ? "metrics" : "disabled"}: ${cycles} batches, ${(actualDurationMs / 1000).toFixed(2)}s load; active/sockets zero`);
    } finally { await environment.close(); activeEnvironment = undefined; }
  }
}

async function waitForHealth(environment: Environment, unhealthy: number): Promise<void> {
  const { waitFor } = await import("./helpers/processes.js");
  await waitFor(async () => (await environment.metrics()).pools[0].eligibility.unhealthy === unhealthy);
}

try {
  if (command === "bench") await benchmark();
  else if (command === "stream") await streaming();
  else if (command === "soak") await soak();
  else {
    for (const name of values.scenario ? [values.scenario] : faultNames) {
      const result = await runFault(name); report.faults.push(result); console.log(`${result.passed ? "PASS" : "FAIL"} ${name}: ${result.details}`);
    }
  }
} catch (error) {
  report.passed = false;
  report.limitations.push(`Execution failure: ${error instanceof Error ? error.message : String(error)}`);
  console.error(error);
} finally {
  report.passed &&= report.faults.every((result) => result.passed);
  await writeReport(report, values.label ?? command);
  if (!report.passed) process.exitCode = 1;
}
