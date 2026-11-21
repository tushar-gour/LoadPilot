# Milestone 5: memory and controlled-arrival findings

The tested RSS increase is **not evidence of a confirmed application-object leak**. V8 young-generation capacity expansion and subsequent idle recovery explain an important part of the observations. Some runs retained elevated RSS after GC without growing live heap, so native/resident-page attribution remains incomplete. No production source or public API was changed.

## A. Environment

Local execution: Windows 11 (`win32`, release `10.0.26300`), Node **v24.14.0**, Intel Core i7-12700H, 20 logical CPUs, 23.6 GiB RAM. Production source is unchanged from `1e24335ab85838ef64aa3b22b4b4a6c58dded8b1`; experiment reports identify that parent SHA and a dirty tooling tree. No hostname, credentials or application data was collected. The host was shared, not CPU-pinned. These are local synthetic HTTP measurements, not deployment guarantees.

## B. Methodology and executed work

The existing separate-process client/proxy/backend infrastructure is reused. Listeners use loopback/dynamic ports. Histograms retain 201 fixed bins (10% spacing); samples/checkpoints are bounded to 600 with decimation. V8 space/code statistics are checkpoint observations, not continuous high-water measurements. External includes ArrayBuffers; these categories must not be added. RSS minus heap-total is not an exclusively native-memory measurement and can be negative.

Executed commands (plus normal verification):

```sh
npm run bench:memory -- --scenarios idle,get,metrics,health-idle,health-get,download-1,download-8,download-32,upload-1,upload-8,upload-32,cancel,failures,keepalive-off,churn,churn-metrics,restart,mixed --duration 3 --warmup 0.5 --idle 3 --sample-ms 200 --gc --concurrency 8 --label memory-isolation
npm run bench:memory -- --mode investigation --scenarios download-8,mixed --duration 120 --warmup 2 --idle 10 --sample-ms 200 --gc --concurrency 8 --label sustained-memory
npm run soak -- --duration 60 --concurrency 10 --sample-ms 100 --gc --diagnostics --idle 10 --label legacy-memory
npm run bench:soak -- --mode investigation --duration 120 --warmup 2 --idle 10 --sample-ms 200 --gc --concurrency 8 --label mixed-sustained
npm run bench:memory -- --scenarios download-32 --duration 15 --warmup 2 --idle 10 --gc --gc-policy end --concurrency 8 --label idle-recovery
npm run bench:capacity -- --rates 100,1000,3000 --profiles get,json --duration 3 --warmup 0.5 --repetitions 2 --concurrency 100 --label capacity
npm run bench:capacity -- --rates 5000 --profiles get,json --duration 3 --warmup 0.5 --repetitions 2 --concurrency 100 --label capacity-upper
```

The 18-case isolation suite passed. Its nominal three-second windows actually took **3.00–5.96 seconds**: a bounded final batch/timeout can extend the requested window. Small-request batches use 20 requests, eight concurrent; streaming batches use two requests/concurrency two, followed by 100 ms settling. Explicit diagnostic GC runs at baseline, settled checkpoints and after idle unless `--gc-policy end` is selected. Warmup, idle and snapshots are outside the configured load duration. These pauses/intensities differ from continuous throughput tests.

**Failed/partial attempt:** `sustained-memory` completed the 120-second download experiment, then failed in mixed traffic because the new fixture expected only 502 during a health-enabled refusal batch; seven responses violated that expectation. A focused reproduction observed eight 502s followed by twelve 503s, then six 503s after explicit health confirmation, establishing the incorrect fixture contract. The combined report remains explicitly **failed**, with the completed download observation retained. The contract was corrected, an eight-second mixed regression run passed, and the independent 120-second `mixed-sustained` rerun passed. The failed combined command is not presented as a passed soak.

Capacity comprised **64 stages**, three seconds each plus 500 ms warmup/drain/startup, with two repetitions and rotated order for direct/proxy/metrics/metrics-plus-health. **420,230 requests were attempted and validated, zero failed; 16,570 arrival slots were skipped explicitly.** Skipped slots are not request failures. No tests/other load experiments ran concurrently with these sweeps; ordinary controller activity/shared-host scheduling still introduces noise.

## C. Memory breakdown: reproduce the previous soak

The previous raw samples already contained a clue: Milestone 4 final heap **total** was approximately 142 MiB, despite only 10 MiB used. Heap-used alone understated V8 capacity. The new reproduction adds actual space observations and idle recovery to the same 60-second mixed workload, concurrency ten, health enabled, 100 ms sampling and checkpoint GC.

