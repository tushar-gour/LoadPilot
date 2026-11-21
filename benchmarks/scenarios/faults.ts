import assert from "node:assert/strict";
import { Environment, accounting } from "../helpers/environment.js";
import { waitFor } from "../helpers/processes.js";
import { hashBytes, smallPayload } from "../helpers/statistics.js";
import { createHash } from "node:crypto";
import type { BackendStats, FaultResult, LoadResult, ResourceState, Resources } from "../types.js";

const smallHash = createHash("sha256").update(smallPayload).digest("hex");
async function withEnvironment(options: Parameters<typeof Environment.start>[0], run: (environment: Environment) => Promise<string>): Promise<string> {
  const environment = await Environment.start(options);
  try {
    const result = await run(environment);
    for (const worker of environment.backends) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) assert.equal((await worker.call<BackendStats>("stats")).unexpectedErrors, 0);
    }
    return result;
  } finally { await environment.close(); }
}
function successful(result: LoadResult, count?: number) {
  assert.equal(result.failed, 0, JSON.stringify(result.errors));
  assert.equal(result.cancelled, 0);
  assert.equal(result.completed, result.attempted);
  if (count !== undefined) assert.equal(result.completed, count);
}
async function loaded(environment: Environment, path = "/get", requests = 30, concurrency = 10) {
  const result = await environment.load(path, { requests, concurrency, expectedBytes: smallPayload.length, expectedHash: smallHash });
  successful(result, requests); await environment.quiet(); return result;
}

