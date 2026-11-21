import assert from "node:assert/strict";
import type { AggregateMetrics, LoadPilotMetrics } from "../../src/index.js";
import { Worker, closeWorkers, waitFor } from "./processes.js";
import type { BackendStats, LoadOptions, LoadResult, ResourceState, WorkerInfo } from "../types.js";

export interface EnvironmentOptions {
  count?: number; metrics?: boolean; health?: boolean; timeoutMs?: number;
  routes?: { route: string; indices: number[] }[]; sampleMs?: number; gc?: boolean;
  direct?: boolean; upstreamKeepAlive?: boolean;
}

export class Environment {
  readonly workers: Worker[] = [];
  readonly backends: Worker[] = [];
  proxy!: Worker;
  client!: Worker;
  private constructor(readonly options: EnvironmentOptions) {}
  static async start(options: EnvironmentOptions = {}): Promise<Environment> {
    const environment = new Environment(options);
    try {
      for (let index = 0; index < (options.count ?? 1); index++) {
        const backend = await Worker.start({ role: "backend", id: `backend-${index}`, sampleMs: options.sampleMs }, options.gc);
        environment.backends.push(backend); environment.workers.push(backend);
      }
      const routes = options.routes ?? [{ route: "/", indices: environment.backends.map((_, index) => index) }];
      if (!options.direct) {
        environment.proxy = await Worker.start({ role: "proxy", metrics: options.metrics ?? true, health: options.health,
          upstreamTimeoutMs: options.timeoutMs, sampleMs: options.sampleMs, upstreamKeepAlive: options.upstreamKeepAlive,
          pools: routes.map((route) => ({ route: route.route, urls: route.indices.map((index) => environment.backends[index].info.url ?? "") })) }, options.gc);
        environment.workers.push(environment.proxy);
      }
      environment.client = await Worker.start({ role: "client", sampleMs: options.sampleMs });
      environment.workers.push(environment.client);
      return environment;
    } catch (error) { await environment.close(); throw error; }
  }
  load(path: string, options: Partial<LoadOptions> = {}): Promise<LoadResult> {
    const configuration: LoadOptions = { targets: [(this.options.direct ? this.backends[0].info.url : this.proxy.info.url) + path], concurrency: 6, durationMs: 3000, requests: 12, ...options };
    return this.client.call("load", configuration, configuration.durationMs + (configuration.timeoutMs ?? 5000) + 5000);
  }
  metrics(): Promise<LoadPilotMetrics> { return this.proxy.call("metrics"); }
  stats(index = 0): Promise<BackendStats> { return this.backends[index].call("stats"); }
  async quiet(): Promise<void> {
    await waitFor(async () => {
      const state = this.options.direct ? undefined : await this.proxy.call<ResourceState>("state");
      const stats = await Promise.all(this.backends.filter((worker) => worker.child.exitCode === null && worker.child.signalCode === null).map((worker) => worker.call<BackendStats>("stats")));
      const metricsActive = this.options.direct || this.options.metrics === false ? 0 : (await this.metrics()).requests.active;
      return metricsActive === 0 && (!state || (state.activeRequests === 0 && state.activeUpstreamExchanges === 0)) && stats.every((item) => item.active === 0);
    });
  }
  async healthy(): Promise<void> {
    await waitFor(async () => (await this.metrics()).pools.every((pool) => pool.eligibility.healthy === pool.eligibility.registered));
  }
  async restartProxy(): Promise<void> {
    await this.proxy.call("stop"); this.proxy.info = await this.proxy.call<WorkerInfo>("start");
  }
  async replaceBackend(index: number): Promise<void> {
    const previous = this.backends[index];
    await previous.terminate();
    const worker = await Worker.start({ role: "backend", id: `backend-${index}`, port: previous.info.port, sampleMs: this.options.sampleMs }, this.options.gc);
    this.backends[index] = worker;
    this.workers.splice(this.workers.indexOf(previous), 1, worker);
  }
  async close(): Promise<void> { await closeWorkers(this.workers); }
}

export function accounting(metrics: LoadPilotMetrics, expected?: number): void {
  const check = (scope: AggregateMetrics) => {
    const request = scope.requests;
    assert.equal(request.active, 0);
    assert.equal(request.total, request.completed + request.failed + request.cancelled);
    assert.equal(request.cancelled, request.clientCancelled + request.shutdownCancelled);
    assert.equal(scope.responses.completed + scope.responses.incomplete, request.total);
    assert.equal(scope.latency.count, request.total);
  };
  check(metrics);
  for (const pool of metrics.pools) { check(pool); pool.backends.forEach(check); }
  if (expected !== undefined) assert.equal(metrics.requests.total, expected);
  assert.equal(metrics.instrumentationErrors, 0);
}
