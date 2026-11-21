import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import type { WorkerConfig, WorkerInfo } from "../types.js";

interface Reply { kind: "reply"; id: number; ok: boolean; value?: unknown; error?: string }
function reply(value: unknown): value is Reply {
  return !!value && typeof value === "object" && "kind" in value && value.kind === "reply" &&
    "id" in value && typeof value.id === "number" && "ok" in value && typeof value.ok === "boolean";
}

export class Worker {
  readonly child: ChildProcess;
  info!: WorkerInfo;
  private serial = 0;
  private stderr = "";
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly killOnExit: () => void;

  private constructor(config: WorkerConfig, gc: boolean) {
    // Synthetic workers do not need repository credentials or application env.
    const environment: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[key] !== undefined) environment[key] = process.env[key];
    this.child = fork(fileURLToPath(new URL("../worker.ts", import.meta.url)), [JSON.stringify(config)], {
      execArgv: ["--import", "tsx", "--unhandled-rejections=strict", ...(gc ? ["--expose-gc"] : [])],
      stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true, env: environment,
    });
    this.killOnExit = () => this.child.kill();
    process.once("exit", this.killOnExit);
    this.child.stderr?.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-8192); });
    this.child.on("message", (message: unknown) => {
      if (!reply(message)) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.value); else pending.reject(new Error(message.error ?? "Worker command failed"));
    });
    const failed = (error: Error) => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
    };
    this.child.on("error", failed);
    this.child.once("exit", (code, signal) => {
      process.off("exit", this.killOnExit);
      failed(new Error(`Fixture exited (${code ?? signal}): ${this.stderr}`));
    });
  }

  static async start(config: WorkerConfig, gc = false): Promise<Worker> {
    const worker = new Worker(config, gc);
    try { worker.info = await worker.call<WorkerInfo>("ready"); return worker; }
    catch (error) { await worker.close(); throw error; }
  }

  call<T>(command: string, payload?: unknown, timeoutMs = 15_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.child.connected) { reject(new Error("Worker is disconnected")); return; }
      const id = this.serial++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Worker ${command} deadline`)); }, timeoutMs);
      // The IPC boundary is private and JSON-only; each command validates its
      // configuration in the worker. Callers provide the command's result type.
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.child.send({ id, command, payload }, (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }

  async terminate(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const exited = () => { clearTimeout(hardKill); clearTimeout(deadline); resolve(); };
      const hardKill = setTimeout(() => this.child.kill("SIGKILL"), 1000);
      const deadline = setTimeout(() => { this.child.off("exit", exited); reject(new Error("Fixture termination deadline")); }, 3000);
      this.child.once("exit", exited); this.child.kill();
    });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try { await this.call("shutdown", undefined, 3000); }
    catch (error) {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        await this.terminate();
        throw error;
      }
      return;
    }
    if (this.child.connected) this.child.disconnect();
    for (let index = 0; index < 100 && this.child.exitCode === null && this.child.signalCode === null; index++) await sleep(10);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await this.terminate(); throw new Error("Fixture did not exit after cleanup");
    }
  }
}

export async function closeWorkers(workers: Worker[]): Promise<void> {
  const results = await Promise.allSettled(workers.map((worker) => worker.close()));
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

export async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!await predicate()) {
    if (performance.now() >= deadline) throw new Error("Fixture state deadline");
    await sleep(10);
  }
}
