import { cpus, platform, release, totalmem } from "node:os";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { median } from "./statistics.js";
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
}

export function markdown(report: BenchmarkReport): string {
  const lines = ["# LoadPilot benchmark report", "", `Run: ${report.timestamp}; status: **${report.passed ? "PASS" : "FAIL"}**`, "",
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
