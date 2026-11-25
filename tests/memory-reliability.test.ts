import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { capacityDecision, highestPassing, memoryTrend, slope } from "../benchmarks/helpers/analysis.js";
import { TimeSeries } from "../benchmarks/helpers/timeSeries.js";
import { arrivalPlan } from "../benchmarks/helpers/loadGenerator.js";
import { ResourceMonitor, heapDiagnostics } from "../benchmarks/helpers/resourceMonitor.js";
import { Histogram, hashBytes } from "../benchmarks/helpers/statistics.js";
import { Environment, accounting } from "../benchmarks/helpers/environment.js";
import { memoryExperiment, failureStatuses } from "../benchmarks/scenarios/memory.js";
import { markdown, validateReport } from "../benchmarks/helpers/report.js";
import type { BenchmarkReport, DiagnosticCheckpoint, LoadResult, Slo } from "../benchmarks/types.js";

const slo: Slo = { p95Ms: 50, p99Ms: 100, maxErrorRate: 0.001, arrivalTolerance: 0.02, completionTolerance: 0.02 };
function distribution(count = 100, value = 1) { const histogram = new Histogram(); for (let index = 0; index < count; index++) histogram.record(value); return histogram.snapshot(); }
function result(): LoadResult {
  return { attempted: 100, completed: 100, failed: 0, cancelled: 0, timedOut: 0, elapsedMs: 1000, issuingMs: 1000, requestsPerSecond: 100, attemptedPerSecond: 100,
    statuses: { "200": 100 }, errors: {}, backends: {}, latencyMs: distribution(), scheduleLatencyMs: distribution(100, 2), headersLatencyMs: distribution(),
    schedulingDelayMs: distribution(), scheduled: 100, missedArrivals: 0, missedScheduling: 0, missedConcurrency: 0, clientLimited: false,
    bytesReceived: 1000, uploadBackpressureEvents: 0, peakConcurrency: 5, reusedSockets: 95, newSockets: 5 };
}
function report(): BenchmarkReport {
  return { schemaVersion: 1, scenario: "unit", timestamp: new Date(0).toISOString(), executionStatus: "completed",
    environment: { node: process.version, platform: process.platform, osRelease: "synthetic", cpu: "synthetic", logicalCpus: 1, totalRamBytes: 1,
      gitCommit: "a".repeat(40), workingTreeDirty: false, gcExposed: false }, configuration: {}, rows: [], faults: [], soak: [], passed: true, limitations: [] };
}

test("Arrival catch-up preserves due slots without exceeding free concurrency", () => {
  assert.deepEqual(arrivalPlan(3, 10, 0), { launches: 3, schedulingMisses: 0, concurrencyMisses: 0 });
  assert.deepEqual(arrivalPlan(100, 10, 0), { launches: 10, schedulingMisses: 90, concurrencyMisses: 0 });
  assert.deepEqual(arrivalPlan(10, 10, 6), { launches: 4, schedulingMisses: 0, concurrencyMisses: 6 });
  assert.deepEqual(arrivalPlan(3, 10, 10), { launches: 0, schedulingMisses: 0, concurrencyMisses: 3 });
});

test("SLO evaluates errors, schedule latency and documented arrival tolerance", () => {
  assert.equal(capacityDecision(result(), slo).passed, true);
  const tolerated = { ...result(), scheduled: 101, missedArrivals: 1, missedScheduling: 1, clientLimited: true };
  assert.equal(capacityDecision(tolerated, slo).passed, true);
  const limited = { ...result(), scheduled: 200, missedArrivals: 100, missedConcurrency: 100 };
  assert.equal(capacityDecision(limited, slo).classification, "client-limited");
  assert.equal(capacityDecision({ ...result(), completed: 99, failed: 1 }, slo).classification, "SLO-failed");
  assert.equal(capacityDecision({ ...result(), scheduleLatencyMs: distribution(100, 200) }, slo).classification, "SLO-failed");
  assert.equal(capacityDecision({ ...result(), elapsedMs: 2000, requestsPerSecond: 50 }, slo).classification, "SLO-failed");
  assert.throws(() => capacityDecision(result(), { ...slo, maxErrorRate: -1 }));
});

