import type { CapacityDecision, DiagnosticCheckpoint, LoadResult, MemoryTrend, Slo } from "../types.js";

export function slope(points: { x: number; y: number }[]): number | null {
  if (points.length < 2 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  const xm = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const ym = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.x - xm) ** 2, 0);
  return denominator ? points.reduce((sum, point) => sum + (point.x - xm) * (point.y - ym), 0) / denominator : null;
}

type Observation = Pick<DiagnosticCheckpoint, "elapsedMs" | "sample">;
type MemoryKey = "rss" | "heapUsed" | "external";

/** Equal elapsed-time windows, not equal numbers of retained observations. */
function balanced(points: readonly Observation[], start: number, end: number, buckets = 12): Observation[] {
  if (!(end > start)) return [];
  const bins = new Map<number, Observation[]>();
  for (const point of points) {
    if (point.elapsedMs < start || point.elapsedMs > end) continue;
    const index = Math.min(buckets - 1, Math.floor((point.elapsedMs - start) / (end - start) * buckets));
    const group = bins.get(index) ?? [];
    group.push(point); bins.set(index, group);
  }
  // One mean measurement per occupied time bucket prevents a dense tail
  // from dominating regression. Missing buckets are not interpolated.
  return [...bins.entries()].sort((a,b) => a[0]-b[0]).map(([, group]) => {
    const mean = (key: MemoryKey) => group.reduce((sum, p) => sum + p.sample[key], 0) / group.length;
    return { elapsedMs: group.reduce((sum, p) => sum + p.elapsedMs, 0) / group.length,
      sample: { ...group[0]!.sample, rss: mean("rss"), heapUsed: mean("heapUsed"), external: mean("external") } };
  });
}

export function memoryTrend(points: DiagnosticCheckpoint[], completed: number, fullPoints: Observation[] = points): MemoryTrend {
  const first = points[0], last = points.at(-1);
  const start = first?.elapsedMs ?? 0, end = last?.elapsedMs ?? start;
  const middle = (start + end) / 2;
  const rssDelta = first && last ? last.sample.rss - first.sample.rss : 0;
  const valid = (series: readonly Observation[]) => series.every((p,i) => Number.isFinite(p.elapsedMs) && (i === 0 || p.elapsedMs >= series[i-1]!.elapsedMs) && (["rss","heapUsed","external"] as const).every(k => Number.isFinite(p.sample[k])));
  const window = (key: MemoryKey, series: Observation[]) => slope(series.map(p => ({ x: p.elapsedMs / 1000, y: p.sample[key] })));
  const coverage = (series: Observation[], duration: number) => series.length >= 3 && series.at(-1)!.elapsedMs - series[0]!.elapsedMs >= duration / 2;
  const all = valid(points) ? balanced(points, start, end) : [];
  const early = valid(points) ? balanced(points, start, middle, 6) : [];
  const late = valid(points) ? balanced(points, middle, end, 6) : [];
  const raw = valid(fullPoints) ? balanced(fullPoints, fullPoints[0]?.elapsedMs ?? 0, fullPoints.at(-1)?.elapsedMs ?? 0) : [];
  const earlyOK = coverage(early, (end-start)/2), lateOK = coverage(late, (end-start)/2);
  const fullOK = coverage(raw, (fullPoints.at(-1)?.elapsedMs ?? 0) - (fullPoints[0]?.elapsedMs ?? 0));
  const result: MemoryTrend = {
    fullRssBytesPerSecond: fullOK ? window("rss", raw) : null, fullHeapBytesPerSecond: fullOK ? window("heapUsed", raw) : null, fullExternalBytesPerSecond: fullOK ? window("external", raw) : null,
    earlyRssBytesPerSecond: earlyOK ? window("rss", early) : null, earlyHeapBytesPerSecond: earlyOK ? window("heapUsed", early) : null, earlyExternalBytesPerSecond: earlyOK ? window("external", early) : null,
    rssBytesPerSecond: earlyOK && lateOK ? window("rss", all) : null, lateRssBytesPerSecond: lateOK ? window("rss", late) : null,
    heapBytesPerSecond: earlyOK && lateOK ? window("heapUsed", all) : null, lateHeapBytesPerSecond: lateOK ? window("heapUsed", late) : null,
    externalBytesPerSecond: earlyOK && lateOK ? window("external", all) : null, lateExternalBytesPerSecond: lateOK ? window("external", late) : null,
    rssBytesPerCompletedRequest: completed > 0 ? rssDelta / completed : null,
    classification: "Inconclusive", reason: "Need at least 30 seconds, six observations and three occupied time buckets spanning at least half of each elapsed-time half; missing coverage is not evidence of stability." };
  if (!first || !last || points.length < 6 || end-start < 30000 || !earlyOK || !lateOK) return result;
  const liveGrowth = last.sample.heapUsed - first.sample.heapUsed;
  const externalGrowth = last.sample.external - first.sample.external;
  if ((result.lateHeapBytesPerSecond ?? 0) > 65536 || (result.lateExternalBytesPerSecond ?? 0) > 131072 || (result.lateRssBytesPerSecond ?? 0) > 131072) {
    result.classification = "Suspicious retained growth"; result.reason = "Late elapsed-time slope exceeds unchanged heuristic: heap 64 KiB/s, external or RSS 128 KiB/s. Attribution requires investigation.";
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
