import { parseArgs } from "node:util";
import { Environment } from "./helpers/environment.js";
import { validateSlo } from "./helpers/analysis.js";
import { environmentInfo, writeReport } from "./helpers/report.js";
import { memoryExperiment, memoryScenarios } from "./scenarios/memory.js";
import { capacitySweep } from "./scenarios/capacity.js";
import type { BenchmarkReport, Slo } from "./types.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  mode: { type: "string", default: "smoke" }, duration: { type: "string" }, warmup: { type: "string", default: "0.5" }, idle: { type: "string", default: "2" },
  scenarios: { type: "string" }, rates: { type: "string", default: "100,500,1500" }, profiles: { type: "string", default: "get,json" },
  repetitions: { type: "string", default: "2" }, concurrency: { type: "string", default: "20" }, "sample-ms": { type: "string", default: "200" },
  "batch-requests": { type: "string", default: "20" }, gc: { type: "boolean", default: false }, "gc-policy": { type: "string", default: "checkpoint" }, snapshots: { type: "boolean", default: false },
  "p95-ms": { type: "string", default: "50" }, "p99-ms": { type: "string", default: "100" }, "error-rate": { type: "string", default: "0.001" },
  "arrival-tolerance": { type: "string", default: "0.02" }, "completion-tolerance": { type: "string", default: "0.02" }, label: { type: "string" },
} });
function numeric(value: string | undefined, fallback: number, min: number, max: number, integer = false) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) throw new Error(`Invalid numeric option: ${value}`);
  return result;
}
const command = positionals[0];
if (!["memory", "capacity", "soak"].includes(command ?? "") || positionals.length !== 1) throw new Error("Use memory, capacity or soak");
if (!["smoke", "investigation", "extended"].includes(values.mode ?? "")) throw new Error("Invalid investigation mode");
if (values.snapshots && command === "capacity") throw new Error("Heap snapshots are available only in synthetic memory fixtures");
if (values.gc && command === "capacity") throw new Error("Explicit GC is only available for memory investigations");
if (!["checkpoint", "end"].includes(values["gc-policy"] ?? "")) throw new Error("GC policy must be checkpoint or end");
const durationMs = Math.round(numeric(values.duration, values.mode === "extended" ? 600 : values.mode === "investigation" ? 120 : 3, 0.1, 86400) * 1000);
const warmupMs = Math.round(numeric(values.warmup, 0.5, 0, 60) * 1000), idleMs = Math.round(numeric(values.idle, 2, 0, 300) * 1000);
const concurrency = numeric(values.concurrency, 20, 1, 500, true), sampleMs = numeric(values["sample-ms"], 200, 50, 30000, true);
const batchRequests = numeric(values["batch-requests"], 20, 1, 1000, true), repetitions = numeric(values.repetitions, 2, 1, 5, true);
const label = values.label ?? (command === "capacity" ? "capacity" : command === "soak" ? "extended-soak" : "memory-isolation");
if (!/^[a-z0-9-]{1,48}$/.test(label)) throw new Error("Invalid result label");
const scenarios = values.scenarios?.split(",") ?? (command === "soak" ? ["mixed"] : ["idle", "get", "metrics", "download-8"]);
if (scenarios.length > 20 || scenarios.some((scenario) => !(memoryScenarios as readonly string[]).includes(scenario))) throw new Error("Invalid memory scenario list");
if (values.snapshots && scenarios.length !== 1) throw new Error("Select exactly one memory scenario for at most two heap snapshots");
const rates = values.rates!.split(",").map((value) => numeric(value, 100, 1, 100000, true));
if (rates.length > 10 || new Set(rates).size !== rates.length) throw new Error("Provide at most ten distinct rates");
rates.sort((a, b) => a - b);
const profiles = values.profiles!.split(",");
if (!profiles.length || profiles.length > 2 || profiles.some((profile) => !["get", "json"].includes(profile))) throw new Error("Capacity profiles: get,json");
if (rates.length * profiles.length * repetitions * 4 > 300) throw new Error("Capacity matrix exceeds 300 phases");
const slo: Slo = { p95Ms: numeric(values["p95-ms"], 50, 0.001, 120000), p99Ms: numeric(values["p99-ms"], 100, 0.001, 120000),
  maxErrorRate: numeric(values["error-rate"], 0.001, 0, 1), arrivalTolerance: numeric(values["arrival-tolerance"], 0.02, 0, 1), completionTolerance: numeric(values["completion-tolerance"], 0.02, 0, 1) };
validateSlo(slo);
const report: BenchmarkReport = { schemaVersion: 1, scenario: command!, timestamp: new Date().toISOString(), environment: environmentInfo(values.gc ?? false),
  configuration: { ...values, durationMs, warmupMs, idleMs, concurrency, sampleMs, batchRequests, repetitions, rates, profiles, scenarios, slo },
  rows: [], faults: [], soak: [], memory: [], capacity: [], passed: true, executionStatus: "running", limitations: [
    "Separate synthetic loopback processes on a shared host; sampled peaks and approximate percentiles, no statistical significance or production-capacity guarantee.",
    "RSS minus heap-total is a diagnostic difference, not a measurement exclusively of native allocations. External includes ArrayBuffers; do not add these categories.",
    "V8 details are collected only at checkpoints. Explicit GC and heap snapshots are opt-in fixture diagnostics, never production behavior.",
    "Schedule-relative latency includes dispatch delay only for attempted requests; skipped arrival slots remain explicitly counted, not assigned invented latencies.",
    "SLO failure is a measured finding, not a harness failure. Highest passing rate means every executed repetition passed; it is not maximum sustainable capacity.",
  ] };
let active: Environment | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  void (async () => { report.passed = false; report.executionStatus = "interrupted"; report.limitations.push(`Interrupted by ${signal}; report is partial`); await active?.close(); await writeReport(report, label); process.exit(1); })();
});
await writeReport(report, label);
try {
  if (command === "capacity") await capacitySweep({ rates, profiles, repetitions, durationMs, warmupMs, concurrency, sampleMs, slo }, async (run) => {
    report.capacity!.push(run); await writeReport(report, label);
    console.log(`${run.profile} ${run.mode} offered=${run.offeredRate}/s run=${run.repetition}: completed=${run.result.requestsPerSecond.toFixed(1)}/s misses=${run.result.missedArrivals} schedule-p99=${run.result.scheduleLatencyMs.p99.toFixed(2)}ms ${run.decision.classification}`);
  }, (environment) => { active = environment; });
  else for (const scenario of scenarios) {
    const run = await memoryExperiment(scenario, { durationMs, warmupMs, idleMs, sampleMs, concurrency, batchRequests, gc: values.gc ?? false, gcDuringLoad: values["gc-policy"] === "checkpoint", snapshots: values.snapshots ?? false }, (environment) => { active = environment; });
    report.memory!.push(run); await writeReport(report, label);
    console.log(`${scenario}: ${(run.actualLoadMs / 1000).toFixed(2)}s, ${run.attempted} requests, ${run.trend.classification}; stopped resources zero`);
  }
} catch (error) { report.passed = false; report.limitations.push(`Execution failure: ${error instanceof Error ? error.message : String(error)}`); console.error(error); }
finally { if (report.executionStatus !== "interrupted") report.executionStatus = report.passed ? "completed" : "failed"; await writeReport(report, label); if (!report.passed) process.exitCode = 1; }
