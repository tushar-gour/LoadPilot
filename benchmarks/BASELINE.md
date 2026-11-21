# Milestone 4 executed baseline

The executed configurations passed their correctness checks. No production defect or justified optimization was confirmed, so `src/` and the public API remain unchanged. These short, local synthetic measurements are a reproducible baseline, not production capacity or leak-freedom certification.

## Environment and provenance

- Windows 11, Node platform `win32`, OS release `10.0.26300`; Node `v24.14.0`.
- Intel Core i7-12700H, 20 logical CPUs, 23.6 GiB RAM. Shared host, no CPU affinity or controlled background workload.
- LoadPilot source: `d7ca2bd45020f59a3bd72341a0c3850cae2b8dbe`. Reports identify a dirty working tree containing the new harness; production source is identical to that commit.
- Separate client, proxy and backend processes; native HTTP over `127.0.0.1`, dynamic ports, keep-alive enabled, synthetic payloads. No external targets.
- Throughput phases: health checks disabled; metrics disabled/enabled as labeled; proxy total deadline 30 seconds, client deadline 5 seconds. Sampling every 200 ms. Each phase has fresh processes, 250 ms request warmup excluded from results, then one measured second plus completion drain. Mode order rotates across repetitions.
- Percentiles below are **medians of three per-run approximate percentiles**, not pooled or exact quantiles. The client uses 201 fixed histogram bins with 10% spacing. Throughput uses validated completions divided by elapsed time including drain.

## Commands actually executed

```sh
npm run bench -- --label smoke
npm run bench:full -- --concurrency 10 --duration 1 --repetitions 3 --label matrix
npm run fault
npm run bench:stream -- --payload-mib 1 --concurrency 1
npm run soak -- --duration 12 --concurrency 10 --sample-ms 100 --gc
npm run soak -- --duration 60 --concurrency 10 --sample-ms 100 --gc --label soak-60
```

The completed smoke report contains 18 phases (GET at concurrency 1/10, three modes, three repetitions), 72,523 validated requests and zero failures. The completed matrix contains 63 phases (seven profiles at concurrency 10), **263,923 validated requests and zero failures**. An earlier matrix execution was interrupted before report creation; its partial output is excluded from these findings.

## Throughput comparison

All values are median requests/second across three equivalent repetitions at concurrency 10. Ratios are ratios of medians. JSON is a fixed synthetic 12-item response; POST checks its JSON payload by streaming hash; `64k`/`1m` are hashed streamed downloads. `pools` uses two independent routes with three/two backends; `backends` uses three backends in one pool.

| Profile | Direct | Proxy | Proxy + metrics | Proxy/direct | Metrics/proxy | Added mean latency: proxy / metrics (ms) |
|---|---:|---:|---:|---:|---:|---:|
| GET, 10 bytes | 9,775.1 | 4,524.1 | 4,247.7 | 0.463 | 0.939 | 1.179 / 0.143 |
| JSON | 9,581.5 | 4,552.5 | 4,280.4 | 0.475 | 0.940 | 1.145 / 0.140 |
| POST JSON | 7,851.3 | 3,732.9 | 3,242.5 | 0.475 | 0.869 | 1.394 / 0.401 |
| 64 KiB | 2,741.9 | 1,849.8 | 1,822.3 | 0.675 | 0.985 | 1.743 / 0.086 |
| 1 MiB | 252.7 | 235.6 | 228.0 | 0.932 | 0.968 | 2.986 / 1.376 |
| Multiple pools | 7,721.3 | 3,526.0 | 3,510.8 | 0.457 | 0.996 | 1.525 / 0.016 |
| Multiple backends | 7,907.8 | 3,575.1 | 3,391.0 | 0.452 | 0.948 | 1.521 / 0.149 |

Added mean latency compares the median client means of proxy minus direct, then metrics minus proxy. It includes TCP hops, client/runtime work and measurement noise; it is not isolated proxy computation. GET with metrics had 6.1% lower median throughput in this matrix, but the separate smoke run observed 11.5% lower at concurrency 10. That variation and the short windows prevent a precise universal metrics-overhead claim. At concurrency 1 the smoke medians were 3,104.2 / 1,138.7 / 1,134.5 requests/sec (direct/proxy/metrics).

## Client latency

Each cell is p50 / p95 / p99 in milliseconds, with zero request validation failures in all rows.

