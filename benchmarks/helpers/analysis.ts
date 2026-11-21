import type { CapacityDecision, DiagnosticCheckpoint, LoadResult, MemoryTrend, Slo } from "../types.js";

export function slope(points: { x: number; y: number }[]): number | null {
  if (points.length < 2 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  const xm = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const ym = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.x - xm) ** 2, 0);
  return denominator ? points.reduce((sum, point) => sum + (point.x - xm) * (point.y - ym), 0) / denominator : null;
}

export function memoryTrend(points: DiagnosticCheckpoint[], completed: number, fullPoints: Pick<DiagnosticCheckpoint, "elapsedMs" | "sample">[] = points): MemoryTrend {
  const line = (key: "rss" | "heapUsed" | "external", late: boolean) => slope((late ? points.slice(Math.floor(points.length / 2)) : points)
    .map((point) => ({ x: point.elapsedMs / 1000, y: point.sample[key] })));
  const first = points[0], last = points.at(-1);
  const rssDelta = first && last ? last.sample.rss - first.sample.rss : 0;
  const window = (key: "rss" | "heapUsed" | "external", series: Pick<DiagnosticCheckpoint, "elapsedMs" | "sample">[]) => slope(series.map((point) => ({ x: point.elapsedMs / 1000, y: point.sample[key] })));
  const early = points.slice(0, Math.ceil(points.length / 2));
  const result: MemoryTrend = { fullRssBytesPerSecond: window("rss", fullPoints), fullHeapBytesPerSecond: window("heapUsed", fullPoints), fullExternalBytesPerSecond: window("external", fullPoints),
    earlyRssBytesPerSecond: window("rss", early), earlyHeapBytesPerSecond: window("heapUsed", early), earlyExternalBytesPerSecond: window("external", early),
    rssBytesPerSecond: line("rss", false), lateRssBytesPerSecond: line("rss", true),
    heapBytesPerSecond: line("heapUsed", false), lateHeapBytesPerSecond: line("heapUsed", true),
    externalBytesPerSecond: line("external", false), lateExternalBytesPerSecond: line("external", true),
    rssBytesPerCompletedRequest: completed > 0 ? rssDelta / completed : null,
    classification: "Inconclusive", reason: "Fewer than six checkpoints or less than 30 seconds; trend is descriptive only." };
  if (!first || !last || points.length < 6 || last.elapsedMs - first.elapsedMs < 30_000) return result;
  const liveGrowth = last.sample.heapUsed - first.sample.heapUsed;
  const externalGrowth = last.sample.external - first.sample.external;
  if ((result.lateHeapBytesPerSecond ?? 0) > 65536 || (result.lateExternalBytesPerSecond ?? 0) > 131072 || (result.lateRssBytesPerSecond ?? 0) > 131072) {
    result.classification = "Suspicious retained growth"; result.reason = "Late slope exceeds heuristic: heap 64 KiB/s, external or RSS 128 KiB/s. Attribution requires investigation.";
  } else if (rssDelta > 8 * 1048576 && (result.lateRssBytesPerSecond ?? Infinity) < 16384 && liveGrowth < 2 * 1048576 && externalGrowth < 2 * 1048576) {
    result.classification = "Likely warmup or allocator retention"; result.reason = "RSS rose >8 MiB but late RSS slope <16 KiB/s with heap/external growth <2 MiB; this does not identify an allocator.";
  } else if (Math.abs(rssDelta) < 8 * 1048576 && liveGrowth < 2 * 1048576 && externalGrowth < 2 * 1048576) {
    result.classification = "No concerning growth observed"; result.reason = "Net RSS <8 MiB and heap/external growth <2 MiB in this bounded window; not a leak-freedom proof.";
  } else result.reason = "Measurements do not distinguish continuing retention from warmup/runtime allocator effects.";
  return result;
}

export function validateSlo(slo: Slo): void {
  for (const key of ["p95Ms", "p99Ms"] as const) if (!Number.isFinite(slo[key]) || slo[key] <= 0 || slo[key] > 120000) throw new Error(`Invalid SLO ${key}`);
  if (slo.p99Ms < slo.p95Ms) throw new Error("p99 SLO must be >= p95 SLO");
  for (const key of ["maxErrorRate", "arrivalTolerance", "completionTolerance"] as const) if (!Number.isFinite(slo[key]) || slo[key] < 0 || slo[key] > 1) throw new Error(`Invalid SLO ${key}`);
}

export function capacityDecision(result: LoadResult, slo: Slo): CapacityDecision {
  validateSlo(slo);
  if (!result.attempted || !result.scheduled || result.issuingMs <= 0 || !Number.isFinite(result.requestsPerSecond) || result.scheduleLatencyMs.count !== result.attempted || result.attempted + result.missedArrivals !== result.scheduled) {
    return { passed: false, classification: "inconclusive", reasons: ["Empty, partial or inconsistent arrival/latency population"] };
  }
  const reasons: string[] = [];
  const missedFraction = result.missedArrivals / result.scheduled;
  const clientLimited = missedFraction > slo.arrivalTolerance;
  if (clientLimited) reasons.push(`Arrival misses ${(missedFraction * 100).toFixed(2)}% exceed tolerance; scheduling=${result.missedScheduling}, concurrency-cap=${result.missedConcurrency}`);
  if ((result.failed + result.cancelled) / result.attempted > slo.maxErrorRate) reasons.push("Error budget exceeded");
  if (result.scheduleLatencyMs.p95 > slo.p95Ms || result.scheduleLatencyMs.p99 > slo.p99Ms) reasons.push("Schedule-relative latency SLO exceeded");
  if (result.completed / result.scheduled < 1 - slo.completionTolerance) reasons.push("Validated completions do not meet offered-arrival tolerance");
  const scheduledRate = result.scheduled / (result.issuingMs / 1000);
  if (result.requestsPerSecond < scheduledRate * (1 - slo.completionTolerance)) reasons.push("Completed rate including drain is below offered-rate tolerance");
  return { passed: reasons.length === 0, classification: clientLimited ? "client-limited" : reasons.length ? "SLO-failed" : "passing", reasons };
}

/** A rate passes conservatively only if every executed repetition passed. */
export function highestPassing(runs: { offeredRate: number; decision: CapacityDecision }[], expectedRepetitions = 1): number | null {
  const rates = [...new Set(runs.map((run) => run.offeredRate))];
  const passed = rates.filter((rate) => { const rows = runs.filter((run) => run.offeredRate === rate); return rows.length >= expectedRepetitions && rows.every((run) => run.decision.passed); });
  return passed.length ? Math.max(...passed) : null;
}