All memory values below are MiB, rounded. `idle` is ten seconds after traffic ends, before the additional explicit GC.

| Mode / point | RSS | Heap used | Heap total | External | ArrayBuffers | V8 new-space capacity |
|---|---:|---:|---:|---:|---:|---:|
| Disabled / baseline | 71.85 | 10.79 | 20.82 | 3.96 | 0.09 | 8 |
| Disabled / load end | 138.17 | 10.62 | 142.51 | 3.96 | 0.09 | 128 |
| Disabled / idle | 68.61 | 10.42 | 11.98 | 3.96 | 0.09 | 1 |
| Disabled / idle GC | 68.99 | 9.79 | 11.98 | 3.96 | 0.09 | 1 |
| Disabled / one second after GC | 69.06 | 10.48 | 11.98 | 3.96 | 0.09 | 1 |
| Enabled / baseline | 71.59 | 10.84 | 20.32 | 3.96 | 0.09 | 8 |
| Enabled / load end | 150.10 | 10.69 | 141.76 | 3.96 | 0.09 | 128 |
| Enabled / idle | 67.28 | 10.51 | 12.23 | 3.96 | 0.09 | 1 |
| Enabled / idle GC | 67.65 | 9.91 | 12.98 | 3.96 | 0.09 | 2 |
| Enabled / one second after GC | 68.38 | 10.60 | 12.98 | 3.96 | 0.09 | 2 |

The disabled/enabled runs completed **60.126 / 60.103 seconds of load**, 87 batches each, with **35,694 / 31,121 attempts**. Client outcome partitions were 33,776 completed +1,918 cancelled and 29,416 completed +1,705 cancelled, with zero unexpected validation failures. Completed here includes expected proxy error responses; intentional cancellations are separate. Body-completion/failure p50/p95/p99 were 8.59/43.44/69.95 ms and 9.45/47.78/76.95 ms. These mixed-outcome populations are not GET-only latency comparisons.

Sampled peaks: RSS **183.11 / 196.22**, heap used **40.81 / 46.91**, external **56.40 / 52.27**, ArrayBuffers **52.53 / 48.41** MiB. Buffers spiked during traffic, then their counters returned near baseline. Old-space live bytes stayed around 7 MiB rather than tracking RSS; code/metadata increased only approximately 3.43→3.71 MiB and 3.45→3.73 MiB. Relevant tracked operations/queues/sockets were zero after shutdown in both runs.

**Supported interpretation:** V8 young-generation capacity rose from 8 to 128 MiB and later shrank to 1–2 MiB alongside RSS recovery. This supports warmup/heap-capacity retention, not increasing reachable JavaScript payloads, as an important explanation in this workload. V8 heap capacity is not a byte-for-byte RSS census; these correlations do not identify every resident page or native allocator. No allocator-specific attribution is claimed.

## D. Isolated workload findings

Fresh processes per row; columns show baseline/sample peak/post-idle-GC RSS and post-idle-GC heap used. Every short trend classification was **inconclusive** because the window was under 30 seconds.

| Workload | Actual attempts | RSS baseline / peak / idle-GC MiB | Idle-GC heap MiB |
|---|---:|---:|---:|
| Idle | 0 | 65.65 / 65.66 / 65.47 | 9.60 |
| GET | 420 | 71.26 / 71.98 / 71.93 | 10.65 |
| GET + metrics | 440 | 71.89 / 72.28 / 72.22 | 10.72 |
| Health only | 0 | 65.92 / 66.35 / 66.17 | 10.17 |
| Health + GET | 440 | 72.23 / 72.41 / 71.73 | 10.78 |
| Download 1 MiB | 46 | 71.27 / 75.74 / 71.60 | 10.62 |
| Download 8 MiB | 30 | 71.62 / 89.65 / 71.97 | 9.19 |
| Download 32 MiB | 16 | 71.80 / 123.66 / 73.17 | 9.13 |
| Upload 1 MiB | 44 | 70.96 / 73.68 / 71.29 | 10.61 |
| Upload 8 MiB | 32 | 71.49 / 80.07 / 71.64 | 9.17 |
| Upload 32 MiB | 18 | 71.00 / 90.20 / 73.02 | 9.17 |
| Response cancellations | 300 | 71.37 / 83.48 / 72.61 | 9.23 |
| Refusal/reset/timeout/truncation | 60 | 71.31 / 71.80 / 71.68 | 10.62 |
| Keep-alive off | 380 | 70.68 / 71.49 / 71.23 | 10.57 |
| Registration churn | 440 | 70.82 / 71.75 / 71.36 | 10.67 |
| Churn + metrics | 420 | 72.11 / 80.02 / 71.91 | 10.74 |
| Same-instance restarts | 420 | 71.46 / 72.29 / 71.58 | 10.78 |
| Mixed | 224 | 72.11 / 88.54 / 72.93 | 9.47 |

