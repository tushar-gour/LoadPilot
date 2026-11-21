import { cpus, platform, release, totalmem } from "node:os";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { median } from "./statistics.js";
import { highestPassing } from "./analysis.js";
import type { BenchmarkReport } from "../types.js";

export function environmentInfo(gc: boolean): BenchmarkReport["environment"] {
  return { node: process.version, platform: platform(), osRelease: release(), cpu: cpus()[0]?.model ?? "unavailable",
    logicalCpus: cpus().length, totalRamBytes: totalmem(),
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(),
    workingTreeDirty: !!execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", windowsHide: true }).trim(), gcExposed: gc };
}

export function validateReport(value: BenchmarkReport): void {
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(value.environment.gitCommit)) throw new Error("Invalid report provenance");
  for (const row of value.rows) {
    const result = row.result;
    if (result.attempted !== result.completed + result.failed + result.cancelled) throw new Error("Invalid client accounting");
    if (result.latencyMs.count !== result.attempted || result.latencyMs.buckets.length !== 201) throw new Error("Invalid client histogram");
    if (result.missedArrivals !== result.missedScheduling + result.missedConcurrency) throw new Error("Invalid arrival accounting");
    if (![result.requestsPerSecond, result.latencyMs.average, result.elapsedMs].every(Number.isFinite)) throw new Error("Nonfinite report result");
    if (result.latencyMs.p50 > result.latencyMs.p95 || result.latencyMs.p95 > result.latencyMs.p99) throw new Error("Invalid latency order");
    for (const resource of [row.resources.client, row.resources.proxy, ...row.resources.backends]) {
      if (resource && resource.samples.length > 600) throw new Error("Unbounded resource report");
    }
  }
  for (const run of value.memory ?? []) {
    if (run.checkpoints.length > 600 || !Number.isFinite(run.actualLoadMs) || run.actualLoadMs < 0) throw new Error("Invalid memory run");
    if (run.attempted !== run.completed + run.failed + run.cancelled || run.latencyMs.count !== run.attempted) throw new Error("Invalid memory accounting");
    for (const point of run.checkpoints) for (const key of ["rss", "heapUsed", "heapTotal", "external", "arrayBuffers"] as const) if (!Number.isFinite(point.sample[key]) || point.sample[key] < 0) throw new Error("Invalid checkpoint");
  }
  for (const run of value.capacity ?? []) {
    const result = run.result;
    if (result.attempted !== result.completed + result.failed + result.cancelled || result.attempted + result.missedArrivals !== result.scheduled) throw new Error("Invalid capacity accounting");
    if (result.scheduleLatencyMs.count !== result.attempted || result.latencyMs.count !== result.attempted || result.headersLatencyMs.count > result.attempted) throw new Error("Invalid capacity latency population");
    if (result.peakConcurrency > run.concurrency || result.missedScheduling + result.missedConcurrency !== result.missedArrivals) throw new Error("Invalid capacity scheduling");
    if (![result.requestsPerSecond, result.attemptedPerSecond, result.scheduleLatencyMs.p99].every(Number.isFinite)) throw new Error("Nonfinite capacity result");
  }
}