| Profile, concurrency 10 | Direct | Proxy | Proxy + metrics |
|---|---:|---:|---:|
| GET | 0.872 / 1.870 / 2.738 | 2.057 / 4.009 / 5.336 | 2.263 / 4.009 / 5.870 |
| JSON | 0.872 / 1.870 / 3.012 | 2.057 / 3.645 / 5.336 | 2.263 / 4.009 / 5.870 |
| POST | 1.056 / 2.489 / 3.313 | 2.489 / 4.851 / 7.102 | 3.012 / 5.336 / 7.812 |
| 64 KiB | 3.313 / 6.456 / 8.594 | 4.851 / 10.398 / 13.840 | 5.336 / 10.398 / 12.582 |
| 1 MiB | 39.487 / 69.954 / 92.957 | 43.436 / 63.595 / 69.156 | 43.436 / 63.595 / 83.608 |
| Multiple pools | 1.161 / 2.738 / 3.645 | 2.489 / 4.851 / 7.102 | 2.738 / 5.336 / 7.812 |
| Multiple backends | 1.056 / 2.489 / 3.313 | 2.738 / 5.336 / 7.812 | 2.738 / 5.336 / 7.102 |

The 1 MiB proxied tail was lower than direct in this run despite lower throughput. Do not interpret this as a proxy optimization: closed-loop scheduling, batching, process/runtime behavior and shared-host noise affect these measurements.

## Resource observations

GET at concurrency 10, medians across the matrix's three repetitions:

| Mode | Client CPU % | Backend CPU % | Proxy CPU % | Proxy sampled peak RSS MiB | Proxy sampled peak heap MiB | Proxy ELU | Proxy event-loop delay p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| Direct | 116.7 | 115.2 | n/a | n/a | n/a | n/a | n/a |
| Proxy | 88.6 | 79.1 | 116.7 | 68.7 | 14.6 | 0.992 | 21.14 |
| Metrics | 79.4 | 66.3 | 115.8 | 85.9 | 18.0 | 0.994 | 21.50 |

CPU is relative to one logical core; native/GC threads can exceed 100%. Resource windows include settling/IPC overhead. Event-loop delay uses a 20 ms sampling resolution: these values include the sampling baseline and are not 21 ms request stalls. Proxy event-loop utilization was high in these closed-loop runs; a capacity/SLO claim needs a controlled-arrival sweep and longer windows.

## Reliability evidence

All 18 explicit fault scenarios passed in the standalone suite:

- Five same-instance forwarding/stop/start cycles completed 150 requests and closed tracked sockets; three additional construct/teardown cycles check child exits and parent exit-listener counts in the regression suite.
- 300 requests at concurrency 50 produced exactly **100/100/100** selections, independently checked by client IDs, backend counters and metrics. Independent pools rotated **51/50/50** and **75/75** for 301 requests.
- Streaming SHA-256 and byte counts matched for **1/8/32 MiB uploads and downloads** without whole-payload retention.
- Slow 8 MiB receivers produced actual backpressure: 128 backend blocked writes and sampled proxy readable/writable queues of **65,536 / 65,542 bytes** in the initial run. This supports bounded queues for that case, not every possible workload or kernel buffer.
- Refused POST selections returned 502 without replay; resets and partial 200 responses settled once; delayed/stalled requests returned 504 before headers, while a continuously active stream still hit the total exchange deadline and terminated after headers.
- Application 400/404/429/500/503 remained valid backend responses. Killing a backend with 12 active exchanges yielded transport failures, then confirmed-unhealthy 503s; replacement on the same port recovered automatically.
- Health exclusion/recovery restored 30/30/30 selections; client cancellation at four stages did not penalize health. Shutdown cancelled 12 active requests and allowed forwarding after restart.
- Removing a backend cancelled a pending probe without false failure, preserved six active responses, discarded its retired metric row after settling, and allowed a fresh registration.
- Alternating health outcomes respected consecutive thresholds; probe timeouts recovered; a deliberately overloaded 5,000/s arrival schedule reported missed arrivals and bounded pending work rather than hiding backlog.

Expected fault statuses are successful **client validations**, while LoadPilot still records appropriate failed exchanges. All accepted scopes check zero active gauges, exactly-once partitions, response/latency counts and zero instrumentation errors. Existing shared-pool, UNKNOWN, HTTPS and health-during-stream tests remain intact.

## Bounded sustained-operation results