test("Empty or partial capacity populations cannot claim SLO success", () => {
  assert.equal(capacityDecision({ ...result(), attempted: 0 }, slo).classification, "inconclusive");
  assert.equal(capacityDecision({ ...result(), scheduled: 90 }, slo).classification, "inconclusive");
  assert.equal(capacityDecision({ ...result(), scheduleLatencyMs: distribution(99) }, slo).classification, "inconclusive");
  assert.equal(highestPassing([]), null);
  assert.equal(highestPassing([{ offeredRate: 100, decision: capacityDecision(result(), slo) }], 2), null);
  assert.equal(highestPassing([{ offeredRate: 100, decision: capacityDecision(result(), slo) },
    { offeredRate: 200, decision: capacityDecision(result(), slo) },
    { offeredRate: 200, decision: capacityDecision({ ...result(), completed: 90, failed: 10 }, slo) }]), 100);
});

test("Merged bounded histograms preserve all outcomes including overflow", () => {
  const histogram = new Histogram(); histogram.merge(distribution(3, 2)); histogram.merge(distribution(2, 1e9));
  assert.equal(histogram.snapshot().count, 5); assert.equal(histogram.snapshot().max, 1e9);
  assert.equal(histogram.snapshot().buckets.reduce((sum, value) => sum + value, 0), 5);
  assert.equal(histogram.snapshot().buckets.length, 201);
  assert.throws(() => histogram.merge({ ...distribution(), count: 1 }));
});

test("V8 diagnostics and sampler expose finite explicitly labeled memory categories", () => {
  const monitor = new ResourceMonitor();
  try {
    const resource = monitor.snapshot(), heap = heapDiagnostics(), sample = resource.samples.at(-1)!;
    assert.ok(heap.limit >= heap.used); assert.ok(heap.spaces.length > 0);
    assert.ok(heap.spaces.every((space) => Number.isFinite(space.used) && space.used >= 0));
    assert.ok(resource.peakExternal >= sample.external); assert.ok(resource.peakArrayBuffers >= sample.arrayBuffers);
    assert.ok(resource.eventLoopDelayMs.mean === null || Number.isFinite(resource.eventLoopDelayMs.mean));
    monitor.reset(); assert.ok(monitor.snapshot().samples.length <= 3);
  } finally { monitor.close(); }
});

test("Memory slopes distinguish short evidence, sustained growth and plateaus", () => {
  assert.equal(slope([]), null); assert.equal(slope([{ x: 1, y: 2 }, { x: 1, y: 3 }]), null);
  assert.equal(slope([{ x: 0, y: 1 }, { x: 2, y: 5 }]), 2);
  const monitor = new ResourceMonitor();
  try {
    const base: DiagnosticCheckpoint = { label: "settled-GC", elapsedMs: 0, sample: monitor.snapshot().samples.at(-1)!, heap: heapDiagnostics(),
      rssMinusHeapTotal: 0, resources: {}, listeners: {}, metricScopes: null };
    const points = Array.from({ length: 12 }, (_, index) => ({ ...base, elapsedMs: index * 10000, sample: { ...base.sample,
      rss: 60 * 1048576 + Math.min(index, 2) * 10 * 1048576, heapUsed: 10 * 1048576, external: 3 * 1048576 } }));
    assert.equal(memoryTrend([], 0).classification, "Inconclusive");
    assert.equal(memoryTrend(points, 1000).classification, "Likely warmup or allocator retention");
    assert.equal(memoryTrend(points.map((point, index) => ({ ...point, sample: { ...point.sample, rss: index * 10 * 1048576 } })), 1000).classification, "Suspicious retained growth");
  } finally { monitor.close(); }
});

