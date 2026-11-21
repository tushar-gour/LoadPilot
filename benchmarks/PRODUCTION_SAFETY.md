# Milestone 6: production safety validation

Executed on 2026-11-21, Windows 10.0.26300, Node v24.14.0, Intel i7-12700H (20 logical CPUs), 23.6 GiB RAM. This is bounded correctness and performance evidence, not a production reliability certification.

## Source and verification

The clean baseline was `8309bab48a774af299591830a079d0f5dd8d9ab6`: 179 tests passed, zero failed/cancelled/skipped. Post-change measurements used the reviewed Milestone 6 working tree based on that commit; reports correctly record `workingTreeDirty: true`. The implementation commit is [`7b0ceb7fc8a4216ffbd9d856fbacc5d448fc374f`](https://github.com/tushar-gour/LoadPilot/commit/7b0ceb7fc8a4216ffbd9d856fbacc5d448fc374f), the parent of the later CI-evidence documentation commit. Raw synthetic logs/reports remain ignored in `benchmarks/results/`; this document records the reviewed results without secrets or heap snapshots.

- `npm install`: up to date; zero reported vulnerabilities.
- `npm run typecheck`: passed, including source, tests and benchmark tooling.
- `npm test`: **282 passed; 0 failed, cancelled or skipped**, 39.58 seconds. Existing 179 tests retained; 99 lifecycle/TLS/security tests and four process fault regressions added.
- Focused lifecycle/TLS/proxy-security run: **99/99 passed**, zero failures, cancellations or skips.
- `npm run build`: passed; generated ESM and declarations inspected.
- `npm run check:package`: passed using package exports/generated declarations, both HTTP/HTTPS listener modes, both HTTP/HTTPS upstreams, health, metrics, both stop modes and actual forwarding after restart.
- `npm pack --dry-run --cache .npm`: passed, 32 files; generated package excludes repository-only tests, fixtures, reports and secret material.
- `git diff --check`: passed.
- `npm run fault -- --label m6-faults`: **22/22 passed**, 33.01 seconds across scenarios, including graceful completion, deadline expiry, immediate escalation and backend death during drain.

The queue regression demonstrated that destroying a native Agent and closing downstream responses can leave queued ClientRequests awaiting native socket assignment. Shutdown now gates old Agent generations, lets native cleanup consume those entries using unconnected sockets without DNS/TCP/TLS, and waits for close notifications, including requests previously cancelled by clients. HTTP and HTTPS tests verify empty original queues and no replacement backend connections. Agent collections are inspected, never manually mutated.

## Performance smoke

Both before and after:

```sh
npm run bench -- --profiles get --concurrency 10 --duration 1 --warmup 0.25 --repetitions 3 --label m6-before
# Repeat after implementation with --label m6-after.
```

Separate generator/proxy/backend processes, loopback, dynamic ports, nine phases each, rotating mode order, native keep-alive, metrics disabled/enabled. Each phase had a one-second measured window after 250 ms warmup. All client validations passed; zero request errors. Percentiles use the existing approximate histogram. Values below are medians of three runs, not percentiles over combined samples.

| Mode | Before req/s (min–max) | After req/s (min–max) | Before median p95 / p99 ms | After median p95 / p99 ms |
|---|---:|---:|---:|---:|
| Direct | 5,410 (5,185–7,573) | 9,416 (9,160–9,633) | 3.645 / 4.851 | 1.870 / 2.489 |
| Proxy | 2,329 (2,314–2,791) | 4,476 (4,209–4,535) | 7.812 / 10.398 | 3.645 / 5.336 |
| Metrics | 1,985 (1,966–3,039) | 3,841 (3,817–3,940) | 8.594 / 12.582 | 4.410 / 5.870 |

The direct control improved approximately 74%, demonstrating substantial host/runtime variation. These runs support functional smoke validation and expose no measured slowdown, but **cannot establish a causal speedup, precise overhead change or absence of regression**. A controlled longer paired comparison is needed. Header validation and independent lifecycle tracking add work on each request; no hot-path rewrite or runtime dependency was introduced to chase these measurements. Native inbound TLS throughput was not benchmarked.

## Short sustained smoke

```sh
npm run soak -- --duration 12 --concurrency 10 --sample-ms 100 --gc --label m6-soak
```

Both modes passed: metrics disabled 12.224 seconds/18 batches; enabled 12.239 seconds/18 batches. The workload exercised GET/POST, reset failures, cancellations, streaming, health transitions, backend identity churn and restart. At final shutdown, both had zero active requests/upstream exchanges, inbound sockets, upstream busy/idle sockets and Agent pending entries. All sampled buffer counts were zero at the final checkpoint.

Explicit-GC initial/final live heap was 11.08/10.16 MiB disabled and 11.16/10.22 MiB enabled. RSS nevertheless grew 70.95→120.20 MiB and 70.30→122.59 MiB respectively, alongside larger V8 heap capacity. This does not establish a native leak or leak freedom; the run is too short and includes warmup, allocation, JIT and lifecycle churn. Long-duration RSS/native-memory attribution from Milestone 5 remains necessary.

## Hosted CI

[GitHub Actions run 44910844986](https://github.com/tushar-gour/LoadPilot/actions/runs/44910844986) completed successfully for the implementation commit above. Actual logs show:

| Hosted platform | Node | Tests passed | Failed / cancelled / skipped | Job result |
|---|---|---:|---|---|
| Windows Server 2025 (10.0.26100) | 22.19.0 | 282 | 0 / 0 / 0 | PASS |
| Windows Server 2025 (10.0.26100) | 24.22.3 | 282 | 0 / 0 / 0 | PASS |
| Ubuntu 26.04.1 | 22.19.0 | 282 | 0 / 0 / 0 | PASS |
| Ubuntu 26.04.1 | 24.22.3 | 282 | 0 / 0 / 0 | PASS |
| macOS 26.7.2 | 22.19.0 | 282 | 0 / 0 / 0 | PASS |
| macOS 26.7.2 | 24.22.3 | 282 | 0 / 0 / 0 | PASS |

Every job also passed clean dependency installation, typecheck, build, built ESM/declaration consumer with HTTP/HTTPS listeners and upstreams, dry-run packing, and bounded memory/capacity harness smoke. All six completed before this evidence was recorded. The follow-up changes only this Markdown report; source, tests, configuration and harness remain identical to the tested implementation commit. The existing workflow ignores Markdown-only pushes, so it does not rerun for this evidence update.

## Remaining operational limits

Graceful shutdown is opt-in; `stop()` still cancels immediately. A grace deadline cannot preempt blocking JavaScript, guarantee backend availability, or prove remote application receipt. Native close cleanup adds at most a 1,000 ms notification backstop before rejection. A shared pool intentionally retains shared cursor/backend/health semantics. Explicit trusted ingress must sanitize the metadata it supplies. No retries, HTTP/2, WebSocket/CONNECT proxying, certificate rotation, mTLS configuration, concurrency limits, WAF, distributed coordination or telemetry exporter is added. See [README production safety](../README.md#production-safety--lifecycle) for the public contract and security model.
