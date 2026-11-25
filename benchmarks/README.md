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

All fixture listeners bind `127.0.0.1`. `worker.ts` uses the public `host` option for LoadPilot. Guarded native-agent/active-exchange diagnostics remain harness-only and are reapplied to fresh agents after restart. Those diagnostics depend on current internals and fail clearly if their shape changes. No firewall, OS setting, global installation or production configuration is changed.

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

Milestone 6 adds process-level graceful completion across two backends, grace expiry, immediate escalation and backend death during drain. In-process real-network lifecycle/TLS suites cover client disconnects during drain, TLS interruption, admission rejection, pending handshakes, bounded Agent queue cleanup, shared monitor leases and restart. These are correctness checks, not a claim of production load capacity.

Slow-stream cases inspect actual blocked-write counts and sampled proxy buffers in addition to byte/hash correctness. The 8 MiB slow-consumer test checks sampled user-space queues remain below 2 MiB each on the tested runtime. This is a regression bound, not a universal memory-leak proof or an assertion about kernel buffering. Round Robin is verified using selection counts, not completion order. Native child failures make tests fail; unexpected fixture handler errors are counted and rejected.

Soak cycles GET, POST, reset failures, response cancellations, 1 MiB downloads, health transitions, backend identity churn, and same-instance restarts in both metrics modes. Counters remain partitioned and active requests/upstream operations/live tracked sockets must be zero after shutdown. The bounded soak does not by itself validate hours of operation.

## Artifacts, provenance and reproducibility

Each command writes `benchmarks/results/<command>.json` and `.md`, plus `latest.json`/`.md`. `--label smoke` or `--label matrix` substitutes the command basename. JSON includes schema version, timestamp, OS/CPU/core count/RAM/Node, source commit and dirty-tree flag, configuration, raw repetitions, approximate distributions, validation errors, bounded resource samples, health/request snapshots and fault/soak outcomes. Report generation validates accounting, histogram bounds, provenance and finite results.

Generated results and temporary artifacts under `results` are ignored by Git; only `.gitkeep` is tracked there. They are local and not available through GitHub. Commit the concise, sanitized, manually reviewed findings in [BASELINE.md](BASELINE.md). Do not copy raw environment dumps, private machine names, real request data, secrets, or large repetitive reports into Git.

Reports produced before the milestone commit name the parent LoadPilot source SHA and indicate a dirty tooling tree. `BASELINE.md` identifies that provenance and the exact commands. Repeat runs on another OS/hardware/runtime before drawing portability or production-capacity conclusions. HTTPS correctness remains covered by the normal suite; TLS throughput, remote deployments, multi-hour soaks, packet-level diagnostics and OS descriptor census are not established by this HTTP-only local harness.

## Memory forensics and capacity (Milestone 5)

```sh
npm run bench:memory
npm run bench:memory -- --scenarios get,metrics,health-idle,health-get --duration 10 --gc
npm run bench:memory -- --mode investigation --scenarios download-8,mixed --duration 120 --warmup 2 --idle 10 --gc
npm run bench:memory -- --scenarios download-32 --duration 120 --gc --gc-policy end --label idle-recovery
npm run bench:soak -- --mode investigation --duration 120 --idle 10 --gc
npm run bench:soak -- --mode extended --duration 600 --idle 30 --gc
npm run soak -- --duration 60 --concurrency 10 --sample-ms 100 --gc --diagnostics --idle 10 --label legacy-memory
npm run bench:capacity -- --rates 100,1000,3000 --profiles get,json --duration 3 --warmup 0.5 --repetitions 2 --concurrency 100
npm run bench:capacity -- --rates 100,500 --p95-ms 50 --p99-ms 100 --error-rate 0.001 --arrival-tolerance 0.02 --completion-tolerance 0.02
npm run build
npm run check:package
```

`investigate.ts` orchestrates these new commands using the same `Environment`, workers, native generator, sampler and report writer as Milestone 4. Existing commands remain available. The new default is a three-second **smoke** window per selected scenario/stage; `--mode investigation` defaults to 120 seconds and `--mode extended` to 600 seconds. These are per scenario (memory) or per mode/rate/repetition (capacity), not total command runtime. Explicit `--duration` overrides the mode. Long runs are never part of `npm test` or ordinary CI.

Memory scenarios: `idle,get,metrics,health-idle,health-get,download-1,download-8,download-32,upload-1,upload-8,upload-32,cancel,failures,keepalive-off,churn,churn-metrics,restart,mixed`. Defaults are idle/get/metrics/download-8; `bench:soak` selects mixed. Every scenario starts fresh processes. The default batch is 20 requests, concurrency 20, followed by 100 ms settling; stream batches cap at two requests/concurrency two. `--batch-requests` (1–1000) and `--concurrency` (1–500) control intensity. Unlike a continuous capacity run, memory runs deliberately pause to inspect settled state. They cannot establish peak throughput. Compare actual counts and duration as well as configuration.