Large streams/cancellations correlated with transient external/Buffer peaks. After idle GC, their external/ArrayBuffer counters were again approximately 3.96/0.09 MiB. The small difference between fresh GET/metrics processes is not evidence of significant metrics retention, especially with differing achieved counts and only three seconds of load.

Upstream reuse was directly observed: GET created eight upstream connections during warmup and **zero additional** connections for its 420 measured requests. The off comparison created **380 additional connections for 380 requests**. This establishes connection behavior, not an RSS optimization; disabling reuse changed workload cost and achieved counts. Health-only/health-plus-GET observed 113/115 probes, with zero active probes after shutdown. Churn/restart checks retained one current backend, no retired active rows/scopes, stable listener counts, and zero queued requests after settling.

## E. Idle recovery and competing explanations

A separate **15.043-second**, 78-request, 32 MiB download run used GC only at baseline/after idle, not between load batches. RSS was 104.46 MiB after warmup, 104.19 at load end, 104.37 after five idle seconds, then **63.73 after ten idle seconds, before explicit GC**. Heap total fell from 76.32 to 11.57 MiB and new-space capacity from 64 to 1 MiB. Explicit GC gave 63.42 MiB RSS; one second later it was 63.55. This demonstrates that natural idle recovery occurred in that run without per-batch manual GC. It does not guarantee recovery on every workload/platform.

Hypotheses:

- **Increasing live JavaScript objects:** not supported by these runs' stable/falling old-space usage, post-GC used heap, stable listeners and empty active scopes. No application-object retention path was confirmed.
- **Growing live Buffer backing stores:** transient peaks were observed, but persistent growth was not supported at the sampled settled/post-idle checkpoints. External accounting is not a complete allocation trace.
- **Unbounded retained Agent queues/sockets:** not observed; connection reuse, queued requests, restart cleanup and cancellation invariants passed. These are instrumented Node objects, not OS descriptor/TIME_WAIT counts.
- **V8 capacity/warmup:** supported by space statistics and idle shrink/recovery. Code/metadata alone was too small to account for the observed increases.
- **Released-but-resident pages, allocator fragmentation or other native retention:** unresolved where RSS remained elevated despite smaller V8/Buffer counters. No native allocator profiler or resident-page attribution was executed.

No heap snapshots were generated or analyzed: measurements did not establish retained live V8 objects. An opt-in, two-snapshot fixture-only mechanism is available for future targeted investigation; raw snapshots are ignored and can be large.

## F. Sustained stability and residual retention

| Workload | Actual load seconds | Attempts / completed / failed / cancelled | RSS baseline / load end / idle GC / stopped MiB | Peak RSS / heap / external / buffers MiB |
|---|---:|---:|---:|---:|
| 8 MiB downloads | 120.156 | 1192 / 1192 / 0 / 0 | 87.32 / 112.27 / 112.28 / 91.32 | 124.53 / 15.28 / 35.96 / 32.09 |
| Corrected mixed | 120.007 | 7284 / 6064 / 200 / 1020 | 123.53 / 124.40 / 125.88 / 125.88 | 156.06 / 42.40 / 35.96 / 32.09 |

The 200 mixed client failures were deliberately truncated responses; the run also recorded 200 expected upstream timeouts (their completed 504 validations belong to completed). Its **411 batches** included health exclusion/recovery, resets/refusals, process replacement, cancellation, registration churn and same-instance restart. All accounting/resource assertions passed. Total runtime including warmup/idle was **133.216 seconds**.

The mixed process began around 65.52 MiB RSS, reached 123.53 during its two-second closed-loop warmup, then stayed near that level during the bounded investigation. Post-GC heap was around 10 MiB, external/ArrayBuffers near 3.96/0.09 MiB, with no active/retired scopes. Its residual RSS above startup was **not explained completely** by live V8/Buffer counters; it must not be declared leak-free. Net stability after warmup is consistent with retained runtime/allocator capacity, but a longer trace and native attribution are still needed.

Trend measurements, bytes/second, computed from actual timestamps:

| Workload | Full sampler RSS slope | Settled early / whole / late RSS slope | Settled late heap / external slope | Net RSS bytes per completed request |
|---|---:|---:|---:|---:|
| Downloads | +121,149 | +263,848 / +236,751 / +150,369 | +115 / −2,343 | +21,951 |
| Mixed | +32,196 | +19,988 / +18,396 / +52,015 | +4,186 / +97,167 | +149 |

Full sampler slopes include warmup and transient allocations; settled slopes use baseline plus post-GC checkpoints, with early/late halves. These are different populations. Full/early slopes above were recomputed from retained raw samples using `helpers/analysis.ts`; the original download/mixed JSON was produced before these additional derived fields were added. Decimation preserves sample bounds/maxima but changes point weighting.

The download run crossed the heuristic's late RSS threshold (>128 KiB/s), so its automated classification is **suspicious retained growth**, even though live heap/external slopes were flat/falling. Its young-space capacity was 128 MiB at load end and shrank to 1 MiB after idle GC. RSS fell further by the stopped checkpoint, but this earlier attempt did not include a one-second post-GC-idle observation; socket shutdown versus delayed reclamation cannot be separated there. The mixed window's automatic classification was **no concerning growth observed after warmup**. Human assessment remains conservative: recovery/plateau evidence, no confirmed application defect, unresolved residual residency. Heuristics are not leak verdicts.

## G. Controlled-arrival sweep

SLO configuration: schedule-relative p95 ≤50 ms; p99 ≤100 ms; failed/cancelled fraction ≤0.001; skipped arrivals ≤0.02; completed/offered count and achieved completion rate including drain both within 0.02 of offered traffic. These are synthetic targets. Every attempted outcome is included in service/schedule distributions; missed slots have no invented latency. Header latency is separately recorded. All stages here had zero HTTP 5xx, client timeouts and validation errors; enabled upstream-timeout counters were zero (unavailable when instrumentation was disabled).

Each row summarizes **both** repetitions. Completion rates show min/median/max; percentiles are medians of per-run approximate schedule-relative p50/p95/p99, not pooled quantiles. Miss counts are run one/run two. Each 3-second stage offered 300/3000/9000/15000 slots respectively.

