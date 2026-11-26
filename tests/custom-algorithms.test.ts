import { test } from "node:test";
import assert from "node:assert/strict";
import { Algorithm, HealthState, Server, ServerPool, type CustomAlgorithm, type CustomAlgorithmCandidate, type CustomAlgorithmFactory } from "../src/index.js";
import { backend, exchange, limits, open, signal, start, until } from "./helpers/network.js";

const server = (port: number, weight = 1) => new Server(`http://127.0.0.1:${port}`, { weight });
const create = (customAlgorithm: CustomAlgorithmFactory, servers: Server[] = []) =>
  new ServerPool({ route: "/", servers, customAlgorithm });

test("Custom factories receive independent per-pool state; built-in API remains unchanged", () => {
  const a = server(3001), b = server(3002), c = server(3003);
  class SelectLast implements CustomAlgorithm {
    private calls = 0;
    select(candidates: readonly CustomAlgorithmCandidate[]) {
      this.calls++;
      return candidates[this.calls === 1 ? candidates.length - 1 : 0]?.id;
    }
  }
  let created = 0;
  const factory = () => { created++; return new SelectLast(); };
  const p = create(factory, [a,b,c]), q = create(factory, [a,b,c]);
  assert.equal(created, 2);
  assert.equal(p.usesCustomAlgorithm, true);
  assert.equal(p.algorithm, Algorithm.ROUND_ROBIN);
  assert.equal(p.getNextServer(), c);
  assert.equal(p.getNextServer(), a);
  assert.equal(q.getNextServer(), c);
  const normal = new ServerPool({route:"/", servers:[a,b], algorithm:Algorithm.RANDOM});
  assert.equal(normal.usesCustomAlgorithm, false);
  assert.equal(normal.algorithm, Algorithm.RANDOM);
  assert.equal(Object.values(Algorithm).length, 6);
});

test("Custom configuration rejects ambiguity, invalid factories and reused strategy instances", () => {
  const shared = { select: () => undefined };
  assert.throws(() => new ServerPool({route:"/", algorithm:Algorithm.ROUND_ROBIN, customAlgorithm:()=>shared}), /either/);
  assert.throws(() => create(null as unknown as CustomAlgorithmFactory), /factory/);
  assert.throws(() => create(()=>null as unknown as CustomAlgorithm), /select/);
  assert.throws(() => create(()=>({select:1} as unknown as CustomAlgorithm)), /select/);
  create(()=>shared);
  assert.throws(() => create(()=>shared), /fresh/);
});

test("Snapshots are deeply frozen, deduplicated by registration, ordered, and have no mutable internal state", () => {
  const a = server(3001, 5), b = server(3001, 2);
  let seen: readonly CustomAlgorithmCandidate[] = [];
  const p = create(()=>({select(candidates) { seen = candidates; return candidates[0]?.id; }}), [a,a,b]);
  assert.equal(p.getNextServer(), a);
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.registrations, 2);
  assert.equal(seen[0]!.weight, 5);
  assert.equal(seen[0]!.baseUrl, a.baseUrl);
  assert.equal(seen[0]!.activeRequests, 0);
  assert.notEqual(seen[0]!.id, seen[1]!.id);
  assert.ok(Object.isFrozen(seen) && seen.every(Object.isFrozen));
  assert.throws(()=>Object.assign(seen[0]!, {activeRequests:999}), TypeError);
  assert.throws(()=>Object.assign(seen, {0:undefined}), TypeError);
  const old = seen[0]!;
  assert.equal(p.getNextServer(), a); // duplicate slots still rotate through registration order
  assert.equal(p.getNextServer(), b);
  assert.equal(old.activeRequests, 0);
});

test("Custom active and latency snapshots are independent of telemetry and registration lifetimes", () => {
  const a = server(3001);
  let seen!: CustomAlgorithmCandidate;
  const p = create(()=>({select(c) { seen = c[0]!; return seen.id; }}), [a]);
  p.getNextServer(); const oldId = seen.id;
  const one = p.beginRequest(a)!;
  p.getNextServer(); assert.equal(seen.activeRequests, 1); assert.equal(seen.latencyMs, undefined);
  one(100); one(999);
  p.getNextServer(); assert.equal(seen.activeRequests, 0); assert.equal(seen.latencyMs, 100);
  p.beginRequest(a)!(200);
  p.beginRequest(a)!(); p.beginRequest(a)!(NaN);
  p.getNextServer(); assert.equal(seen.latencyMs, 120);
  const retired = p.beginRequest(a)!;
  p.remove(a); p.add(a);
  const fresh = p.beginRequest(a)!;
  retired(10); retired(20);
  p.getNextServer(); assert.notEqual(seen.id, oldId); assert.equal(seen.activeRequests, 1);
  assert.equal(seen.latencyMs, undefined);
  fresh(); p.getNextServer(); assert.equal(seen.activeRequests, 0);
});