const cases: { name: string; run: () => Promise<string> }[] = [
  { name: "graceful-completion", run: () => withEnvironment({ count: 2, health: true }, async (environment) => {
    await environment.healthy();
    const pending = environment.load("/hang", { requests: 6, concurrency: 6 });
    await waitFor(async () => (await environment.stats(0)).active + (await environment.stats(1)).active === 6);
    const stopping = environment.proxy.call<ResourceState>("stop", { mode: "graceful", timeoutMs: 2000 });
    await waitFor(async () => (await environment.proxy.call<{ state: string }>("status")).state === "draining");
    await Promise.all(environment.backends.map((worker) => worker.call("release")));
    successful(await pending, 6);
    const state = await stopping; assert.equal(state.incomingSockets, 0); assert.equal(state.agentPendingRequests, 0);
    const metrics = await environment.metrics(); accounting(metrics, 6); assert.equal(metrics.requests.shutdownCancelled, 0);
    await environment.restartProxy(); await loaded(environment, "/get", 6); accounting(await environment.metrics(), 12);
    return "Six admitted requests across two healthy backends completed during drain; zero sockets/queues; same-instance forwarding after restart";
  }) },
  { name: "graceful-deadline", run: () => withEnvironment({}, async (environment) => {
    const pending = environment.load("/hang", { requests: 8, concurrency: 8 });
    await waitFor(async () => (await environment.stats()).active === 8);
    const state = await environment.proxy.call<ResourceState>("stop", { mode: "graceful", timeoutMs: 40 });
    assert.equal((await pending).failed, 8); assert.equal(state.incomingSockets, 0); assert.equal(state.agentPendingRequests, 0);
    const metrics = await environment.metrics(); accounting(metrics, 8);
    assert.equal(metrics.requests.shutdownCancelled, 8); assert.equal(metrics.requests.failed, 0);
    return "40 ms grace deadline cancelled eight stalled exchanges exactly once; all active scopes and native queues zero";
  }) },
  { name: "graceful-immediate-escalation", run: () => withEnvironment({}, async (environment) => {
    const pending = environment.load("/hang", { requests: 6, concurrency: 6 });
    await waitFor(async () => (await environment.stats()).active === 6);
    const graceful = environment.proxy.call<ResourceState>("stop", { mode: "graceful", timeoutMs: 300_000 });
    await waitFor(async () => (await environment.proxy.call<{ state: string }>("status")).state === "draining");
    const immediate = environment.proxy.call<ResourceState>("stop", { mode: "immediate" });
    for (const state of await Promise.all([graceful, immediate])) assert.equal(state.activeUpstreamExchanges, 0);
    assert.equal((await pending).failed, 6);
    const metrics = await environment.metrics(); accounting(metrics, 6); assert.equal(metrics.requests.shutdownCancelled, 6);
    return "Immediate stop escalated a five-minute drain; both callers settled with six cancellations and no duplicate accounting";
  }) },
  { name: "backend-death-during-drain", run: () => withEnvironment({}, async (environment) => {
    const pending = environment.load("/hang", { requests: 8, concurrency: 8, expectedStatus: 502 });
    await waitFor(async () => (await environment.stats()).active === 8);
    const stopping = environment.proxy.call<ResourceState>("stop", { mode: "graceful", timeoutMs: 2000 });
    await waitFor(async () => (await environment.proxy.call<{ state: string }>("status")).state === "draining");
    await environment.backends[0].terminate(); successful(await pending, 8); await stopping;
    const metrics = await environment.metrics(); accounting(metrics, 8);
    assert.equal(metrics.requests.upstreamFailures, 8); assert.equal(metrics.requests.shutdownCancelled, 0);
    return "Backend process death during drain produced eight transport-failure 502 responses, with no shutdown misclassification";
  }) },
  { name: "restart-keepalive", run: () => withEnvironment({}, async (environment) => {
    for (let cycle = 0; cycle < 5; cycle++) {
      await loaded(environment);
      const state = await environment.proxy.call<ResourceState>("stop");
      assert.equal(state.activeUpstreamExchanges, 0); assert.equal(state.upstreamBusySockets, 0); assert.equal(state.upstreamIdleSockets, 0);
      assert.equal(state.incomingSockets, 0);
      accounting(await environment.metrics(), (cycle + 1) * 30);
      if (cycle < 4) await environment.restartProxy();
    }
    return "5 actual forwarding/stop/start cycles; upstream agents reused successfully; 150 requests; all tracked sockets zero after stop";
  }) },
  { name: "concurrent-round-robin", run: () => withEnvironment({ count: 3 }, async (environment) => {
    const result = await loaded(environment, "/get", 300, 50);
    assert.deepEqual(Object.values(result.backends).sort((a, b) => a - b), [100, 100, 100]);
    const stats = await Promise.all(environment.backends.map((worker) => worker.call<BackendStats>("stats")));
    assert.deepEqual(stats.map((item) => item.applicationRequests), [100, 100, 100]);
    const metrics = await environment.metrics(); accounting(metrics, 300);
    assert.deepEqual(metrics.pools[0].backends.map((item) => item.requests.total), [100, 100, 100]);
    return "300 requests at concurrency 50: client headers, backend counts and metrics each show exactly 100/100/100 selections";
  }) },
  { name: "independent-pool-rotation", run: () => withEnvironment({ count: 3, routes: [
    { route: "/a", indices: [0, 1, 2] }, { route: "/b", indices: [0, 1] },
  ] }, async (environment) => {
    const result = await environment.load("/a/get", { targets: [environment.proxy.info.url + "/a/get", environment.proxy.info.url + "/b/get"],
      requests: 301, concurrency: 50, expectedHash: smallHash });
    successful(result, 301); await environment.quiet();
    const metrics = await environment.metrics(); accounting(metrics, 301);
    assert.deepEqual(metrics.pools.map((pool) => pool.requests.total), [151, 150]);
    assert.deepEqual(metrics.pools[0].backends.map((item) => item.requests.total), [51, 50, 50]);
    assert.deepEqual(metrics.pools[1].backends.map((item) => item.requests.total), [75, 75]);
    return "301 concurrent requests: /a rotates 51/50/50 independently of /b 75/75";
  }) },
  { name: "large-streaming", run: () => withEnvironment({ timeoutMs: 20_000 }, async (environment) => {
    for (const bytes of [1, 8, 32].map((size) => size * 1024 * 1024)) {
      successful(await environment.load("/upload", { method: "POST", payloadBytes: bytes, validateUpload: true, uploadHash: hashBytes(bytes), requests: 1, concurrency: 1, timeoutMs: 20_000 }));
      successful(await environment.load(`/download?bytes=${bytes}`, { expectedBytes: bytes, expectedHash: hashBytes(bytes), requests: 1, concurrency: 1, timeoutMs: 20_000 }));
    }
    await environment.quiet(); accounting(await environment.metrics(), 6);
    return "SHA-256 verified 1/8/32 MiB uploads and downloads using reusable 64 KiB chunks; no whole-payload fixture";
  }) },
  { name: "slow-backpressure", run: () => withEnvironment({ sampleMs: 50, timeoutMs: 20_000 }, async (environment) => {
    const bytes = 8 * 1024 * 1024;
    await environment.proxy.call("resetResources");
    const upload = await environment.load("/slow-upload?ms=2", { method: "POST", payloadBytes: bytes, validateUpload: true, uploadHash: hashBytes(bytes),
      requests: 1, concurrency: 1, timeoutMs: 20_000 });
    successful(upload); assert.ok(upload.uploadBackpressureEvents > 0);
    successful(await environment.load(`/download?bytes=${bytes}&chunked=true`, { expectedHash: hashBytes(bytes), expectedBytes: bytes,
      slowReadMs: 2, requests: 1, concurrency: 1, timeoutMs: 20_000 }));
    await environment.quiet();
    const stats = await environment.stats(), resources = await environment.proxy.call<Resources>("resources");
    assert.ok(stats.slowReads > 0); assert.ok(stats.blockedWrites > 0);
    assert.ok(resources.peakBufferedRequestBytes < 2 * 1024 * 1024);
    assert.ok(resources.peakBufferedResponseBytes < 2 * 1024 * 1024);
    accounting(await environment.metrics(), 2);
    return `Slow 8 MiB receivers verified hashes; blocked writes ${stats.blockedWrites}; sampled proxy buffers read/write ${resources.peakBufferedRequestBytes}/${resources.peakBufferedResponseBytes} bytes (<2 MiB each)`;
  }) },
  { name: "connection-refusal-no-replay", run: () => withEnvironment({ count: 2 }, async (environment) => {
    await environment.backends[0].call("stop");
    successful(await environment.load("/post", { method: "POST", jsonBody: true, requests: 30, concurrency: 10, expectedStatuses: [200, 502] }), 30);
    await environment.quiet();
    const metrics = await environment.metrics(); accounting(metrics, 30);
    assert.equal(metrics.requests.upstreamFailures, 15); assert.equal(metrics.requests.completed, 15);
    assert.equal((await environment.stats(1)).applicationRequests, 15);
    return "15 refused POST selections returned 502; exactly 15 other selections reached the healthy server; no replay";
  }) },
  { name: "abrupt-reset", run: () => withEnvironment({}, async (environment) => {
    successful(await environment.load("/reset", { requests: 60, concurrency: 20, expectedStatus: 502 }), 60);
    await environment.quiet(); const metrics = await environment.metrics(); accounting(metrics, 60);
    assert.equal(metrics.requests.upstreamFailures, 60);
    assert.equal((await environment.stats()).applicationRequests, 60);
    return "60 deterministic socket resets returned 502 once each; all active gauges zero";
  }) },
  { name: "deadline-delays-and-streams", run: () => withEnvironment({ timeoutMs: 150 }, async (environment) => {
    successful(await environment.load("/delay?ms=10", { requests: 1, concurrency: 1 }), 1);
    for (const path of ["/delay?ms=1000", "/hang"]) successful(await environment.load(path, { requests: 1, concurrency: 1, expectedStatus: 504 }), 1);
    const stream = await environment.load("/slow-download?bytes=2097152&ms=20", { requests: 1, concurrency: 1 });
    assert.equal(stream.failed, 1); assert.equal(stream.statuses["200"], 1);
    await environment.quiet(); const metrics = await environment.metrics(); accounting(metrics, 4);
    assert.equal(metrics.requests.upstreamTimeouts, 3); assert.equal(metrics.responses.incomplete, 1);
    return "Below-deadline delay completed; stalled/late responses gave 504; continuously active stream still hit total deadline after 200 headers";
  }) },
  { name: "partial-response", run: () => withEnvironment({}, async (environment) => {
    const result = await environment.load("/partial", { requests: 20, concurrency: 10 });
    assert.equal(result.failed, 20); assert.equal(result.statuses["200"], 20); assert.equal(result.statuses["502"], undefined);
    await environment.quiet(); const metrics = await environment.metrics(); accounting(metrics, 20);
    assert.equal(metrics.responses.incomplete, 20); assert.equal(metrics.responses.completed, 0);
    assert.equal(metrics.requests.upstreamFailures, 20);
    return "20 partial 200 responses terminated; no second 502 and exactly 20 incomplete exchanges";
  }) },
  { name: "application-errors", run: () => withEnvironment({}, async (environment) => {
    for (const code of [400, 404, 429, 500, 503]) successful(await environment.load(`/status?code=${code}`, { expectedStatus: code, requests: 10 }), 10);
    await environment.quiet(); const metrics = await environment.metrics(); accounting(metrics, 50);
    assert.equal(metrics.requests.failed, 0); assert.equal(metrics.requests.completed, 50);
    assert.equal(metrics.responses.backend.status4xx, 30); assert.equal(metrics.responses.backend.status5xx, 20);
    return "50 valid application 400/404/429/500/503 responses were completed backend responses, not transport failures";
  }) },
  { name: "backend-process-termination-recovery", run: () => withEnvironment({ health: true, timeoutMs: 3000 }, async (environment) => {
    await environment.healthy();
    const pending = Promise.allSettled([environment.load("/hang", { requests: 12, concurrency: 12, expectedStatus: 502 })]);
    await waitFor(async () => (await environment.stats()).active === 12);
    await environment.backends[0].terminate();
    const [outcome] = await pending; if (outcome.status === "rejected") throw outcome.reason;
    successful(outcome.value, 12);
    await waitFor(async () => (await environment.metrics()).pools[0].eligibility.unhealthy === 1);
    successful(await environment.load("/get", { expectedStatus: 503, requests: 6 }), 6);
    await environment.replaceBackend(0); await environment.healthy(); await loaded(environment, "/get", 12);
    await environment.quiet(); const metrics = await environment.metrics(); accounting(metrics, 30);
    assert.equal(metrics.requests.upstreamFailures, 12); assert.equal(metrics.requests.noEligibleBackend, 6);
    assert.equal(metrics.pools[0].health.unhealthyTransitions, 1); assert.equal(metrics.pools[0].health.healthyTransitions, 2);
    return "Backend process killed with 12 active requests; 502 then confirmed-unhealthy 503; a new process on the same port recovered and served 12 requests";
  }) },
  { name: "health-recovery-under-load", run: () => withEnvironment({ count: 3, health: true }, async (environment) => {
    await environment.healthy(); await loaded(environment, "/get", 90, 30);
    await environment.backends[0].call("health", { status: 503 });
    await waitFor(async () => (await environment.metrics()).pools[0].eligibility.unhealthy === 1);
    const before = (await environment.stats()).applicationRequests;
    await loaded(environment, "/get", 60, 20); assert.equal((await environment.stats()).applicationRequests, before);
    await environment.backends[1].call("health", { status: 503 }); await environment.backends[2].call("health", { status: 503 });
    await waitFor(async () => (await environment.metrics()).pools[0].eligibility.eligible === 0);
    successful(await environment.load("/get", { requests: 30, expectedStatus: 503 }), 30);
    for (const worker of environment.backends) await worker.call("health", { status: 200 });
    await environment.healthy();
    const prior = await Promise.all(environment.backends.map((worker) => worker.call<BackendStats>("stats")));
    await loaded(environment, "/get", 90, 30);
    const after = await Promise.all(environment.backends.map((worker) => worker.call<BackendStats>("stats")));
    assert.deepEqual(after.map((item, index) => item.applicationRequests - prior[index].applicationRequests), [30, 30, 30]);
    const metrics = await environment.metrics(); accounting(metrics, 270);
    assert.equal(metrics.requests.noEligibleBackend, 30);
    return "Healthy rotation, one excluded backend, all-unhealthy 503, then recovery restored 30/30/30 concurrent selections";
  }) },
  { name: "client-disconnect-stages", run: () => withEnvironment({ health: true, timeoutMs: 3000 }, async (environment) => {
    await environment.healthy();
    for (const [path, cancel] of [["/delay?ms=1000", "before-response"], ["/hang", "before-response"],
      ["/upload", "upload"], ["/download?bytes=33554432", "response"]] as const) {
      const result = await environment.load(path, { requests: 6, concurrency: 6, cancel, method: cancel === "upload" ? "POST" : "GET" });
      assert.equal(result.cancelled, 6); await environment.quiet();
    }
    const metrics = await environment.metrics(); accounting(metrics);
    assert.equal(metrics.requests.cancelled, metrics.requests.total); assert.ok(metrics.requests.total > 0);
    assert.equal(metrics.requests.failed, 0); assert.equal(metrics.pools[0].health.unhealthyTransitions, 0);
    return `24 clients disconnected before headers, while stalled, during upload and during response; ${metrics.requests.total} handler-accepted exchanges cancelled once without health penalty`;
  }) },
  { name: "shutdown-active", run: () => withEnvironment({ timeoutMs: 3000 }, async (environment) => {
    const pending = Promise.allSettled([environment.load("/hang", { requests: 12, concurrency: 12 })]);
    await waitFor(async () => (await environment.stats()).active === 12);
    const state = await environment.proxy.call<ResourceState>("stop");
    const [outcome] = await pending; if (outcome.status === "rejected") throw outcome.reason;
    assert.equal(outcome.value.failed, 12); assert.equal(state.activeUpstreamExchanges, 0);
    const stopped = await environment.metrics(); accounting(stopped, 12);
    assert.equal(stopped.requests.shutdownCancelled, 12); assert.equal(stopped.requests.failed, 0);
    await environment.restartProxy(); await loaded(environment, "/get", 6);
    accounting(await environment.metrics(), 18);
    return "Shutdown cancelled 12 stalled exchanges once; fresh forwarding after same-instance restart retained correct totals";
  }) },
  { name: "remove-backend-and-pending-probe", run: () => withEnvironment({ health: true, timeoutMs: 3000 }, async (environment) => {
    await environment.healthy();
    const pending = Promise.allSettled([environment.load("/hang", { requests: 6, concurrency: 6 })]);
    await waitFor(async () => (await environment.stats()).active === 6);
    await environment.backends[0].call("health", { delayMs: 1000 });
    await waitFor(async () => (await environment.stats()).activeHealthProbes > 0);
    const prior = (await environment.metrics()).pools[0].health.failedProbes;
    await environment.proxy.call("remove");
    await waitFor(async () => (await environment.stats()).activeHealthProbes === 0);
    assert.equal((await environment.metrics()).pools[0].backends[0].requests.active, 6);
    assert.equal((await environment.metrics()).pools[0].health.failedProbes, prior);
    await environment.backends[0].call("release");
    const [outcome] = await pending; if (outcome.status === "rejected") throw outcome.reason; successful(outcome.value, 6);
    await environment.quiet(); assert.equal((await environment.metrics()).pools[0].backends.length, 0);
    await environment.backends[0].call("health", { delayMs: 0 });
    await environment.proxy.call("add", environment.backends[0].info.url); await environment.healthy(); await loaded(environment, "/get", 6);
    accounting(await environment.metrics(), 12);
    return "Removal cancelled a pending probe without false failure, preserved six in-flight responses, dropped retired rows, and safely re-added a fresh backend identity";
  }) },
  { name: "intermittent-health", run: () => withEnvironment({ health: true }, async (environment) => {
    await environment.healthy(); await environment.backends[0].call("health", { sequence: [503, 200] });
    const result = await environment.load("/get", { durationMs: 600, requests: 100_000, concurrency: 10 });
    successful(result); await environment.quiet();
    const metrics = await environment.metrics(); accounting(metrics, result.attempted);
    assert.ok(metrics.pools[0].health.failedProbes >= 2); assert.equal(metrics.pools[0].health.unhealthyTransitions, 0);
    return `Alternating health failures/successes under ${result.attempted} requests never reached consecutive-failure threshold`;
  }) },
  { name: "probe-timeout-recovery", run: () => withEnvironment({ health: true }, async (environment) => {
    await environment.healthy(); await environment.backends[0].call("health", { delayMs: 1000 });
    await waitFor(async () => (await environment.metrics()).pools[0].eligibility.unhealthy === 1);
    assert.ok((await environment.metrics()).pools[0].health.timeoutProbes >= 2);
    successful(await environment.load("/get", { expectedStatus: 503, requests: 12 }), 12);
    await environment.backends[0].call("health", { delayMs: 0 }); await environment.healthy(); await loaded(environment, "/get", 30);
    accounting(await environment.metrics(), 42);
    return "Probe total deadlines excluded the backend; health recovery restored forwarding without restart";
  }) },
  { name: "controlled-arrival-backlog", run: () => withEnvironment({}, async (environment) => {
    const result = await environment.load("/delay?ms=30", { concurrency: 2, durationMs: 150, requests: 10000, rate: 5000 });
    successful(result); assert.ok(result.missedArrivals > 0); assert.equal(result.clientLimited, true);
    assert.equal(result.scheduled, 750); assert.equal(result.attempted + result.missedArrivals, result.scheduled);
    assert.equal(result.latencyMs.buckets.length, 201); assert.equal(result.schedulingDelayMs.buckets.length, 201);
    await environment.quiet(); accounting(await environment.metrics(), result.attempted);
    return `Target 5000/s with concurrency 2 explicitly reported ${result.missedArrivals} missed arrivals, bounded pending work and scheduling delay`;
  }) },
];

export const faultNames = cases.map((item) => item.name);
export async function runFault(name: string): Promise<FaultResult> {
  const scenario = cases.find((item) => item.name === name);
  if (!scenario) throw new Error(`Unknown fault scenario ${name}`);
  const start = performance.now();
  try { return { name, passed: true, details: await scenario.run(), durationMs: performance.now() - start }; }
  catch (error) { return { name, passed: false, details: error instanceof Error ? error.message : String(error), durationMs: performance.now() - start }; }
}