| Profile / mode | Offered/s | Completed/s min / median / max | Schedule p50 / p95 / p99 ms | Misses per run | Both pass? |
|---|---:|---:|---:|---:|---|
| GET/direct | 100 | 99.5 / 99.7 / 99.8 | 8.59 / 16.75 / 16.88 | 1 / 0 | yes |
| GET/direct | 1000 | 995.5 / 997.3 / 999.1 | 7.81 / 14.53 / 15.99 | 1 / 0 | yes |
| GET/direct | 3000 | 2985.3 / 2987.2 / 2989.0 | 6.46 / 13.84 / 15.22 | 11 / 14 | yes |
| GET/direct | 5000 | 4962.4 / 4963.8 / 4965.2 | 6.46 / 16.75 / 20.26 | 75 / 33 | yes |
| GET/proxy | 100 | 99.8 / 99.9 / 100.0 | 8.20 / 15.22 / 16.67 | 0 / 0 | yes |
| GET/proxy | 1000 | 999.5 / 999.6 / 999.7 | 3.64 / 14.53 / 17.58 | 0 / 0 | yes |
| GET/proxy | 3000 | 2982.6 / 2988.2 / 2993.8 | 5.36 / 17.58 / 22.29 | 1 / 5 | yes |
| GET/proxy | 5000 | 4724.8 / 4805.8 / 4886.8 | 8.75 / 24.63 / 35.20 | 783 / 292 | no |
| GET/metrics | 100 | 99.7 / 99.9 / 100.0 | 8.20 / 15.93 / 16.50 | 0 / 0 | yes |
| GET/metrics | 1000 | 996.4 / 997.9 / 999.4 | 4.76 / 14.53 / 16.75 | 0 / 5 | yes |
| GET/metrics | 3000 | 2970.4 / 2983.6 / 2996.9 | 5.09 / 20.26 / 33.98 | 61 / 0 | yes |
| GET/metrics | 5000 | 4606.5 / 4629.2 / 4652.0 | 14.09 / 29.67 / 41.46 | 992 / 1166 | no |
| GET/health | 100 | 99.6 / 99.7 / 99.8 | 8.59 / 16.75 / 16.75 | 0 / 1 | yes |
| GET/health | 1000 | 997.1 / 998.3 / 999.5 | 4.67 / 15.22 / 17.58 | 3 / 0 | yes |
| GET/health | 3000 | 2950.1 / 2973.0 / 2996.0 | 6.16 / 28.08 / 38.72 | 131 / 0 | yes |
| GET/health | 5000 | 4541.7 / 4554.4 / 4567.2 | 16.75 / 31.15 / 48.00 | 1283 / 1339 | no |
| JSON/direct | 100 | 99.6 / 99.6 / 99.7 | 8.59 / 16.72 / 16.72 | 1 / 0 | yes |
| JSON/direct | 1000 | 995.5 / 995.7 / 995.9 | 7.46 / 14.53 / 15.99 | 8 / 11 | yes |
| JSON/direct | 3000 | 2987.6 / 2992.6 / 2997.6 | 6.46 / 14.53 / 17.58 | 5 / 1 | yes |
| JSON/direct | 5000 | 4975.8 / 4979.3 / 4982.9 | 6.16 / 17.58 / 21.28 | 8 / 37 | yes |
| JSON/proxy | 100 | 99.6 / 99.6 / 99.6 | 8.59 / 15.22 / 16.53 | 0 / 0 | yes |
| JSON/proxy | 1000 | 996.2 / 996.7 / 997.3 | 4.67 / 14.53 / 17.58 | 0 / 6 | yes |
| JSON/proxy | 3000 | 2936.7 / 2944.2 / 2951.6 | 6.84 / 36.06 / 47.78 | 180 / 95 | no |
| JSON/proxy | 5000 | 4607.6 / 4699.7 / 4791.8 | 10.45 / 28.58 / 39.67 | 599 / 1136 | no |
| JSON/metrics | 100 | 99.6 / 99.8 / 99.9 | 8.59 / 15.22 / 16.75 | 0 / 0 | yes |
| JSON/metrics | 1000 | 998.8 / 999.3 / 999.7 | 5.34 / 15.22 / 18.42 | 0 / 2 | yes |
| JSON/metrics | 3000 | 2960.6 / 2978.8 / 2997.0 | 4.63 / 19.34 / 33.98 | 2 / 57 | yes |
| JSON/metrics | 5000 | 4303.7 / 4448.3 / 4592.8 | 15.29 / 34.58 / 50.62 | 1186 / 2027 | no |
| JSON/health | 100 | 99.6 / 99.6 / 99.6 | 8.59 / 15.80 / 16.55 | 1 / 0 | yes |
| JSON/health | 1000 | 995.8 / 997.3 / 998.8 | 3.83 / 14.53 / 18.50 | 10 / 0 | yes |
| JSON/health | 3000 | 2589.2 / 2659.9 / 2730.5 | 7.85 / 63.59 / 71.46 | 753 / 1095 | no |
| JSON/health | 5000 | 4312.0 / 4455.2 / 4598.3 | 15.29 / 36.06 / 48.65 | 1188 / 1965 | no |

`health` means metrics plus the aggressive diagnostic health configuration (50 ms interval, 100 ms probe deadline, thresholds two), not production defaults. At 3000/sec, service p50/p95/p99 medians for GET proxy were **4.21/12.01/14.53 ms**, versus schedule-relative **5.36/17.58/22.29 ms**. JSON proxy service medians were **5.43/34.58/45.61 ms**, versus schedule-relative **6.84/36.06/47.78 ms**. Dispatch delay therefore matters; quoting only service latency would omit client delay.

## H. Highest tested SLO-passing rates

| Mode | GET offered/s | JSON offered/s |
|---|---:|---:|
| Direct | 5000 | 5000 |
| Proxy | 3000 | 1000 |
| Metrics | 3000 | 3000 |
| Metrics + health | 3000 | 1000 |

These require **both planned repetitions** to pass. They are not maximum sustainable capacities. JSON proxy at 3000 had one run slightly below the 98% achieved-rate requirement (2936.7 versus 2940/sec), while the other passed; JSON health at 3000 missed 8.37%/12.17% of slots and failed both. The apparent better JSON passing rate with metrics is not evidence that metrics improves forwarding; short windows, timing, process placement and variation matter. No statistically significant overhead claim or optimization is justified.

## I. Bottleneck assessment

The first generator check was itself client-limited by a harness policy: it dispatched only one due request per wakeup and discarded the others. At offered 100/sec, direct/proxy/metrics/health completed **64.8/80.1/77.3/74.2**, missing **35/19/22/25 slots** in one second. After bounded catch-up, the identical check completed **98.6/99.0/98.9/98.7**, missing **1/0/0/0**. No production optimization was involved. The scheduler retains each attempted request's real scheduled time and never queues more than the concurrency bound.