test("Empty pools skip custom callbacks; explicit decline returns null", () => {
  let calls = 0;
  const p = create(()=>({select(){calls++; return undefined;}}));
  assert.equal(p.getNextServer(), null); assert.equal(calls,0);
  p.add(server(3001)); assert.equal(p.getNextServer(), null); assert.equal(calls,1);
});

test("Invalid, stale, nonnumeric and asynchronous selections cannot resolve to a backend", async () => {
  const a = server(3001);
  let result: unknown;
  const p = create(()=>({select:()=>result as number}), [a]);
  for (const value of [-1, 0, NaN, Infinity, 1.5, "1", null, {}, Promise.resolve(1), Promise.reject(new Error("async"))]) {
    result = value;
    assert.throws(()=>p.getNextServer(), /eligible backend ID|synchronous/);
  }
  result = p.getBackendRegistration(a)!.id;
  assert.equal(p.getNextServer(), a);
  p.remove(a); p.add(a);
  assert.throws(()=>p.getNextServer(), /eligible backend ID/);
});

test("Reentrancy and membership edits during selection fail closed", () => {
  const a = server(3001), b = server(3002);
  let action = "reenter";
  let p!: ServerPool;
  p = create(()=>({select(c) {
    if (action === "reenter") p.getNextServer();
    if (action === "remove") p.remove(a);
    return c[0]?.id;
  }}), [a,b]);
  assert.throws(()=>p.getNextServer(), /reentrant/);
  action = "remove"; assert.throws(()=>p.getNextServer(), /membership changed/);
  action = "normal"; assert.equal(p.getNextServer(), b);
});

test("Custom selector never sees unhealthy backends and recovers after invalid selection", limits, async t => {
  let healthyA = false;
  const a = await backend(t,(req,res)=>{if(req.url==="/health")res.statusCode=healthyA?200:503;res.end("a");});
  const b = await backend(t,(_req,res)=>res.end("b"));
  let invalid = false;
  let decline = false;
  let shouldThrow = false;
  let seen: readonly CustomAlgorithmCandidate[] = [];
  const p = new ServerPool({route:"/",servers:[new Server(a.url),new Server(b.url)],
    healthCheck:{enabled:true,intervalMs:10,timeoutMs:1000,unhealthyThreshold:1,healthyThreshold:1},
    customAlgorithm:()=>({select(c){seen=c;if(shouldThrow)throw Error("private");return invalid?1:decline?undefined:c[0]?.id;}})});
  const pilot = await start(t,{pools:[p]});
  await until(()=>p.getHealthStatus().some(x=>x.state===HealthState.UNHEALTHY) && p.getHealthStatus().some(x=>x.state===HealthState.HEALTHY));
  assert.equal((await exchange(pilot)).body.toString(),"b"); assert.equal(seen.length,1);
  assert.equal(seen[0]!.baseUrl,b.url);
  invalid=true; assert.equal((await exchange(pilot)).status,500);
  invalid=false; shouldThrow=true; const failed=await exchange(pilot); assert.equal(failed.status,500); assert.ok(!failed.body.toString().includes("private"));
  shouldThrow=false; decline=true; assert.equal((await exchange(pilot)).status,503);
  decline=false; assert.equal((await exchange(pilot)).body.toString(),"b");
  healthyA=true; await until(()=>p.getHealthStatus().every(x=>x.state===HealthState.HEALTHY));
  await exchange(pilot); assert.equal(seen.length,2);
  assert.equal(pilot.getMetrics().requests.internalErrors,2);
  assert.equal(pilot.getMetrics().requests.active,0);
});

test("Custom snapshots track actual in-flight forwarding, completion and client cancellation with metrics disabled", limits, async t => {
  const entered=signal(), release=signal();
  const a=await backend(t,async(req,res)=>{if(req.url==="/hold"){entered.resolve();await release.promise;}if(!res.destroyed)res.end("a");});
  const b=await backend(t,(_req,res)=>res.end("b"));
  let seen: readonly CustomAlgorithmCandidate[]=[];
  const p=create(()=>({select(c){seen=c;return c.reduce((best,next)=>next.activeRequests<best.activeRequests?next:best).id;}}),[new Server(a.url),new Server(b.url)]);
  const pilot=await start(t,{pools:[p],metrics:{enabled:false}});
  const held=open(pilot,{path:"/hold"});const rejected=assert.rejects(held.promise);held.request.end();await entered.promise;
  assert.equal((await exchange(pilot)).body.toString(),"b");
  assert.equal(seen.find(x=>x.baseUrl===a.url)!.activeRequests,1);
  held.request.destroy();await rejected;await until(()=>pilot.getStatus().activeRequests===0);release.resolve();
  await exchange(pilot);
  assert.equal(seen.find(x=>x.baseUrl===a.url)!.activeRequests,0);
  assert.ok(Number.isFinite(seen.find(x=>x.baseUrl===b.url)!.latencyMs));
  await pilot.stop();
  assert.equal(pilot.getStatus().activeRequests,0);
});