test("Time-series retention stays bounded and spans the entire elapsed run", () => {
  const series = new TimeSeries<{ elapsedMs: number; value: number }>(1, 64);
  for (let i = 0; i < 100000; i++) series.add({ elapsedMs: i, value: i });
  const values = series.values();
  assert.ok(values.length <= 64);
  assert.ok(values[0]!.elapsedMs < 100000 / 10);
  assert.equal(values.at(-1)!.elapsedMs, 99999);
  for (let quarter = 0; quarter < 4; quarter++) assert.ok(values.some(v => Math.floor(v.elapsedMs / 25000) === quarter));
  assert.throws(() => series.add({ elapsedMs: 1, value: 1 }), /Non-monotonic/);
});

test("Sparse historical checkpoints and a dense short tail cannot establish memory stability or growth", () => {
  const monitor = new ResourceMonitor();
  try {
    const base: DiagnosticCheckpoint = { label: "settled-GC", elapsedMs: 0, sample: monitor.snapshot().samples.at(-1)!, heap: heapDiagnostics(), rssMinusHeapTotal: 0, resources: {}, listeners: {}, metricScopes: null };
    const point = (elapsedMs: number, rss: number) => ({ ...base, elapsedMs, sample: { ...base.sample, rss, heapUsed: 10*1048576, external: 3*1048576 } });
    const points = [point(0, 100*1048576), point(100, 100*1048576), ...Array.from({ length: 240 }, (_, i) => point(1776000 + i*100, (100+i/10)*1048576))];
    const trend = memoryTrend(points, 1000);
    assert.equal(trend.classification, "Inconclusive");
    assert.equal(trend.lateRssBytesPerSecond, null);
    const steady = Array.from({length: 61}, (_, i) => point(i*30000, 100*1048576));
    assert.equal(memoryTrend(steady, 1000).classification, "No concerning growth observed");
    const growing = steady.map((p,i) => point(p.elapsedMs, (100+i*5)*1048576));
    assert.equal(memoryTrend(growing, 1000).classification, "Suspicious retained growth");
    const burst = [...steady.slice(0,-1), ...Array.from({length: 200}, (_, i) => point(1790000+i*50, 100*1048576)), steady.at(-1)!];
    assert.equal(memoryTrend(burst, 1000).classification, "No concerning growth observed");
  } finally { monitor.close(); }
});

test("Memory checkpoints serialize empty workloads and teardown children", { timeout: 15000 }, async () => {
  const listeners = process.listenerCount("exit");
  const run = await memoryExperiment("idle", { durationMs: 100, warmupMs: 0, idleMs: 20, sampleMs: 50, concurrency: 1, batchRequests: 1, gc: false, snapshots: false });
  assert.equal(run.attempted, 0); assert.equal(run.latencyMs.count, 0); assert.equal(run.postStop.agentPendingRequests, 0);
  assert.ok(run.checkpoints.some((point) => point.label === "idle-end"));
  const value = { ...report(), memory: [run] }; validateReport(value);
  assert.ok(markdown(value).includes("Memory isolation")); assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  assert.equal(process.listenerCount("exit"), listeners);
});