At offered 5000/sec all modes reached peak client concurrency **100**. Direct traffic passed, with client CPU approximately 49–70% of one core and client ELU 0.50–0.53. Proxied stages showed client CPU approximately 64–81%, backend CPU 56–70%, **proxy CPU 104–128%** and **proxy ELU 0.907–0.988**. Native/GC threads can make process CPU exceed one core. Sampled proxy peak RSS ranged approximately **219–230 MiB**, heap peaks **77–103 MiB** during these active windows; these capacity stages did not include memory idle-recovery analysis.

Most upper-stage missed slots were concurrency-cap misses, not overdue scheduling discards. For example GET proxy run one had **15 scheduling / 768 cap misses**; JSON metrics run two had **0 / 2027**. This is consistent with limited exchange-processing capacity/host contention under the chosen client cap, not solely generator CPU exhaustion. Direct passing rates provide a useful control. The measurements do not isolate proxy computation from local TCP/GC/runtime work or prove that increasing concurrency would meet the SLO. Client-limited classification identifies the supplied-arrival constraint; it does not automatically assign its root cause exclusively to the client.

## J. Defects, fixes and verification

**No production defect was confirmed.** `src/`, public declarations/API, routing, Round Robin, transport and health semantics remain unchanged. No runtime dependencies or speculative optimizations were added.

Harness changes covered by regression checks:

1. Bounded due-arrival catch-up replaces the measured one-dispatch-per-wakeup limitation, with explicit misses and service/schedule/header populations.
2. Health-enabled refusal validation allows legitimate 502→503 transitions without replay; accepted backend/root metrics are cross-checked.
3. Replaced backend workers are removed from the controller list, avoiding retention of exited process wrappers during repeated replacement; process hooks/child exits are checked. Termination has bounded force-kill/deadline fallback.
4. SLOs reject empty/partial populations, excessive misses/errors/latency and reduced achieved rate including drain. Incomplete repetition sets cannot claim a highest passing rate.
5. Histograms merge within fixed storage; V8 sampling, checkpoint serialization, listener/scope/queue cleanup and unsafe CLI bounds receive correctness coverage without exact-RSS assertions.

Local baseline: **167 tests passed**. Final local suite: **179 passed, zero failed/cancelled/skipped**, 35.04 seconds; all prior tests retained. `npm install`, strict typecheck, build, built-package consumer (ESM/declarations, HTTP/HTTPS, health, metrics, restart), package dry-run (28 files), and report validation passed. The 18 existing fault scenarios also passed as part of the final suite. Final short failure/mixed checks also passed with explicit health-state/metrics snapshots. The intentionally failed earlier investigation artifact remains marked failed; corrected relevant runs passed.

Cross-platform CI is configured for Windows/Ubuntu/macOS with Node **22.19.0 / 24.x**, full tests, package-consumer verification and tiny memory/capacity smoke checks. Actual remote results are pending the first push of this workflow; configuration alone is not runtime evidence. Local tests establish Windows/Node v24.14.0 only at this point.

## K. Unresolved questions and artifact policy

Ten-to-thirty-minute/hours-long soaks, native resident-page/allocator profiling, production network/TLS throughput, broader payload/concurrency/SLO sweeps and statistical significance were **not executed**. Opt-in modes support longer runs, but a configured duration is not a completed result. RSS above startup in the corrected mixed run remains incompletely attributed. No heap snapshot analysis was performed. Short flat heap/empty-scope observations do not prove leak freedom or production readiness.

Generated JSON/Markdown stays ignored and **local only** in `benchmarks/results/`: `memory-isolation.*`, `sustained-memory.*` (failed combined attempt), `mixed-sustained.*`, `legacy-memory.*`, `idle-recovery.*`, `capacity.*`, `capacity-upper.*`, plus small diagnostic/regression reports. Raw artifacts are not retrievable through GitHub. This sanitized report and the committed methodology/source are the reviewable evidence. No snapshots, caches or machine-specific dumps are committed.

## L. Next engineering priority

Profile CPU and allocation behavior under longer, repeated **3000–5000/sec controlled-arrival workloads**, concentrating on proxy event-loop saturation and SLO boundaries. Include resident-memory attribution when the elevated RSS plateau persists. Use those profiles to select one justified change, then rerun comparable workloads; do not add algorithms or optimize from these short ratios alone.