Metrics is enabled for `metrics`, `churn-metrics` and `mixed`; health for `health-idle`, `health-get` and `mixed`. Probe settings remain the diagnostic fixture's 50 ms interval, 100 ms deadline and thresholds two, not the production defaults. Failure scenarios explicitly cycle refusal, reset, timeout, truncation and backend process replacement. With health enabled, a refused batch can transition from 502 to confirmed-unavailable 503; both are validated, with no replay. Mixed also cycles health transitions and registration/restart activity.

`keepalive-off` disables client reuse and, through the guarded harness-only Agent adapter, upstream keep-alive. This isolates connection churn; it does not introduce a public production configuration or recommend disabling reuse. Network checkpoints record actual lifetime accepted/upstream-created connections, busy/idle Agent sockets and queued Agent requests. Counts include warmup, so compare against baseline checkpoints. Listener counts, active metric scopes and retired metric rows are checked after settling. Exited replacement workers are released by the controller rather than accumulated in its worker list.

### Checkpoints and memory interpretation

Memory commands record startup-after-readiness, warmup-end, baseline, settled batches, load-end, idle midpoint/end, optional immediate post-GC and one-second post-GC-idle, then stopped state. `--idle` defaults to two seconds and is bounded to 0–300 seconds. A final batch or timeout may extend the requested load duration; JSON records actual load and total runtime separately. Warmup/readiness, settling and idle are not counted as the configured load window.

`--gc` exposes GC only in synthetic fixtures. With default `--gc-policy checkpoint`, GC runs at baseline, after each settled batch, and after idle. `--gc-policy end` instead limits explicit GC to baseline and after idle, allowing natural collection during load. These policies perturb memory/CPU and must be labeled when comparing runs. Neither is normal LoadPilot behavior. Histograms aggregate bounded per-batch distributions; deliberate partial responses are failed client outcomes, while expected 502/503/504 are successful validations of failed proxy exchanges.

