import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import { Environment, accounting } from "../helpers/environment.js";
import { memoryTrend } from "../helpers/analysis.js";
import { TimeSeries } from "../helpers/timeSeries.js";
import { waitFor } from "../helpers/processes.js";
import { Histogram, hashBytes, smallPayload } from "../helpers/statistics.js";
import type { BackendStats, DiagnosticCheckpoint, LoadOptions, MemoryRun, Resources, ResourceState } from "../types.js";

export const memoryScenarios = ["idle", "get", "metrics", "health-idle", "health-get", "download-1", "download-8", "download-32",
  "upload-1", "upload-8", "upload-32", "cancel", "failures", "keepalive-off", "churn", "churn-metrics", "restart", "mixed"] as const;
export interface MemoryOptions {
  durationMs: number; warmupMs: number; idleMs: number; sampleMs: number; concurrency: number;
  batchRequests: number; gc: boolean; snapshots: boolean; gcDuringLoad?: boolean;
}
export function failureStatuses(phase: number, health: boolean): number[] {
  // A refused exchange may trigger active confirmation before the next
  // selection. Subsequent requests can legitimately get unavailable-pool 503.
  return phase === 0 ? health ? [502, 503] : [502] : [phase === 1 ? 502 : phase === 2 ? 504 : 200];
}