test("Diagnostics retain no active scopes, queues or listeners after mixed exchanges and restart", { timeout: 15000 }, async () => {
  const environment = await Environment.start({ metrics: true, health: true });
  try {
    await environment.healthy();
    const baseline = await environment.proxy.call<DiagnosticCheckpoint>("diagnostics");
    assert.deepEqual(baseline.healthStates, ["HEALTHY"]);
    for (let cycle = 0; cycle < 2; cycle++) {
      const load = await environment.load("/download?bytes=1048576", { requests: 4, concurrency: 2, expectedBytes: 1048576, expectedHash: hashBytes(1048576), rate: 100 });
      assert.equal(load.failed, 0); assert.equal(load.scheduleLatencyMs.count, load.attempted);
      assert.ok(load.scheduleLatencyMs.average >= load.latencyMs.average);
      assert.ok(load.peakConcurrency <= 2); assert.equal(load.newSockets + load.reusedSockets, load.attempted);
      const reset = await environment.load("/reset", { expectedStatus: 502, requests: 3 }); assert.equal(reset.failed, 0);
      const cancel = await environment.load("/download?bytes=33554432", { cancel: "response", requests: 3 }); assert.equal(cancel.cancelled, 3);
      await environment.quiet(); accounting(await environment.metrics());
      const point = await environment.proxy.call<DiagnosticCheckpoint>("diagnostics");
      assert.equal(point.metricScopes?.active, 0); assert.equal(point.sample.agentPendingRequests, 0);
      assert.deepEqual(point.listeners, baseline.listeners);
      await environment.restartProxy(); await environment.healthy();
    }
  } finally { await environment.close(); }
});

test("Health-enabled refusal batches accept transport 502 followed by confirmed-unavailable 503", { timeout: 15000 }, async () => {
  const environment = await Environment.start({ health: true });
  try {
    await environment.healthy(); await environment.backends[0].call("stop");
    const load = await environment.load("/get", { requests: 60, concurrency: 8, expectedStatuses: failureStatuses(0, true) });
    assert.equal(load.failed, 0); await environment.quiet();
    const metrics = await environment.metrics(); accounting(metrics, 60);
    assert.equal(metrics.requests.upstreamFailures + metrics.requests.noEligibleBackend, 60);
    assert.equal(load.statuses["502"] ?? 0, metrics.requests.upstreamFailures);
    assert.equal(load.statuses["503"] ?? 0, metrics.requests.noEligibleBackend);
  } finally { await environment.close(); }
});

test("Backend replacement releases exited worker wrappers and process hooks", { timeout: 15000 }, async () => {
  const initial = process.listenerCount("exit");
  const environment = await Environment.start();
  try {
    const count = environment.workers.length;
    for (let index = 0; index < 2; index++) {
      const old = environment.backends[0]; await environment.replaceBackend(0);
      assert.ok(old.child.exitCode !== null || old.child.signalCode !== null);
      assert.equal(environment.workers.length, count); assert.equal(environment.workers.includes(old), false);
      assert.equal(process.listenerCount("exit"), initial + count);
      assert.equal((await environment.load("/get", { requests: 6 })).failed, 0);
    }
  } finally { await environment.close(); }
  assert.equal(process.listenerCount("exit"), initial);
});

test("Capacity serialization rejects inconsistent results without hiding partial status", () => {
  const monitor = new ResourceMonitor();
  try {
  const value: BenchmarkReport = { ...report(), executionStatus: "running", capacity: [{ profile: "get", mode: "direct", repetition: 1, offeredRate: 100,
    durationMs: 1000, concurrency: 10, result: result(), resources: { client: monitor.snapshot(), proxy: null, backends: [] },
    http5xx: 0, upstreamTimeouts: null, decision: capacityDecision(result(), slo) }] };
  validateReport(value); assert.ok(markdown(value).includes("execution: running"));
  assert.ok(markdown(value).includes("Schedule p50/p95/p99"));
  value.capacity![0].result.scheduled = 101; assert.throws(() => validateReport(value));
  } finally { monitor.close(); }
});

test("Investigation CLI rejects unsafe bounds before opening fixtures", { timeout: 10000 }, async () => {
  for (const args of [["memory", "--duration", "0"], ["capacity", "--rates", "0"], ["memory", "--label", "../outside"], ["capacity", "--gc"]]) {
    const child = spawn(process.execPath, ["--import", "tsx", "benchmarks/investigate.ts", ...args], { windowsHide: true, stdio: "ignore" });
    const [code] = await once(child, "exit"); assert.notEqual(code, 0);
  }
});