RSS, heap used/total, external and ArrayBuffer memory stay separate. External **includes** ArrayBuffers; they must not be added as independent totals. `rssMinusHeapTotal` is a descriptive difference, not exclusively native memory. Checkpoints use supported [V8 APIs](https://nodejs.org/docs/latest-v22.x/api/v8.html) for heap limits/availability, spaces and code/metadata. V8 `malloced_memory` is not a whole-process native-allocation census. Space capacity and live objects have different meanings. Full sampler histories include warmup/allocation peaks; reported memory trends use baseline plus settled (post-GC when configured) checkpoints, and separately the latter half. All timestamps are actual monotonic observations. Raw samples allow full-window analysis without equating these different populations.

Trend classifications are **heuristics**, not automatic leak findings. Fewer than six checkpoints or 30 seconds is inconclusive. Late heap slope above 64 KiB/s or external/RSS above 128 KiB/s flags suspicious growth. A >8 MiB RSS rise with late RSS slope <16 KiB/s and heap/external growth <2 MiB suggests warmup/retention; net RSS change <8 MiB with heap/external growth <2 MiB records no concerning growth. Other patterns remain inconclusive. Whole-run slopes can hide plateaus; inspect late trends, heap spaces, repeated checkpoints and post-idle recovery. Ordinary tests assert resource invariants, not exact RSS or GC timing.

Optional snapshots: `npm run bench:memory -- --scenarios get --duration 3 --snapshots`. Exactly one scenario is required, with at most two snapshots (baseline and after idle) in `results/heaps/`. Snapshots block the fixture and can consume substantial time, memory and disk; they distort timing and do not explain all native memory. Only fixture processes may generate them; no request hook can trigger snapshots. Workers inherit essential runtime environment keys rather than application/repository credentials. Snapshots may still contain runtime file paths; keep them local and inspect before sharing. They are ignored by Git. Do not claim snapshot analysis unless actually performed.

### Controlled-arrival semantics and SLOs

Capacity compares direct, proxy, metrics, and metrics-plus-health on small GET and synthetic JSON. Each stage has fresh processes, identical body validation, configurable warmup and rotated mode order. Limits: ten distinct rates (1–100,000/s), 1–5 repetitions, at most 300 phases; duration 0.1 seconds–24 hours, sample interval 50–30,000 ms. Choose high values explicitly. No external target flag exists.

The scheduler now dispatches a bounded group of due arrivals after a delayed wakeup, up to free concurrency. It never builds an arrival queue. Excess old slots are explicitly classified as scheduling-bound catch-up misses or concurrency-cap misses. Each attempted request retains its scheduled arrival time. `latencyMs` measures dispatch to complete body/failure; `scheduleLatencyMs` includes dispatch delay; `headersLatencyMs` measures dispatch to observed headers. All attempted outcomes appear in completion distributions, including failures/timeouts/cancellations. Skipped slots have no invented response latency and are evaluated separately, avoiding a misleading success-only latency population. This is a bounded open-arrival approximation, not an unlimited rate guarantee.

SLO defaults are schedule-relative p95 ≤50 ms, p99 ≤100 ms, error fraction ≤0.001, missed arrivals ≤0.02, and both completion count/offered slots and achieved completion rate (including drain) within 0.02 of offered traffic. Fractions use 0–1, not percentages. These are synthetic-test targets, not universal product SLOs. Empty/partial/inconsistent populations cannot pass. The highest **tested passing rate** requires all planned repetitions for that profile/mode to pass; no interpolation or maximum-sustainable-capacity claim is made. A raw `clientLimited` flag records any missed slot; SLO classification tolerates misses only up to the explicitly configured threshold. A failed SLO is an experimental finding; only harness correctness/cleanup failure exits nonzero.

Reports show offered/attempted/completed/failed rates, scheduling misses/delay, peak outstanding concurrency, service/schedule percentiles, 5xx, enabled upstream timeout counters, all three processes' CPU/ELU/memory, and per-rate dispersion. CPU/ELU and miss categories suggest plausible bottlenecks, not exclusive causal attribution. `executionStatus` distinguishes running/completed/failed/interrupted reports, and results are checkpointed after each completed scenario/stage. A killed run may retain a running/partial report, never an implicit complete result.

### Runtime/platform verification

`npm run check:package` compiles a consumer against built package declarations and exercises built HTTP/HTTPS forwarding, health, metrics and restart using the existing public TLS test fixture. GitHub Actions runs Node 22.19.0 and 24.x on Windows/Ubuntu/macOS, with full tests, build/package checks and tiny harness smoke commands. There are no timing-based throughput assertions or long CI soaks. Documentation-only pushes do not rerun this matrix. A workflow definition is not proof of a passed job: consult the actual run linked from [MEMORY_AND_CAPACITY.md](MEMORY_AND_CAPACITY.md).

New raw artifacts default to `memory-isolation.*`, `capacity.*` and `extended-soak.*`; labels can separate repetitions. They remain local/ignored. The committed [MEMORY_AND_CAPACITY.md](MEMORY_AND_CAPACITY.md) records actual executed findings, failed/partial attempts and unexecuted longer validation.


## Algorithm comparison (all six strategies)

```sh
npm run bench:algorithms -- --duration 5 --warmup 1 --concurrency 30 --repetitions 3 --label six-algorithms
npm run bench:algorithms -- --profiles heterogeneous,unhealthy --duration 30 --warmup 3 --concurrency 100 --rate 1000 --repetitions 3 --label paced-algorithms
npm run bench:soak -- --mode extended --duration 1800 --warmup 2 --idle 15 --gc --label release-soak
```

The comparison runs all six algorithms in rotated order, using fresh separate processes and real HTTP. Profiles: uniform (equal weights/no intentional delay), weighted (5:3:2 weights), heterogeneous (5:3:2 weights and 2/10/40 ms application delay), unhealthy (same configuration with the third backend excluded before warmup). Health and metrics are enabled consistently. It records client throughput, latency, missed arrivals, actual backend distribution, CPU/memory and validates counts, health exclusion and zero tracked resources after shutdown. The report is local JSON in ignored `benchmarks/results/`; no measured comparison is claimed until execution. The extended soak command exercises the pre-existing mixed-workload retention harness; it is not an all-algorithm soak.


## Memory sampling correction

Both the periodic monitor and settled/post-GC checkpoint histories now retain the most recent observation per elapsed-time bucket, coarsening the full history uniformly as necessary. Early and late slopes use elapsed-time halves and equally weighted occupied time buckets. Missing half-window coverage yields Inconclusive; no warning thresholds were relaxed. Old reports cannot recreate deleted checkpoints and must not be reclassified as a clean pass. Correctness PASS is separate from memory classification.

Reproduce the extended mixed-workload investigation with:

```sh
npm run bench:soak -- --mode extended --duration 1800 --warmup 2 --idle 15 --gc --label release-soak-v2
npm run bench:memory -- --scenarios get,metrics,health-get --duration 120 --warmup 2 --idle 10 --gc --label release-isolation
```

The mixed harness exercises one backend and default Round Robin; other strategies have separate correctness/short comparative runs, not long-duration proof. Do not claim leak-freedom even if the diagnostic is favorable.
