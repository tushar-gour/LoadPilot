import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Environment, accounting } from "../helpers/environment.js";
import { capacityDecision } from "../helpers/analysis.js";
import { smallPayload, jsonPayload } from "../helpers/statistics.js";
import type { BackendStats, CapacityRun, LoadOptions, LoadResult, Resources, Slo } from "../types.js";

export interface CapacityOptions {
  rates: number[]; profiles: string[]; repetitions: number; durationMs: number; warmupMs: number;
  concurrency: number; sampleMs: number; slo: Slo;
}
export async function capacitySweep(options: CapacityOptions, record: (run: CapacityRun) => Promise<void>, onEnvironment?: (value: Environment | undefined) => void): Promise<void> {
  for (const profile of options.profiles) for (const rate of options.rates) for (let repetition = 0; repetition < options.repetitions; repetition++) {
    const modes: CapacityRun["mode"][] = ["direct", "proxy", "metrics", "health"];
    const offset = (repetition + options.rates.indexOf(rate)) % modes.length;
    for (const mode of [...modes.slice(offset), ...modes.slice(0, offset)]) {
      const environment = await Environment.start({ direct: mode === "direct", metrics: mode === "metrics" || mode === "health", health: mode === "health", sampleMs: options.sampleMs });
      onEnvironment?.(environment);
      try {
        if (mode === "health") await environment.healthy();
        const payload = profile === "json" ? jsonPayload : smallPayload;
        const load: LoadOptions = { targets: [(mode === "direct" ? environment.backends[0].info.url : environment.proxy.info.url) + (profile === "json" ? "/json" : "/get")],
          durationMs: options.durationMs, rate, concurrency: options.concurrency, timeoutMs: 5000, keepAlive: true,
          expectedBytes: payload.length, expectedHash: createHash("sha256").update(payload).digest("hex") };
        if (options.warmupMs) await environment.client.call("load", { ...load, durationMs: options.warmupMs }, options.warmupMs + 10000);
        await environment.quiet();
        const before = mode === "metrics" || mode === "health" ? (await environment.metrics()).requests.total : 0;
        await environment.backends[0].call("resetStats");
        await Promise.all(environment.workers.map((worker) => worker.call("resetResources")));
        const result = await environment.client.call<LoadResult>("load", load, options.durationMs + 10000);
        await environment.quiet();
        const stats = await environment.stats(); assert.equal(stats.unexpectedErrors, 0);
        const metrics = mode === "metrics" || mode === "health" ? await environment.metrics() : undefined;
        if (metrics) { accounting(metrics); assert.equal(metrics.requests.total - before, result.attempted); }
        assert.ok(stats.applicationRequests <= result.attempted);
        if (result.failed === 0 && result.cancelled === 0) assert.equal(stats.applicationRequests, result.attempted);
        const run: CapacityRun = { profile, mode, repetition: repetition + 1, offeredRate: rate, durationMs: options.durationMs, concurrency: options.concurrency,
          result, backendRequests: stats.applicationRequests, resources: { client: await environment.client.call<Resources>("resources"), proxy: mode === "direct" ? null : await environment.proxy.call<Resources>("resources"),
            backends: await Promise.all(environment.backends.map((worker) => worker.call<Resources>("resources"))) },
          http5xx: Object.entries(result.statuses).reduce((sum, [code, count]) => sum + (Number(code) >= 500 ? count : 0), 0),
          upstreamTimeouts: metrics?.requests.upstreamTimeouts ?? null, decision: capacityDecision(result, options.slo) };
        await record(run);
      } finally { await environment.close(); onEnvironment?.(undefined); }
    }
  }
}
