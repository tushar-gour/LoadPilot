import { test } from "node:test";
import assert from "node:assert/strict";
import { faultNames, runFault } from "../benchmarks/scenarios/faults.js";
import { Environment, accounting } from "../benchmarks/helpers/environment.js";
import { localTarget, validateLoad } from "../benchmarks/helpers/loadGenerator.js";
import { Histogram } from "../benchmarks/helpers/statistics.js";
import { ResourceMonitor } from "../benchmarks/helpers/resourceMonitor.js";
import { markdown, validateReport } from "../benchmarks/helpers/report.js";
import type { BenchmarkReport, ResourceState } from "../benchmarks/types.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";

for (const scenario of faultNames) {
  test(`Reliability: ${scenario}`, { timeout: 30_000 }, async () => {
    const result = await runFault(scenario);
    assert.equal(result.passed, true, result.details);
  });
}

test("Reliability: repeated fixture teardown releases process hooks and tracked sockets", { timeout: 20_000 }, async () => {
  const initialExitListeners = process.listenerCount("exit");
  for (let cycle = 0; cycle < 3; cycle++) {
    const environment = await Environment.start({ health: true });
    try {
      await environment.healthy();
      const result = await environment.load("/get", { requests: 12 });
      assert.equal(result.completed, 12); await environment.quiet(); accounting(await environment.metrics(), 12);
      const stopped = await environment.proxy.call<ResourceState>("stop");
      for (const key of ["activeRequests", "activeUpstreamExchanges", "incomingSockets", "upstreamBusySockets", "upstreamIdleSockets"] as const) assert.equal(stopped[key], 0);
    } finally { await environment.close(); }
    assert.ok(environment.workers.every((worker) => worker.child.exitCode === 0));
    assert.equal(process.listenerCount("exit"), initialExitListeners);
  }
});

test("Harness targets/configuration are bounded and loopback-only", () => {
  for (const target of ["http://example.com:80/", "https://127.0.0.1:443/", "http://user:secret@127.0.0.1:3000/", "http://localhost:3000/", "http://127.0.0.1:3000/#x"]) assert.throws(() => localTarget(target));
  assert.equal(localTarget("http://127.0.0.1:3000/get").hostname, "127.0.0.1");
  for (const concurrency of [0, -1, 1001, 1.5]) assert.throws(() => validateLoad({ targets: ["http://127.0.0.1:3000"], concurrency, durationMs: 100 }));
  assert.throws(() => validateLoad({ targets: ["http://127.0.0.1:3000"], concurrency: 1, durationMs: 0 }));
});

test("Harness histograms and sampler history have fixed storage bounds", (t) => {
  const histogram = new Histogram();
  for (let index = 0; index < 100_000; index++) histogram.record(index / 1000);
  assert.equal(histogram.snapshot().count, 100_000);
  assert.equal(histogram.snapshot().buckets.length, 201);
  assert.ok(histogram.snapshot().p50 <= histogram.snapshot().p95);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const monitor = new ResourceMonitor(undefined, 50);
  try {
    t.mock.timers.tick(50 * 1500);
    const snapshot = monitor.snapshot();
    assert.ok(snapshot.samplesTaken > 1500); assert.ok(snapshot.samples.length <= 600);
    assert.equal(snapshot.fileDescriptors, null);
  } finally { monitor.close(); }
});

test("Benchmark report schema and Markdown validate provenance", () => {
  const report: BenchmarkReport = { schemaVersion: 1, scenario: "validation", timestamp: new Date(0).toISOString(),
    environment: { node: process.version, platform: "test", cpu: "synthetic", osRelease: "test", logicalCpus: 1, totalRamBytes: 1,
      gitCommit: "a".repeat(40), workingTreeDirty: false, gcExposed: false }, configuration: {}, rows: [], faults: [], soak: [], limitations: [], passed: true };
  validateReport(report); assert.ok(markdown(report).includes("statistical significance"));
  assert.throws(() => validateReport({ ...report, environment: { ...report.environment, gitCommit: "invalid" } }));
});

test("Soak CLI bounds fractional remaining time and tears down both modes", { timeout: 15_000 }, async (t) => {
  const child = spawn(process.execPath, ["--import", "tsx", "benchmarks/run.ts", "soak", "--duration", "0.1", "--concurrency", "1",
    "--warmup", "0", "--label", "reliability-soak-smoke"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  const report: BenchmarkReport = JSON.parse(await readFile("benchmarks/results/reliability-soak-smoke.json", "utf8"));
  validateReport(report);
  assert.equal(report.passed, true); assert.equal(report.soak.length, 2);
  assert.ok(report.soak.every((run) => run.settled && run.actualDurationMs >= 100));
});
