import { createHash } from "node:crypto";
import type { Distribution } from "../types.js";

// 201 fixed bins: 0.05 ms then 10% spacing, plus overflow. No request samples.
export const latencyBounds = Object.freeze(Array.from({ length: 200 }, (_, index) => 0.05 * 1.1 ** index));
export class Histogram {
  private readonly bins = new Array<number>(latencyBounds.length + 1).fill(0);
  private count = 0;
  private sum = 0;
  private min = Infinity;
  private max = 0;
  record(value: number): void {
    value = Math.max(0, value);
    let low = 0, high = latencyBounds.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (value <= latencyBounds[middle]) high = middle; else low = middle + 1;
    }
    this.bins[low]++; this.count++; this.sum += value;
    this.min = Math.min(this.min, value); this.max = Math.max(this.max, value);
  }
  snapshot(): Distribution {
    const percentile = (fraction: number) => {
      let sum = 0;
      for (let index = 0; index < this.bins.length; index++) {
        sum += this.bins[index];
        if (sum >= Math.ceil(this.count * fraction)) return this.count ? Math.min(latencyBounds[index] ?? this.max, this.max) : 0;
      }
      return 0;
    };
    return { count: this.count, average: this.count ? this.sum / this.count : 0,
      min: this.count ? this.min : 0, max: this.max,
      p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), buckets: [...this.bins] };
  }
  merge(value: Distribution): void {
    if (value.buckets.length !== this.bins.length || value.count !== value.buckets.reduce((sum, count) => sum + count, 0)) throw new Error("Incompatible histogram");
    for (let index = 0; index < this.bins.length; index++) this.bins[index] += value.buckets[index];
    this.count += value.count; this.sum += value.average * value.count;
    if (value.count) { this.min = Math.min(this.min, value.min); this.max = Math.max(this.max, value.max); }
  }
}

export const jsonPayload = Buffer.from(JSON.stringify({ operation: "synthetic", values: Array.from({ length: 12 }, (_, id) => ({ id, value: "loadpilot" })) }));
export const smallPayload = Buffer.from("loadpilot\n");
export const byteChunk = Buffer.alloc(64 * 1024, 97);
export function hashBytes(bytes: number): string {
  const hash = createHash("sha256");
  for (let offset = 0; offset < bytes; offset += byteChunk.length) hash.update(byteChunk.subarray(0, Math.min(byteChunk.length, bytes - offset)));
  return hash.digest("hex");
}
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