The initial 12-second-per-mode check completed 18 batches per mode in 12.28 / 12.25 seconds. It was followed by the **60-second-per-mode** command above, at concurrency 10 with 100 ms sampling, health enabled (50 ms interval, 100 ms probe deadline, thresholds 2), client/proxy deadlines 5 seconds and optional explicit GC at settled checkpoints. GET warmup/readiness and initial settling precede the measured window; later workloads may still introduce new JIT/allocator paths.

The longer run mixed GET, POST, upstream resets, response cancellations, 1 MiB downloads, health exclusion/recovery, backend identity churn and same-instance restarts. Each batch checks accounting when metrics are enabled. All measured HTTP active/agent/socket counts were zero after stop in both modes.

| Mode | Actual seconds | Batches | Initial/final RSS MiB | Peak RSS MiB | Initial/final heap MiB | Peak heap MiB | Settled heap range MiB |
|---|---:|---:|---:|---:|---:|---:|---:|
| Metrics disabled | 60.165 | 88 | 68.6 / 170.2 | 218.3 | 10.69 / 10.05 | 54.46 | 9.30–10.88 |
| Metrics enabled | 60.165 | 87 | 69.0 / 156.1 | 201.7 | 10.74 / 10.30 | 52.74 | 9.37–10.96 |

Ordinary least-squares heap slopes over all sampler points were +66,759 / +55,959 bytes/sec (disabled/enabled), reflecting transient allocation as well as retention. Over post-settle, post-GC checkpoints they were approximately **+2,970 / +3,142 bytes/sec**; over the latter half, +1,499 / +2,794 bytes/sec. The final ten settled heap values were 9.69–9.87 MiB disabled and 9.76–10.02 MiB enabled. The final resource snapshot follows a little more probe/IPC work than the settled checkpoint, explaining the differing final heap values.

Heap remained in a narrow band during these runs and tracked HTTP resources settled. **RSS nevertheless grew materially**, by about 102 / 87 MiB from initial to final; peaks were higher. Native allocator/Buffer retention and warmup can contribute, but this run does not isolate the cause. It is a retained-memory question for longer runs and heap/native-memory investigation, not evidence to dismiss or a confirmed production leak. Neither the short nor the 60-second run establishes long-term stabilization or leak freedom.

## Fixes

No production bug was reproduced and no speculative optimization was applied. An early soak run exposed a **new harness** bug: fractional remaining milliseconds failed integer duration validation. The harness now rounds the batch duration, and a CLI regression exercises fractional remaining time in both modes. The successful reruns, rather than the failed attempt, are the accepted observations.

## Verification

- Initial suite: **144 passed**, zero failures/skips. Final suite: **167 passed**, zero failures/cancellations/skips (35.83 seconds), including 23 new reliability/harness checks.
- `npm install`: up to date, eight packages audited, zero reported vulnerabilities; no dependency or lockfile changes.
- `npm run typecheck` and `npm run build`: passed with strict NodeNext settings; typecheck includes the harness and all tests.
- `npm pack --dry-run --cache .npm`: passed, 28 package files; only built JavaScript/declarations, package metadata and README, with no harness or raw results.
- A temporary consumer imported the built package through its package exports, compiled against the generated declarations, and completed two start/forward/stop cycles on the same instance with health/metrics enabled. The temporary consumer is not committed.
- The custom-size streaming CLI also passed a 1 MiB hashed upload and download; the standard 1/8/32 MiB coverage passed in the fault and test suites.
- Completed smoke/matrix reports and the standalone 18-case fault suite passed. Report generation checks provenance, count partitions, bounded histograms/samples, finite rates and ordered percentiles.

## Limits and next work

The portable implementation uses native Node APIs and no new dependencies, but this execution validates Windows/Node 24 only. Linux, macOS, Node 22 runtime execution, TLS throughput, remote-network behavior, OS descriptor/TIME_WAIT counts, full concurrency sweeps, multi-hour soaks and production traffic remain untested. Public APIs and the 144 pre-existing tests are preserved.

Raw JSON and generated Markdown in `benchmarks/results/` are intentionally ignored and **local only**, including `smoke.*`, `matrix.*`, `fault.*`, `soak.*` and `soak-60.*`; they are not retrievable from GitHub. This sanitized summary is the committed evidence. See [README.md](README.md) for commands, configuration limits and interpretation rules.

The next useful milestone is controlled-arrival capacity/SLO characterization and longer cross-platform retention testing, followed by profiling any reproducible bottleneck. Do not optimize solely from these short ratios.
