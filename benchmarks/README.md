# Benchmark and reliability harness

Run these tools from a repository checkout with Node.js 22.19+ and `npm install`. They are development tools, excluded from the published `dist` package. They use native Node.js APIs and the existing development-only `tsx`; there are no new dependencies.

## Commands

```sh
npm run bench
npm run bench -- --concurrency 10,50 --duration 5 --warmup 1 --repetitions 3
npm run bench:full
npm run bench:full -- --concurrency 10 --duration 1 --repetitions 3 --label matrix
npm run bench -- --profiles post,64k --concurrency 10 --requests 200 --duration 5
npm run bench -- --concurrency 10 --duration 3 --rate 100 --label paced
npm run bench:stream
npm run bench:stream -- --payload-mib 64 --concurrency 2 --timeout-ms 30000
npm run fault
npm run fault -- --scenario backend-process-termination-recovery
npm run soak -- --duration 60 --concurrency 10 --sample-ms 200 --gc
npx tsx --test tests/reliability.test.ts
```

- `bench`: small GET, concurrency 1 and 10, one measured second per phase, 250 ms warmup, three repetitions of direct/proxy/metrics. With child startup this typically takes tens of seconds; it is not a capacity certification.
- `bench:full`: seven profiles (`get,json,post,64k,1m,pools,backends`), concurrency 1/10/50, two measured seconds per phase and three repetitions. This is an explicit opt-in matrix of 189 phases and can take several minutes. Override parameters to bound execution.
- `bench:stream`: exact 1/8/32 MiB upload/download checks, slow-reader/receiver backpressure, and total streaming deadlines. `--payload-mib 1..256` instead runs custom-size hashed uploads/downloads at the first requested concurrency, using `--timeout-ms` for both client and proxy deadlines.
- `fault`: 18 explicit, reproducible cases. `--scenario` selects one name from `scenarios/faults.ts`. Cases use their own deliberate deadlines, request counts and concurrency; they are correctness experiments, not throughput measurements.
- `soak`: both metrics-disabled and metrics-enabled modes, **60 seconds per mode by default**, plus readiness, warmup and settling. `--duration` changes seconds per mode; fractional seconds are allowed. `--gc` exposes GC only in fixture processes and invokes it at settled proxy checkpoints, never per request. Longer tests are opt-in, never part of `npm test`.

`npm test` adds deterministic reliability cases and a tiny CLI smoke check; it does not run the benchmark matrix or a long soak. No correctness test asserts a throughput threshold.

### Configuration limits

Durations are seconds; `--timeout-ms` and `--sample-ms` are milliseconds. Benchmark-only controls include `--profiles`, `--requests`, `--rate`, `--repetitions` and `--keep-alive true|false`. `--warmup 0` disables request warmup (soak still waits for health readiness and a 200 ms initial settling interval). `--label` must be 1–48 lowercase letters/digits/hyphens and names output under `results`; it cannot redirect output elsewhere.

Concurrency is bounded to 1–1000 and at most ten sweep values. Repetitions are 1–10, matrices at most 1000 phases, duration at most 24 hours per mode, requests at most ten million per phase, rate at most 100,000/s, individual client deadlines at most 120 seconds, payloads at most 256 MiB, and resource sampling 50–30,000 ms. Defaults are deliberately small. Choose high limits explicitly and account for local CPU/RAM/port limits. `--gc` is supported only for soak. Fault and standard streaming scenarios use fixed scenario configurations rather than global benchmark sweep options.

## Process isolation and network safety

The controller launches **separate Node.js processes** for the client, LoadPilot, and each backend. Readiness is acknowledged over IPC after listeners bind. Dynamic ports avoid fixed-port conflicts. Load generation does not share the proxy's event loop. No benchmark target option accepts an external host: the native generator permits only explicit `http://127.0.0.1:port` URLs, rejects credentials/fragments/HTTPS/other names, and uses synthetic data.

All fixture listeners bind `127.0.0.1`. The current public LoadPilot API has no bind-host option, so `worker.ts` uses a documented **harness-only native-listener adapter** to pin the existing listener to loopback. It also reads guarded native-agent/active-exchange diagnostics for resource checks. These adapters depend on current internals, fail clearly if their shape changes, and are not production API additions. No firewall, OS setting, global installation or production configuration is changed.

Workers run with strict unhandled-rejection behavior. Errors/exits reject pending RPCs; controller cleanup closes listeners/agents/samplers and disconnects IPC, with bounded termination fallback. Children also clean up on parent disconnect, and controller exit hooks terminate remaining direct children. Fault cases deliberately kill only their own backend process. Normal fixture teardown is tested for exit-hook and socket cleanup.

## Workloads and measurement

The seven throughput profiles are a ten-byte GET; a fixed synthetic JSON response; POST JSON verified by a streaming SHA-256 at the backend; a 64 KiB download; a 1 MiB download; two independently rotating pools; and three distinguishable backends. Direct multi-pool targets follow the same steady-state backend proportions as the proxied routes. Health monitoring is disabled for throughput comparisons; each row records metrics mode, payload size, method, actual duration and upstream deadline.

Every throughput profile compares direct backend access, proxying without metrics, and proxying with metrics. Each phase uses fresh processes and identical validation/payload settings. Mode order rotates across repetitions to reduce systematic order bias. Warmup requests finish before counters/resource windows reset; they are excluded from client results and independently counted backend requests. LoadPilot's own lifetime snapshot still contains warmup, so JSON includes `metricsRequestDelta` for the measured phase. Client, backend and enabled proxy counts must agree before the row passes.

The controller reports **every repetition** and median comparisons, never the most favorable run. Throughput is validated completions divided by measured elapsed time **including drain**. Latency starts at dispatch and ends at body completion or failure/cancellation; response bodies are hashed/discarded incrementally, not retained. Upload acknowledgement buffers are capped at 4 KiB. A reusable 64 KiB synthetic chunk avoids whole-payload allocations.

