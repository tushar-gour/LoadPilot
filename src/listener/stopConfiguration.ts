import type { StopOptions } from "../LoadPilot.js";

export function stopConfiguration(options?: StopOptions): {
  mode: "immediate" | "graceful";
  timeoutMs: number;
} {
  if (options === undefined) return { mode: "immediate", timeoutMs: 0 };
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !["mode", "timeoutMs"].includes(key))
  )
    throw new Error("stop options must specify immediate or graceful mode.");
  if (options.mode !== "immediate" && options.mode !== "graceful")
    throw new Error("stop mode must be immediate or graceful.");
  if (options.mode === "immediate") {
    if (options.timeoutMs !== undefined)
      throw new Error("timeoutMs applies only to graceful stop.");
    return { mode: "immediate", timeoutMs: 0 };
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw new Error(
      "Graceful timeoutMs must be an integer between 1 and 300000.",
    );
  return { mode: "graceful", timeoutMs };
}