export function markdown(report: BenchmarkReport): string {
  const lines = ["# LoadPilot benchmark report", "", `Run: ${report.timestamp}; status: **${report.passed ? "PASS" : "FAIL"}**; execution: ${report.executionStatus ?? "completed"}`, "",
    "## Environment", "", `- ${report.environment.platform} ${report.environment.osRelease}; ${report.environment.cpu}; ${report.environment.logicalCpus} logical CPUs`,
    `- RAM ${(report.environment.totalRamBytes / 1024 ** 3).toFixed(1)} GiB; Node ${report.environment.node}`,
    `- Source commit ${report.environment.gitCommit}; working tree dirty: ${report.environment.workingTreeDirty}; explicit GC: ${report.environment.gcExposed}`,
    `- Configuration: \`${JSON.stringify(report.configuration)}\``, "", "## Measured matrix (all repetitions)", "",
    "| Scenario | Mode | Concurrency | Run | Req/s | p50 ms | p95 ms | p99 ms | Failed / attempted |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|"];
  for (const row of report.rows) lines.push(`| ${row.scenario} | ${row.mode} | ${row.concurrency} | ${row.repetition} | ${row.result.requestsPerSecond.toFixed(1)} | ${row.result.latencyMs.p50.toFixed(3)} | ${row.result.latencyMs.p95.toFixed(3)} | ${row.result.latencyMs.p99.toFixed(3)} | ${row.result.failed}/${row.result.attempted} |`);
  lines.push("", "## Relative performance (medians of equivalent repetitions)", "",
    "| Scenario | C | Direct req/s | Proxy req/s | Metrics req/s | Proxy/direct | Metrics/proxy | Added average ms: proxy / metrics |",
    "|---|---:|---:|---:|---:|---:|---:|---:|");
  const keys = new Set(report.rows.map((row) => `${row.scenario}:${row.concurrency}`));
  for (const key of keys) {
    const rows = report.rows.filter((row) => `${row.scenario}:${row.concurrency}` === key);
    const modes = ["direct", "proxy", "metrics"].map((mode) => rows.filter((row) => row.mode === mode));
    if (modes.some((entries) => !entries.length)) continue;
    const rates = modes.map((entries) => median(entries.map((row) => row.result.requestsPerSecond)));
    const times = modes.map((entries) => median(entries.map((row) => row.result.latencyMs.average)));
    lines.push(`| ${rows[0].scenario} | ${rows[0].concurrency} | ${rates[0].toFixed(1)} | ${rates[1].toFixed(1)} | ${rates[2].toFixed(1)} | ${(rates[1] / rates[0]).toFixed(3)} | ${(rates[2] / rates[1]).toFixed(3)} | ${(times[1] - times[0]).toFixed(3)} / ${(times[2] - times[1]).toFixed(3)} |`);
  }
  lines.push("", "## Resource observations", "",
    "| Scenario / mode / C / run | Client CPU % | Backend CPU % (sum) | Proxy CPU % | Proxy peak RSS MiB | Proxy peak heap MiB | Proxy ELU | Proxy delay p99 ms |",
    "|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of report.rows) {
    const proxy = row.resources.proxy;
    lines.push(`| ${row.scenario}/${row.mode}/${row.concurrency}/${row.repetition} | ${row.resources.client.cpuPercentOfOneCore.toFixed(1)} | ${row.resources.backends.reduce((sum, item) => sum + item.cpuPercentOfOneCore, 0).toFixed(1)} | ${proxy?.cpuPercentOfOneCore.toFixed(1) ?? "n/a"} | ${proxy ? (proxy.peakRss / 1024 ** 2).toFixed(1) : "n/a"} | ${proxy ? (proxy.peakHeapUsed / 1024 ** 2).toFixed(1) : "n/a"} | ${proxy?.eventLoopUtilization.toFixed(3) ?? "n/a"} | ${proxy?.eventLoopDelayMs.p99?.toFixed(2) ?? "n/a"} |`);
  }
  lines.push("", "## Fault injection", "");
  for (const result of report.faults) lines.push(`- **${result.passed ? "PASS" : "FAIL"} ${result.name}** (${result.durationMs.toFixed(0)} ms): ${result.details}`);
  lines.push("", "## Sustained-operation observations", "");
  for (const run of report.soak) {
    const first = run.initial.samples.at(-1), last = run.final.samples.at(-1);
    lines.push(`- ${run.mode}: ${(run.actualDurationMs / 1000).toFixed(2)} seconds, ${run.cycles} batches, workloads ${run.workloads.join(", ")}.`,
      `  Initial/final RSS MiB: ${first ? (first.rss / 1024 ** 2).toFixed(1) : "n/a"}/${last ? (last.rss / 1024 ** 2).toFixed(1) : "n/a"}; heap MiB ${first ? (first.heapUsed / 1024 ** 2).toFixed(1) : "n/a"}/${last ? (last.heapUsed / 1024 ** 2).toFixed(1) : "n/a"}; peak RSS MiB ${(run.final.peakRss / 1024 ** 2).toFixed(1)}.`,
      `  Sampled heap slope bytes/s: ${run.final.heapSlopeBytesPerSecond?.toFixed(0) ?? "unavailable"}; settled checkpoints ${run.settledSamples.length}; post-stop resources: \`${JSON.stringify(run.postStop)}\`.`);
  }
  if (report.memory?.length) {
    lines.push("", "## Memory isolation", "", "| Scenario | Actual load s | Attempts / complete / failed / cancelled | Peak RSS / heap / external / buffers MiB | Classification |", "|---|---:|---|---|---|");
    for (const run of report.memory) {
      const resource = run.resources;
      lines.push(`| ${run.scenario} | ${(run.actualLoadMs / 1000).toFixed(2)} | ${run.attempted}/${run.completed}/${run.failed}/${run.cancelled} | ${[resource.peakRss, resource.peakHeapUsed, resource.peakExternal, resource.peakArrayBuffers].map((value) => (value / 1048576).toFixed(2)).join(" / ")} | ${run.trend.classification} |`);
    }
    for (const run of report.memory) {
      lines.push("", `### ${run.scenario} checkpoints`, "", `Trend: ${JSON.stringify(run.trend)}`, "", "| Checkpoint | Seconds | RSS MiB | Heap used / total MiB | External MiB | ArrayBuffers MiB | RSS - heap total MiB | Busy / idle / queued |", "|---|---:|---:|---|---:|---:|---:|---|");
      for (const point of run.checkpoints.filter((point) => !point.label.startsWith("settled"))) {
        const sample = point.sample, mib = (value: number) => (value / 1048576).toFixed(2);
        lines.push(`| ${point.label} | ${(point.elapsedMs / 1000).toFixed(2)} | ${mib(sample.rss)} | ${mib(sample.heapUsed)} / ${mib(sample.heapTotal)} | ${mib(sample.external)} | ${mib(sample.arrayBuffers)} | ${mib(point.rssMinusHeapTotal)} | ${sample.upstreamBusySockets}/${sample.upstreamIdleSockets}/${sample.agentPendingRequests} |`);
      }
    }
  }
  if (report.capacity?.length) {
    lines.push("", "## Controlled-arrival capacity", "", "Percentiles include all attempted outcomes; schedule latency includes dispatch delay. Missed slots have no invented latency. SLO uses schedule-relative p95/p99.", "",
      "| Profile / mode / run | Offered/s | Attempts/s | Completed/s | Failed/s | Missed schedule / cap | Peak C | Service p50/p95/p99 ms | Schedule p50/p95/p99 ms | Dispatch p99 ms | 5xx / upstream timeouts | Decision |", "|---|---:|---:|---:|---:|---|---:|---|---|---:|---|---|");
    for (const run of report.capacity) {
      const result = run.result;
      lines.push(`| ${run.profile}/${run.mode}/${run.repetition} | ${run.offeredRate} | ${result.attemptedPerSecond.toFixed(1)} | ${result.requestsPerSecond.toFixed(1)} | ${(result.failed / (result.elapsedMs / 1000)).toFixed(1)} | ${result.missedScheduling}/${result.missedConcurrency} | ${result.peakConcurrency} | ${[result.latencyMs.p50, result.latencyMs.p95, result.latencyMs.p99].map((value) => value.toFixed(3)).join("/")} | ${[result.scheduleLatencyMs.p50, result.scheduleLatencyMs.p95, result.scheduleLatencyMs.p99].map((value) => value.toFixed(3)).join("/")} | ${result.schedulingDelayMs.p99.toFixed(3)} | ${run.http5xx}/${run.upstreamTimeouts ?? "n/a"} | ${run.decision.classification}: ${run.decision.reasons.join("; ")} |`);
    }
    lines.push("", "### Passing tested rates and dispersion", "", "| Profile / mode | Highest tested passing rate | Run rate: min / median / max completed/s |", "|---|---:|---|");
    for (const key of new Set(report.capacity.map((run) => `${run.profile}/${run.mode}`))) {
      const runs = report.capacity.filter((run) => `${run.profile}/${run.mode}` === key);
      lines.push(`| ${key} | ${highestPassing(runs, Number(report.configuration.repetitions ?? 1)) ?? "none"} | See per-rate rows below |`);
      for (const rate of new Set(runs.map((run) => run.offeredRate))) {
        const rates = runs.filter((run) => run.offeredRate === rate).map((run) => run.result.requestsPerSecond);
        lines.push(`| ${key} offered ${rate} | — | ${Math.min(...rates).toFixed(1)} / ${median(rates).toFixed(1)} / ${Math.max(...rates).toFixed(1)} |`);
      }
    }
    lines.push("", "| Profile / mode / offered / run | Client CPU / ELU | Proxy CPU / ELU | Backend CPU / ELU | Proxy RSS / heap peak MiB |", "|---|---|---|---|---|");
    for (const run of report.capacity) {
      const format = (resource: typeof run.resources.proxy) => resource ? `${resource.cpuPercentOfOneCore.toFixed(1)}% / ${resource.eventLoopUtilization.toFixed(3)}` : "n/a";
      lines.push(`| ${run.profile}/${run.mode}/${run.offeredRate}/${run.repetition} | ${format(run.resources.client)} | ${format(run.resources.proxy)} | ${format(run.resources.backends[0])} | ${run.resources.proxy ? `${(run.resources.proxy.peakRss / 1048576).toFixed(1)} / ${(run.resources.proxy.peakHeapUsed / 1048576).toFixed(1)}` : "n/a"} |`);
    }
  }
  lines.push("", "## Reliability findings and limitations", "", ...report.limitations.map((limitation) => `- ${limitation}`), "",
    "## Assessment", "", report.passed ? "The executed configurations met their correctness checks. These bounded local runs do not establish universal throughput, statistical significance, production readiness, or absence of long-term leaks." : "At least one correctness check failed. Inspect JSON and fault details; this run is not an accepted baseline.", "");
  return lines.join("\n");
}

export async function writeReport(report: BenchmarkReport, label: string): Promise<void> {
  validateReport(report);
  const directory = resolve("benchmarks/results"); await mkdir(directory, { recursive: true });
  const json = JSON.stringify(report, null, 2), summary = markdown(report);
  for (const name of [label, "latest"]) {
    await writeFile(resolve(directory, `${name}.json`), json);
    await writeFile(resolve(directory, `${name}.md`), summary);
  }
}