The client uses 201 fixed latency bins: 0.05 ms then 10% spacing, plus overflow. Percentiles are nearest-rank upper-bucket approximations clamped to observed maximum, not exact quantiles. Raw latency histories are not stored. Unlike production's coarser histogram, this distribution is specifically for benchmark comparisons.

### Closed loop and controlled arrivals

Closed loop maintains the requested number of outstanding requests until a request limit or duration is reached. `--rate` selects bounded controlled arrivals. The client records scheduling delay, scheduling misses and concurrency-cap misses rather than silently building a backlog. `scheduled = attempted + missedArrivals` for a complete rate window; `clientLimited` flags missed arrivals due to scheduling and/or the outstanding-request cap, not necessarily CPU exhaustion alone. Successful completions/s and attempts/s are reported separately. When the request-count limit ends a run early, future arrival slots are not generated.

Client `completed` means a fully consumed response matching expected status/body checks. In fault cases an **expected 502/504** is a successful client validation even though LoadPilot correctly classifies it as a failed exchange. Client `statuses` count observed headers, including 200 headers on a subsequently truncated response; production response-status metrics count only completed responses. Early client cancellations can occur before the HTTP handler/backend accepts a request, so client attempts may legitimately exceed accepted-request counters. All handler-accepted scopes still must settle exactly once.

### Resources and interpretation

Each process samples RSS, heap used/total, external/ArrayBuffer memory, CPU and event-loop utilization. A 20 ms `monitorEventLoopDelay` histogram supplies mean/p99/max in milliseconds (native measurements are nanoseconds); its sampling interval baseline must not be mistaken for request latency or pure event-loop blocking. See [Node's performance APIs](https://nodejs.org/api/perf_hooks.html).

CPU percent is relative to one logical core; native/GC threads may make process CPU exceed 100%. Resource windows include settling and IPC snapshot overhead. Profiles are not CPU-pinned, and a shared hybrid-core machine can produce substantial run-to-run variation.

Proxy diagnostics distinguish active HTTP requests, active upstream operations, incoming listener sockets, busy/idle agent sockets, and readable/writable buffered bytes. Sockets are actual tracked Node objects, not inferred from request counts and not OS TCP `TIME_WAIT`. Portable file-descriptor counts are unavailable (`null`). `process.getActiveResourcesInfo()` includes legitimate IPC/monitoring resources; the harness does not demand that every process resource disappear while IPC/sampling are still running. See [Node's process APIs](https://nodejs.org/api/process.html).

Resource histories retain at most 600 points by deterministic decimation; sampled maxima and total sample counts survive decimation. Peaks are **sampled peaks**, not continuous high-water guarantees. Heap slope is ordinary least squares over actual sample timestamps and includes allocation/GC/JIT effects. Soak also records post-settle (optionally post-GC) checkpoints and post-stop HTTP/agent counts. Rising RSS alone is not a leak verdict; allocator retention and new workload/JIT paths may persist after GC. A short flat trace cannot establish leak freedom.

## Fault and reliability coverage

Cases cover repeated same-instance forwarding after keep-alive-agent destruction; concurrent three-backend and independent-pool selection counts; hashed large streams; slow upstream/downstream backpressure; refused POSTs without replay; abrupt resets; below/above-deadline delays; continuously active streams hitting the total deadline; truncated bodies; application 400/404/429/500/503; backend process death/replacement; one/all unhealthy backends; automatic health recovery; four client-disconnect stages; shutdown under load; removal during active responses and a pending probe; intermittent health outcomes; probe timeouts; and overload with explicit missed arrivals. Existing health/metrics suites additionally retain shared-monitor ownership checks.

Slow-stream cases inspect actual blocked-write counts and sampled proxy buffers in addition to byte/hash correctness. The 8 MiB slow-consumer test checks sampled user-space queues remain below 2 MiB each on the tested runtime. This is a regression bound, not a universal memory-leak proof or an assertion about kernel buffering. Round Robin is verified using selection counts, not completion order. Native child failures make tests fail; unexpected fixture handler errors are counted and rejected.

Soak cycles GET, POST, reset failures, response cancellations, 1 MiB downloads, health transitions, backend identity churn, and same-instance restarts in both metrics modes. Counters remain partitioned and active requests/upstream operations/live tracked sockets must be zero after shutdown. The bounded soak does not by itself validate hours of operation.

## Artifacts, provenance and reproducibility

Each command writes `benchmarks/results/<command>.json` and `.md`, plus `latest.json`/`.md`. `--label smoke` or `--label matrix` substitutes the command basename. JSON includes schema version, timestamp, OS/CPU/core count/RAM/Node, source commit and dirty-tree flag, configuration, raw repetitions, approximate distributions, validation errors, bounded resource samples, health/request snapshots and fault/soak outcomes. Report generation validates accounting, histogram bounds, provenance and finite results.

Generated results and temporary artifacts under `results` are ignored by Git; only `.gitkeep` is tracked there. They are local and not available through GitHub. Commit the concise, sanitized, manually reviewed findings in [BASELINE.md](BASELINE.md). Do not copy raw environment dumps, private machine names, real request data, secrets, or large repetitive reports into Git.

Reports produced before the milestone commit name the parent LoadPilot source SHA and indicate a dirty tooling tree. `BASELINE.md` identifies that provenance and the exact commands. Repeat runs on another OS/hardware/runtime before drawing portability or production-capacity conclusions. HTTPS correctness remains covered by the normal suite; TLS throughput, remote deployments, multi-hour soaks, packet-level diagnostics and OS descriptor census are not established by this HTTP-only local harness.
