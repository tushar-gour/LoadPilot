# Architecture and responsibility boundaries

- ServerPool coordinates backend registration and health leases. PoolScheduler owns selection traversal and cursor state and depends on the internal AlgorithmStrategy contract. Six individual classes implement the contract. Algorithms.ts is the built-in composition root. Each pool receives independent strategy state. Round Robin retains lazy traversal, Random retains duplicate slots, and other strategies deduplicate backend identities. Reservations capture one registration lifetime and are idempotent, independent of optional metrics.
- LoadPilot owns listener lifecycle and request admission; RequestRouter validates origin-form targets, resolves routes and delegates selected requests to the proxy through a narrow transport interface.
- HttpProxy owns agent generations and active exchange shutdown. ProxyExchange owns one streaming exchange, its deadline, event handlers and cleanup. Header filtering, redirect rewriting, error responses and agent helpers live in dedicated utility modules. Transport keeps existing cancellation and backpressure semantics.
- HealthMonitor manages health records, scheduling, eligibility and transitions. HttpHealthProbe owns one native probe and deadline; it reports outcomes without making health policy decisions.
- MetricsCollector coordinates aggregation. MetricGroup, PoolMetricGroup, BackendMetricGroup, LatencyHistogram and RequestScope each live in separate files. RequestScope depends on a narrow structural context, not the collector class.
- Pure functions, interfaces and data types need not be classes. The architecture test checks at most one production class per file, not the semantic correctness of SOLID.

## Limits

This is a structural refactor, not proof of universal SOLID compliance. Built-in strategy extension requires a class, enum entry and composition-root factory; a public custom strategy API is not exposed. Health transition policy and metrics snapshot composition remain candidates for further refinement. No runtime dependencies or public API changes intended. The npm release remains unchanged. Historical benchmark figures apply to recorded commits, not automatically to this refactor; require CI and fresh comparisons before claiming new throughput.