export async function memoryExperiment(scenario: string, options: MemoryOptions, onEnvironment?: (value: Environment | undefined) => void): Promise<MemoryRun> {
  if (!(memoryScenarios as readonly string[]).includes(scenario)) throw new Error(`Unknown memory scenario ${scenario}`);
  const metricsEnabled = ["metrics", "churn-metrics", "mixed"].includes(scenario);
  const healthEnabled = ["health-idle", "health-get", "mixed"].includes(scenario);
  const keepAlive = scenario !== "keepalive-off";
  const environment = await Environment.start({ metrics: metricsEnabled, health: healthEnabled, gc: options.gc,
    sampleMs: options.sampleMs, timeoutMs: 1000, upstreamKeepAlive: keepAlive });
  onEnvironment?.(environment);
  const started = performance.now(), checkpoints: DiagnosticCheckpoint[] = [], histogram = new Histogram();
  const settledSeries = new TimeSeries<DiagnosticCheckpoint>(Math.max(1, options.durationMs / 256));
  const gcSeries = new TimeSeries<DiagnosticCheckpoint>(Math.max(1, options.durationMs / 256));
  let attempted = 0, completed = 0, failed = 0, cancelled = 0, batches = 0;
  const checkpoint = async (label: string) => {
    const value = await environment.proxy.call<Omit<DiagnosticCheckpoint, "label" | "elapsedMs">>("diagnostics");
    const point = { ...value, label, elapsedMs: performance.now() - started };
    if (label === "settled") settledSeries.add(point);
    else if (label === "settled-GC") gcSeries.add(point);
    else checkpoints.push(point);
    return point;
  };
  try {
    await checkpoint("startup");
    if (healthEnabled) await environment.healthy();
    if (options.warmupMs && !scenario.endsWith("idle")) await environment.load("/get", { durationMs: options.warmupMs, requests: undefined, concurrency: options.concurrency, keepAlive });
    else if (options.warmupMs) await sleep(options.warmupMs);
    await environment.quiet(); await checkpoint("warmup-end"); await sleep(100);
    if (options.gc) assert.equal(await environment.proxy.call("gc"), true);
    const baseline = await checkpoint("baseline");
    if (options.snapshots) await environment.proxy.call("heapSnapshot", undefined, 120000);
    const loadStarted = performance.now();
    while (performance.now() - loadStarted < options.durationMs) {
      if (scenario.endsWith("idle")) await sleep(Math.min(500, Math.max(1, options.durationMs - (performance.now() - loadStarted))));
      else {
        let kind = scenario;
        if (kind === "mixed") kind = ["get", "metrics", "download-8", "cancel", "failures", "churn-metrics", "restart", "health-transition"][batches % 8];
        let path = "/get";
        const config: Partial<LoadOptions> = { requests: options.batchRequests, concurrency: options.concurrency, durationMs: 5000, timeoutMs: 3000,
          keepAlive, expectedBytes: smallPayload.length, expectedHash: createHash("sha256").update(smallPayload).digest("hex") };
        if (kind.startsWith("download-") || kind.startsWith("upload-")) {
          const bytes = Number(kind.split("-")[1]) * 1048576;
          config.requests = Math.min(2, options.batchRequests); config.concurrency = Math.min(2, options.concurrency);
          path = kind.startsWith("upload") ? "/upload" : `/download?bytes=${bytes}`;
          if (kind.startsWith("upload")) Object.assign(config, { method: "POST", payloadBytes: bytes, validateUpload: true, uploadHash: hashBytes(bytes), expectedBytes: undefined, expectedHash: undefined });
          else Object.assign(config, { expectedBytes: bytes, expectedHash: hashBytes(bytes) });
        } else if (kind === "cancel") {
          path = "/download?bytes=33554432"; Object.assign(config, { cancel: "response", expectedBytes: undefined, expectedHash: undefined });
        } else if (kind === "health-transition") {
          await environment.backends[0].call("health", { status: 503 });
          await waitFor(async () => (await environment.metrics()).pools[0].eligibility.unhealthy === 1);
          Object.assign(config, { expectedStatus: 503, expectedBytes: undefined, expectedHash: undefined });
        } else if (kind === "failures") {
          const phase = batches % 5;
          path = ["/get", "/reset", "/hang", "/partial", "/get"][phase];
          Object.assign(config, { expectedBytes: undefined, expectedHash: undefined, expectedStatuses: failureStatuses(phase, healthEnabled) });
          if (phase === 0) await environment.backends[0].call("stop");
          if (phase === 4) { await environment.replaceBackend(0); if (healthEnabled) await environment.healthy(); }
        }
        const result = await environment.load(path, config);
        attempted += result.attempted; completed += result.completed; failed += result.failed; cancelled += result.cancelled; histogram.merge(result.latencyMs);
        // Truncated responses and deliberate cancellations have different client
        // outcomes; all other synthetic responses must validate fully.
        if (kind === "failures" && path === "/partial") {
          assert.equal(result.failed, result.attempted); assert.equal(result.statuses["200"], result.attempted);
          assert.equal(result.statuses["502"], undefined);
        }
        else if (kind === "cancel") assert.equal(result.cancelled, result.attempted);
        else assert.equal(result.failed + result.cancelled, 0, JSON.stringify({ scenario, kind, batch: batches, path, statuses: result.statuses, errors: result.errors }));
        if (kind === "failures" && batches % 5 === 0) {
          environment.backends[0].info = await environment.backends[0].call("start"); if (healthEnabled) await environment.healthy();
        }
        if (kind === "health-transition") { await environment.backends[0].call("health", { status: 200 }); await environment.healthy(); }
        await environment.quiet();
        if (kind.startsWith("churn")) {
          assert.equal(await environment.proxy.call("remove"), true);
          await environment.proxy.call("add", environment.backends[0].info.url);
          if (healthEnabled) await environment.healthy();
        }
        if (kind === "restart") { await environment.restartProxy(); if (healthEnabled) await environment.healthy(); }
      }
      batches++;
      await environment.quiet(); await sleep(100); let current = await checkpoint("settled");
      if (options.gc && options.gcDuringLoad !== false) { await environment.proxy.call("gc"); current = await checkpoint("settled-GC"); }
      assert.equal(current.sample.activeRequests, 0); assert.equal(current.sample.activeUpstreamExchanges, 0);
      assert.equal(current.sample.agentPendingRequests, 0);
      assert.equal(current.metricScopes?.active, 0); assert.equal(current.metricScopes?.retiredActive, 0);
      assert.equal(current.metricScopes?.currentBackends, 1);
      assert.deepEqual(current.listeners, baseline.listeners);
      if (metricsEnabled) accounting(await environment.metrics());
    }
    const actualLoadMs = performance.now() - loadStarted;
    await checkpoint("load-end");
    const resources = await environment.proxy.call<Resources>("resources");
    const clientResources = await environment.client.call<Resources>("resources");
    const backendResources = await Promise.all(environment.backends.map((worker) => worker.call<Resources>("resources")));
    await sleep(options.idleMs / 2); await checkpoint("idle-mid");
    await sleep(options.idleMs / 2); await checkpoint("idle-end");
    if (options.gc) { await environment.proxy.call("gc"); await checkpoint("idle-GC"); await sleep(1000); await checkpoint("post-GC-idle"); }
    if (options.snapshots) await environment.proxy.call("heapSnapshot", undefined, 120000);
    const metrics = metricsEnabled ? await environment.metrics() : undefined;
    if (metrics) accounting(metrics);
    const postStop = await environment.proxy.call<ResourceState>("stop");
    for (const key of ["activeRequests", "activeUpstreamExchanges", "incomingSockets", "upstreamBusySockets", "upstreamIdleSockets", "agentPendingRequests"] as const) assert.equal(postStop[key], 0);
    await checkpoint("stopped");
    const backendStats = await Promise.all(environment.backends.map((worker) => worker.call<BackendStats>("stats")));
    assert.ok(backendStats.every((stats) => stats.unexpectedErrors === 0));
    const settled = (options.gc && options.gcDuringLoad !== false ? gcSeries : settledSeries).values();
    checkpoints.push(...settledSeries.values(), ...gcSeries.values());
    checkpoints.sort((a,b) => a.elapsedMs-b.elapsedMs);
    return { scenario, metricsEnabled, healthEnabled, keepAlive, configuredDurationMs: options.durationMs, actualLoadMs,
      actualTotalMs: performance.now() - started, batches, attempted, completed, failed, cancelled, upstreamTimeouts: metrics?.requests.upstreamTimeouts ?? null,
      latencyMs: histogram.snapshot(), checkpoints, resources, clientResources, backendResources, backendStats,
      trend: memoryTrend([baseline, ...settled], completed, resources.samples.map((sample) => ({ elapsedMs: sample.elapsedMs, sample }))), postStop, passed: true,
      ...(metrics ? { metrics } : {}) };
  } finally { await environment.close(); onEnvironment?.(undefined); }
}
