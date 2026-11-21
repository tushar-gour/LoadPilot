# LoadPilot

LoadPilot is a lightweight TypeScript library for self-hosted HTTP load balancing in Node.js. Register backend servers in route-specific pools, start a listener, and receive real backend responses through a streaming reverse proxy. No runtime dependencies are required.

## Architecture

```text
Client → LoadPilot listener → RouteMatcher → ServerPool.getNextServer()
       → HttpProxy → selected HTTP/HTTPS backend
Client ← streamed status, headers and body ← HttpProxy ← backend
```

- `LoadPilot` owns one HTTP or HTTPS listener, its sockets and admitted exchanges, an optional public base route and its pool registry, and exposes optional instance metrics.
- `RouteMatcher` selects the longest matching pool route at complete path-segment boundaries. It has no networking or scheduling responsibilities.
- `ServerPool` owns its backend list, Round Robin cursor and optional health monitor. Its default algorithm is `Algorithm.ROUND_ROBIN`.
- `Server` represents a validated HTTP(S) destination, optionally including a path prefix. Credentials, query strings and fragments are rejected in backend configuration.
- The internal `HttpProxy` manages transport, header filtering, redirects, streaming, deadlines and cancellation. It does not select backends.
- An internal per-instance `MetricsCollector` observes the existing lifecycle through scoped callbacks. It makes no routing, selection or health decisions and has no global registry.

Each pool starts with its first eligible backend and rotates through registration order. Health checks are disabled by default, preserving selection of all registered backends. An unrelated pool's requests do not advance its cursor. Different LoadPilot objects have independent listeners and registries. **Use distinct ServerPool objects for independent scheduling and health state**: intentionally sharing a pool object also shares its cursor, backend list and single health monitor.

## Setup

Node.js 22.19 or newer is required. In a consuming application, install the package when available from your registry:

```sh
npm install loadpilot
```

For local development, clone this repository, run `npm install` and `npm run build`, then install the repository path in your application with `npm install /path/to/LoadPilot`. The package exposes ESM JavaScript and TypeScript declarations through `loadpilot`.

## Example: with a public base route

Start your backend applications on ports 3001, 3002 and 4001, then run:

```ts
import { LoadPilot, ServerPool, Server, Algorithm } from "loadpilot";

const authPool = new ServerPool({
  route: "/auth",
  servers: [new Server("http://localhost:3001"), new Server("http://localhost:3002")],
  algorithm: Algorithm.ROUND_ROBIN,
});
const cartPool = new ServerPool({
  route: "/cart",
  servers: [new Server("http://localhost:4001/internal")],
});
const pilot = new LoadPilot({
  name: "MainBalancer",
  port: 8080,
  route: "/gateway",
  pools: [authPool, cartPool],
  upstreamTimeoutMs: 30_000,
});

await pilot.start();
// POST /gateway/auth/login?remember=true → :3001/auth/login?remember=true
// The next auth request goes to :3002; cart requests have their own cursor.
// GET /gateway/cart/items → :4001/internal/cart/items

pilot.addPool(new ServerPool({
  route: "/payment",
  servers: [new Server("http://localhost:5001")],
}));
authPool.add(new Server("http://localhost:3003"));

// When your application is ready to shut down:
// await pilot.stop();
```

## Example: without a base route

Start backend applications on ports 3001 and 3002, then run:

```ts
import { LoadPilot, ServerPool, Server } from "loadpilot";

const pilot = new LoadPilot({
  name: "DirectBalancer",
  port: 8081,
  pools: [new ServerPool({
    route: "/auth",
    servers: [new Server("http://localhost:3001"), new Server("http://localhost:3002")],
  })],
});

await pilot.start();
// POST /auth/login?remember=true → :3001/auth/login?remember=true
// The next request goes to :3002.

// Later: await pilot.stop();
```

`route` defaults to `/`. `name` and `port` are required; port `0` requests an automatically allocated port, available through the read-only `pilot.port` getter after `start()`. That getter returns `null` while no listener is bound; `pilot.options.port` retains the configured value. Configuration is frozen after construction. Duplicate normalized pool routes are rejected; pools and backends can be added while running.

## Routing and upstream paths

Only the LoadPilot base route is removed. **The pool route remains in the upstream path.** The backend's configured path prefix is prepended at one slash boundary.

| Base route | Incoming target | Backend | Upstream target |
|---|---|---|---|
| `/gateway` | `/gateway/auth/login?remember=true` | `http://localhost:3001` | `/auth/login?remember=true` |
| omitted (`/`) | `/auth/login?remember=true` | `http://localhost:3001` | `/auth/login?remember=true` |
| `/api/v1` | `/api/v1/auth/login` | `http://localhost:3001` | `/auth/login` |
| `/gateway` | `/gateway/auth/login?remember=true` | `http://localhost:3001/internal` | `/internal/auth/login?remember=true` |
| `/gateway` | `/gateway?x=1` | `http://localhost:3001/internal` | `/internal/?x=1` |

Routes require an initial slash; configuration trailing slashes are removed. `/auth` matches `/auth` and `/auth/login`, but not `/authentication`. `/auth/admin` wins over `/auth` when both match. A pool registered at `/` is a fallback for any path **inside the LoadPilot base route**, including an exact base-route request. An empty specific pool returns 503 rather than falling back to a less specific pool.

Queries are excluded from matching and forwarded byte-for-byte. Encoded path segments, incoming trailing slashes and literal dot segments are forwarded without URL normalization or decoding; backend applications may apply their own normalization. Backend prefix trailing slashes are collapsed only at the joining boundary. Destinations always come from registered Servers; incoming `Host`, absolute URLs or path text cannot select another upstream hostname.

The listener accepts origin-form targets such as `/auth?x=1`. Absolute-form, network-path (`//host/path`), asterisk-form, malformed percent escapes, literal fragments, backslashes and whitespace/control characters are rejected with 400 when they reach the handler. Node's HTTP parser may reject other malformed messages before routing.

## Forwarding, headers and redirects

GET, POST, PUT, PATCH, DELETE, HEAD and OPTIONS use native backpressure-aware streams for both upload and response. Backend statuses, content types, application headers, authorization, cookies, content encodings and payload bytes are preserved. Payloads are not buffered or decompressed. HTTPS backends use Node's normal certificate verification and trust configuration; LoadPilot does not disable TLS validation.

Hop-by-hop headers and every header nominated by `Connection` are removed in each direction. The upstream `Host` is set to the selected backend's host and port. Valid `Content-Length` is retained; chunk framing is regenerated when necessary, including chunked GET bodies. Node may generate new connection/framing headers for each connection. Separate `Set-Cookie` headers stay separate. Request `Expect: 100-continue` is handled by the listener and is not forwarded upstream; other informational responses and HTTP trailers are not relayed.

Incoming `Forwarded` and `X-Forwarded-*` values are stripped before rebuilding validated metadata. By default, `X-Forwarded-For` contains the socket peer, `X-Forwarded-Proto` reflects the actual HTTP/HTTPS connection, and `X-Forwarded-Host` contains a syntactically valid observed Host. Host remains client-controlled metadata. Explicit trusted-proxy handling is described below.

`Location` values resolving to the selected backend's exact origin and configured path prefix are mapped back to a public origin-relative path, restoring the LoadPilot base route. Absolute, network-path, root-relative and relative redirects use the same mapping. The incoming Host is never used to construct redirects. Unrelated external destinations are preserved. Invalid redirects, same-backend destinations outside the configured prefix and mappings that would become network-path redirects have their `Location` removed because no safe public mapping exists.

Cookie `Path`/`Domain`, HTML links, refresh headers and application-specific absolute URLs are not rewritten. Applications using those features must be configured for their public URL/prefix. This is not a fully transparent application gateway.

## Failures, timeout and lifecycle

| Situation | Behavior |
|---|---|
| No matching pool | 404 Not Found |
| Matching pool has no eligible servers (empty or all confirmed unhealthy) | 503 Service Unavailable |
| Malformed target reaching the handler | 400 Bad Request |
| DNS, connect, TLS, invalid upstream response or premature upstream close before headers | 502 Bad Gateway |
| Deadline expires before headers | 504 Gateway Timeout |
| Backend returns an application 401, 404 or 500 | Forward its status, headers and body |
| Failure/deadline after headers have been sent | Terminate the stream; do not send a second HTTP response |
| Unexpected orchestration failure | Generic 500 Internal Server Error |

`upstreamTimeoutMs` defaults to **30,000 ms** and accepts integers from 1 through 2,147,483,647. It is a **total exchange deadline**, starting at upstream dispatch and ending when the downstream response finishes. It includes DNS, TCP/TLS connection, request upload, upstream processing and response delivery, including client backpressure. It is not an inactivity timeout; a continuously streaming response can still reach the deadline. Increase it for long uploads or downloads. Node's separate inbound HTTP parser timeouts also apply before/during request reception.

There are no automatic retries, including for POST/payment operations. A failed attempt advances that pool's cursor once; only the next client request selects the next backend. Client upload/response disconnections cancel upstream work. Each instance owns its keep-alive upstream agents.

`start()` rejects repeated/concurrent starts and bind failures such as `EADDRINUSE`. A failed bind can be retried. `stop()` preserves immediate cancellation by default; explicit graceful shutdown allows admitted work to finish. Concurrent stop callers share the pending operation. A stopped instance can be started again.

## Production Safety & Lifecycle

### Bind address and HTTPS

`host` optionally selects an IPv4 address, IPv6 address or hostname accepted by the platform. It is validated without rewriting the configured value. Omit it to retain Node's default all-interface binding, which can expose the listener beyond loopback. Use `host: "127.0.0.1"` for local-only HTTP; use an appropriate interface and firewall policy for deployments. Port `0` remains supported.

This complete application uses two backends, optional HTTPS termination, and graceful signal handling:

```ts
import { readFile } from "node:fs/promises";
import { LoadPilot, ServerPool, Server } from "loadpilot";

const useHttps = process.env.LOADPILOT_HTTPS === "true";
const pilot = new LoadPilot({
  name: "Gateway",
  host: "127.0.0.1",
  port: 8080,
  tls: useHttps ? {
    key: await readFile("/run/secrets/gateway-key.pem"),
    cert: await readFile("/run/secrets/gateway-cert.pem"),
    minVersion: "TLSv1.2",
  } : undefined,
  metrics: { enabled: true },
  pools: [new ServerPool({
    route: "/",
    servers: [new Server("http://127.0.0.1:3001"), new Server("http://127.0.0.1:3002")],
    healthCheck: { enabled: true },
  })],
});

async function terminate() {
  try { await pilot.stop({ mode: "graceful", timeoutMs: 30_000 }); }
  catch { process.exitCode = 1; }
}
try {
  await pilot.start();
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
} catch (error) {
  await pilot.stop();
  throw error;
}
```

Omitting `tls` creates the existing native HTTP listener. Supplying `tls` creates a native HTTPS listener and requires a valid, matching `key` and `cert` in Node's PEM/Buffer/key forms. Optional `passphrase`, `minVersion` and `maxVersion` are supported. Protocol bounds accept only TLSv1.2 or TLSv1.3, with a minimum floor of TLSv1.2 and the runtime's stronger default when applicable. Empty inputs, mismatched keys, inverted bounds and unsupported TLS fields fail clearly. Native TLS configuration errors are sanitized. Key/certificate/passphrase inputs are omitted from `pilot.options`, status, metrics and logs; they necessarily remain in the native TLS context. Protect the caller's original configuration and secret files.

Inbound termination is independent of outbound HTTPS. Upstream requests and probes retain normal certificate and hostname verification. No insecure verification override is added. HTTP/2, mutual TLS configuration, SNI routing, certificate provisioning and certificate hot reload are unsupported.

### Shutdown contract

```ts
await pilot.stop();                                // Existing immediate behavior
await pilot.stop({ mode: "immediate" });           // Explicit immediate cancellation
await pilot.stop({ mode: "graceful" });            // Finite default: 30,000 ms
await pilot.stop({ mode: "graceful", timeoutMs: 5000 });
```

The lifecycle is `stopped → starting → started → draining → stopping → stopped`; immediate stop moves directly from started to stopping. Calling graceful stop synchronously closes admission before its Promise is returned and promptly closes the native listener to new TCP connections. Requests already admitted may continue uploading, waiting on a backend or streaming to a slow client. A new HTTP request arriving on an existing connection is rejected before matching or selection with generic 503 and `Connection: close`. An idle connection can simply close without another response. Requests admitted before the drain boundary retain their selected backend; nothing is replayed.

Graceful `timeoutMs` must be an integer from 1 to 300,000. A later graceful call shares the original Promise and never extends its deadline. `stop()` or explicit immediate mode escalates a pending drain immediately. Invalid options reject even on a stopped instance. A valid stop on an already stopped instance is harmless. Starting while starting/draining/stopping, stopping during startup, and adding pools during those transitions reject clearly.

The existing upstream total-exchange deadline continues unchanged during drain. Whichever failure, client disconnect, successful finish or shutdown cancellation occurs first determines the terminal outcome. At grace expiry, remaining exchanges are cancelled and inbound sockets (including incomplete headers and TLS handshakes) are destroyed. Responses already started are terminated without a second status line. Immediate mode uses the same forced cleanup without a drain period.

Idle upstream connections close when draining starts. Active upstream agents remain available until work settles or is cancelled. Shutdown waits for tracked downstream responses, raw listener sockets, upstream exchanges and native request/socket close notifications; it resolves with active gauges and queues cleared. Native upstream close notification cleanup has an additional bounded 1,000 ms backstop: if it cannot settle, stop rejects and makes a fresh agent generation available for restart. Timers are cleared and unreferenced. Deadlines depend on the event loop running and cannot preempt blocking JavaScript or establish that a remote client processed every byte.

Entering drain releases this listener's health-monitor ownership once. If it was the last owner, pending probes and timers are cancelled without false failures or state resets; another owner of a shared pool keeps monitoring. A new monitor lifetime on restart returns health to UNKNOWN using the existing semantics. Backend additions/removals still affect future selection only; removing a backend leaves admitted streams intact. Pools can be added while started or stopped, but not while draining. Shared pools intentionally share their backend list, cursor and health state.

With metrics enabled, ordinary drain completions remain completed requests. Forced cancellations increment `shutdownCancelled`; client disconnects remain `clientCancelled`, and upstream failures/timeouts keep their existing classifications. Completed drain rejections increment root-only `requests.drainingRejections`, completed requests and local 5xx responses, without any pool/backend attribution. Incomplete rejection responses follow normal cancellation accounting. Lifetime totals persist across restart.

`pilot.getStatus()` returns a frozen local snapshot of `state`, `listening`, bound `address`, `port`, `protocol`, `activeRequests` and `connections`. These counts work with metrics disabled. `activeRequests` counts outstanding handler responses; `connections` counts owned raw TCP connections, including TLS handshakes. Address/port become null after native listener closure, potentially before active draining work has settled. Status is for trusted application code; there is no automatic HTTP diagnostic endpoint.

### Explicit proxy trust

No peer is trusted by default. Configure only the actual ingress network, for example:

```ts
const pilot = new LoadPilot({
  name: "BehindIngress", host: "127.0.0.1", port: 8080,
  trustedProxies: ["127.0.0.1/32", "10.42.0.0/24", "::1/128"],
  pools: [new ServerPool({ route: "/", servers: [new Server("http://127.0.0.1:3001")] })],
});
```

Trust configuration accepts at most 256 literal IPv4/IPv6 addresses or CIDRs, handles IPv4-mapped IPv6 peers, and is copied/frozen. Hostnames, wildcard/trust-all shortcuts, zone identifiers, malformed ranges and universal `/0` ranges are rejected. The actual socket peer must match before any supplied forwarding metadata can be accepted.

For a trusted peer, a valid `X-Forwarded-For` chain is walked from right to left through trusted hops, stopping at the first untrusted address. Only that effective address is emitted, not the original chain or its untrusted leftmost claims. Chains are limited to 1,024 characters and 16 literal IP addresses; ports, empty/malformed elements and zone identifiers discard the entire chain and fall back to the socket peer. `X-Forwarded-Proto` accepts exactly one lowercase `http` or `https`. `X-Forwarded-Host` accepts one authority of at most 260 characters: a valid ASCII hostname/IPv4 or bracketed IPv6, optionally followed by a port from 1 to 65535. URLs, credentials, paths, whitespace, control characters and comma-separated hosts are discarded.

Invalid protocol/host fields fall back independently to the actual connection scheme and syntactically valid observed Host. RFC `Forwarded` is always ignored, as are all other supplied `X-Forwarded-*` fields. Trusted ingress must overwrite protocol/host metadata and correctly append its observed peer to XFF; trusting an ingress that relays arbitrary client values is unsafe. Syntactically valid Host metadata still requires an application allowlist when used for links or security decisions. Registered backend configuration alone controls upstream destinations, and rewritten public redirects remain origin-relative.

### Native connection limits

LoadPilot retains native defaults. On the tested Node 22/24 lines, [HTTP defaults](https://nodejs.org/docs/latest-v22.x/api/http.html) are: request reception timeout 300,000 ms, header timeout 60,000 ms (bounded by request timeout), keep-alive idle timeout 5,000 ms plus a 1,000 ms socket timeout buffer, general socket timeout 0, and maximum request header size 16 KiB unless overridden by Node runtime flags. Native HTTPS additionally has a 120,000 ms TLS handshake timeout; see [Node TLS server options](https://nodejs.org/docs/latest-v22.x/api/tls.html#tlscreateserveroptions-secureconnectionlistener). Later runtimes may change defaults. Timeout enforcement includes Node's checking cadence. These are separate from upstream and probe total deadlines. Grace expiry also closes stalled uploads, incomplete inbound requests and pending handshakes. This milestone adds no public parser-timeout/body-size, concurrency/admission-limit, WAF or DDoS policy API; apply deployment limits appropriate to your network.

## Optional backend health checks

Configure monitoring on each pool; constructing a pool does not start background work. The following example checks both backends independently:

```ts
import { LoadPilot, ServerPool, Server, HealthState } from "loadpilot";

const authPool = new ServerPool({
  route: "/auth",
  servers: [
    new Server("http://localhost:3001/internal"),
    new Server("https://backend.example/internal"),
  ],
  healthCheck: {
    enabled: true,
    path: "/health",
    intervalMs: 5000,
    timeoutMs: 1000,
    unhealthyThreshold: 2,
    healthyThreshold: 2,
  },
});
const pilot = new LoadPilot({ name: "HealthyGateway", port: 8080, route: "/gateway", pools: [authPool] });
await pilot.start();

// Probes: GET http://localhost:3001/internal/health (and the HTTPS equivalent).
// Requests: /gateway/auth/login → selected backend /internal/auth/login.
for (const status of authPool.getHealthStatus()) {
  if (status.state === HealthState.UNHEALTHY) {
    // Local diagnostics; the backend keeps receiving recovery probes.
  }
}
// Later: await pilot.stop();
```

Every health option is optional. **`enabled` defaults to false**, even when other health options are supplied. Defaults are `/health`, 5000 ms between probes, a 1000 ms total probe deadline, two failures to exclude a backend, and two successes to recover it. Configuration is validated and frozen. Timer values must be integers from 1 through 2,147,483,647; thresholds must be positive safe integers; `enabled` must be boolean.

`path` must be a pathname beginning with `/`, without query strings, fragments, backslashes, duplicate slashes, whitespace/control characters, invalid percent escapes or literal/percent-encoded dot segments. Its trailing slash and valid escapes are preserved. It is appended to the backend's configured pathname prefix using the same joining rule as application traffic: backend `/internal` plus `/health` becomes `/internal/health`. Neither the pool route nor the LoadPilot base route is included in the probe. Origin-root overrides for a backend with a pathname prefix are not supported.

### States, selection and recovery

- **UNKNOWN**: a newly registered backend, or a backend at a fresh monitoring start, has no confirmed health result. It remains selectable. An initial failure below the failure threshold also leaves it UNKNOWN.
- **HEALTHY**: the first successful initial probe confirms health immediately. Later failures exclude it only when the consecutive failure threshold is reached.
- **UNHEALTHY**: the configured number of consecutive failed probes has been reached. New selections skip it. It continues receiving probes and becomes HEALTHY after `healthyThreshold` consecutive successes.

A success clears the failure counter; a failure clears the success counter. Diagnostic counters saturate at their respective thresholds. An interrupted recovery restarts the success streak. `pool.getHealthStatus()` returns frozen snapshots containing the Server object, state and both counters; disabled monitoring reports UNKNOWN rather than inventing confirmed health. There is no public HTTP diagnostics endpoint.

The existing algorithm dispatcher advances over the original registration order, skipping confirmed unhealthy entries with a bounded scan. Recovery restores a backend to that order without resetting the pool's selection cursor. Probes never advance the cursor. If all entries are confirmed unhealthy, `getNextServer()` returns `null` and matching client requests receive the existing generic **503 Service Unavailable**, without forwarding or falling back to a less specific pool.

Health changes affect **new selections only**. They do not cancel an application request already using that backend. Checks reduce failed selections but cannot guarantee that an upstream will remain available during a request, or that every application endpoint is healthy.

### Probe transport and timing

Monitoring starts after the listener binds. An initial probe is scheduled promptly without waiting for it in `start()`. There is at most one active probe per Server object in a pool. Each next probe is scheduled `intervalMs` after the previous result, including after timeouts; there is no overlapping interval callback. Separate Server objects, even with identical URLs, have separate health records; separate pools monitor independently.

Probes use native HTTP/HTTPS GET requests with only transport headers, no client cookies, authorization or forwarded headers, and normal TLS certificate verification. A **completed 2xx response** is successful. Non-2xx statuses, redirects, DNS/network/TLS failures, truncated responses and timeouts are failures. Redirects are never followed. Response bodies are discarded incrementally, with no accumulation; even a stalled 2xx body must complete before the probe deadline.

The probe `timeoutMs` bounds the entire DNS/connect/TLS/request/response operation and destroys its socket when reached. It is separate from `LoadPilot.upstreamTimeoutMs`; changing either deadline does not change the other. Probe timers and sockets are unreferenced so they do not keep an otherwise idle process alive.

Passive application transport signals such as connection refusal/reset, DNS failure and upstream stream failure request a prompt active confirmation probe. Signals coalesce while a probe is pending. Only completed active probe outcomes affect thresholds. Valid application HTTP 4xx/5xx responses and client disconnects do not count as health failures. The proxy's total exchange deadline is not classified as proof of backend failure because it also includes upload and client backpressure. **No request is replayed or retried.**

### Dynamic backends and monitor lifecycle

`pilot.addPool()` starts monitoring when the listener is already running. `pool.add(server)` creates an UNKNOWN health record and schedules its initial probe when monitoring is active. Records use Server object identity within the pool. Repeated registration of the same object shares one record/probe.

`pool.remove(server)` removes the first registration of that exact Server object and returns whether it existed. Once its last registration is removed, pending probes/timers are cancelled and the health record is removed. Late results cannot recreate the record or affect a subsequently re-added backend. Removing a backend does not cancel application requests already using it.

Repeated initialization does not create duplicate monitors. Shared pool objects retain one monitor while any owning LoadPilot listener is running; stopping one listener releases only its ownership. Stopping the final owner cancels pending probes and timers without treating cancellation as failure. Last-known diagnostics remain visible while stopped. A fresh start resets states to UNKNOWN and consecutive streak counters to zero, then schedules new probes; adding another owner to an already running monitor does not reset it. Observability totals described below are retained across restarts. Monitoring lifecycle and passive-signal methods marked `@internal` are managed by LoadPilot and need no consumer calls.

Health monitoring has no configurable probe headers/authentication, custom method/status policy, body assertions, redirect following, jitter, global probe concurrency cap, distributed coordination or automatic failover replay. Use a dedicated bounded health endpoint appropriate for the application.

## Observability & Metrics

Metrics are **disabled by default** and require no monitoring service, runtime dependency or HTTP endpoint. Enable them on each LoadPilot instance:

```ts
import { LoadPilot, ServerPool, Server, type LoadPilotMetrics } from "loadpilot";

const authPool = new ServerPool({
  route: "/auth",
  servers: [new Server("http://localhost:3001"), new Server("http://localhost:3002")],
  healthCheck: { enabled: true },
});
const pilot = new LoadPilot({
  name: "Gateway",
  port: 8080,
  pools: [authPool],
  metrics: { enabled: true },
});
await pilot.start();

const snapshot: LoadPilotMetrics = pilot.getMetrics();
console.log(snapshot.requests.total);
console.log(snapshot.requests.active);
console.log(snapshot.latency.p95Ms);
for (const pool of snapshot.pools) {
  console.log(pool.route, pool.requests.noEligibleBackend, pool.eligibility.eligible);
  for (const backend of pool.backends) {
    console.log(backend.id, backend.requests.total, backend.health?.state);
  }
}
// Later: await pilot.stop();
```

`metrics` accepts an optional boolean `enabled` field, defaulting to false. Invalid objects or non-boolean values are rejected. The resolved option is frozen. `getMetrics()` always returns a deeply frozen snapshot, including before startup. Empty counters and latency values are zero; timestamps are null before an observed event. Older snapshots never change and cannot mutate future measurements.

### Request accounting and status origin

The instance, each configured pool and each selected backend expose the same request/status/latency structure. Instance totals count incoming requests that reach the HTTP request handler, including malformed targets handled there. HTTP parser rejections and CONNECT/Upgrade rejections occur outside that handler and are excluded. Backend health probes are never client requests.

| Field | Meaning |
|---|---|
| `requests.total` | Handler entries; pool entries only after matching; backend entries only after selection |
| `requests.active` | Accepted exchanges that have not reached their terminal outcome; **not TCP connections** |
| `requests.completed` | Complete application responses, including backend 4xx/5xx, and completed local 400/404/503 rejections |
| `requests.failed` | Forwarding connection/protocol/stream failures, upstream deadlines, or internal orchestration failures |
| `requests.cancelled` | Exchanges cancelled by a client or shutdown, with separate `clientCancelled` and `shutdownCancelled` counters |
| `requests.routeNotFound`, `noEligibleBackend`, `invalidTarget` | Terminal local rejection reasons, distinct from backend HTTP statuses |
| `requests.drainingRejections` | Completed local 503 after admission closes; root only, without pool/backend selection |
| `requests.upstreamFailures`, `upstreamTimeouts`, `internalErrors` | Terminal failure reasons; backend HTTP 500 is not an upstream failure |
| `responses.completed` | Fully written downstream responses, including fully written proxy-generated 502/504 responses |
| `responses.incomplete` | Exchanges ending without a complete downstream response, including cancellation before headers |

Each accepted request has one guarded accounting scope. Exactly one terminal category is recorded and active gauges decrement once, even when finish/close/error/aborted events overlap. In ordinary operation:

```text
requests.total = requests.active + requests.completed + requests.failed + requests.cancelled
```

The first observed forwarding failure or cancellation determines its reason. A later socket error caused by timeout, disconnect or shutdown does not become another failure. Shutdown finalizes already-destroyed responses even if Node defers their `close` events past server closure. Instrumentation callback failures are isolated from transport and reflected in `instrumentationErrors`; counters may be partial when instrumentation itself fails.

Final status families are `responses.status1xx` through `status5xx`, with separate `responses.backend` and `responses.loadPilot` breakdowns. Statuses are counted **only for completed downstream responses**. A backend 500 increments the backend 5xx family and `requests.completed`; a successfully written local 502 increments the LoadPilot 5xx family and `requests.failed`. An upstream stream failure after sending 200 headers increments `responses.incomplete`, not the completed 2xx family and not a fabricated 502 response. Informational responses are not relayed/observed by this instrumentation, including Node's automatic 100 Continue; `status1xx` remains zero. Nonstandard statuses outside 100–599 still count as completed responses without a standard family.

Node's response `finish` means bytes have been handed to the network stack; it does not prove that a remote client processed every byte. Active exchanges remain active throughout upload and downstream streaming/backpressure.

### Latency distributions

All durations use monotonic `performance.now()` and milliseconds:

- `latency` measures handler entry through downstream finish/close, including upload, routing, upstream work, response streaming, errors and cancellations. Pool/backend summaries use that same end-to-end exchange duration.
- `upstreamHeadersLatency` measures upstream dispatch through receipt of response headers, including DNS/connect/TLS/upload and upstream work. It is **not pure backend processing time**. It includes observed responses that later truncate; failures before headers have no headers-latency sample.
- Both summaries expose `count`, `totalMs`, `averageMs`, `minMs`, `maxMs`, `p50Ms`, `p95Ms`, `p99Ms`, and fixed histogram `buckets`.

Histograms use these inclusive upper bounds in milliseconds:

```text
1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000,
10000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000
```

There are always **21 counters**, including one overflow bucket represented by `upperBoundMs: null`. Updates use a bounded binary search. Percentiles use the bucket containing the nearest rank `ceil(p × count)`, reported as that bucket's upper bound clamped to the actual observed minimum/maximum. Overflow percentiles use the observed maximum. These are deterministic **upper-bound approximations**, not exact quantiles; long-tail precision is limited by the bucket spacing. Actual average/minimum/maximum do not use bucket estimates. Empty summaries return zero; extreme duration inputs are capped at `Number.MAX_SAFE_INTEGER` milliseconds.

### Pool/backend identities and retention

Pools use normalized configured routes, never arbitrary client paths, queries or Host headers. Overlapping routes and `/` fallback attribution follow the actual RouteMatcher result. Requests rejected before matching have no pool attribution, and requests rejected before backend selection have no backend attribution.

Each backend row has a per-pool numeric `id`, configured `baseUrl`, `registered` flag and `registrations` count. Distinct Server objects with identical URLs have different IDs. Repeated registration of the same Server object shares a row/health record; `registrations` reports its selection slots. IDs are stable for one continuous registration lifetime and are interpreted together with the pool route.

`pool.eligibility` reports `registered` distinct Server objects, total registration slots, UNKNOWN/HEALTHY/UNHEALTHY counts, and selectable (`eligible`) distinct objects. UNKNOWN remains eligible; disabled health monitoring reports UNKNOWN rather than confirmed HEALTHY.

Removing the last registration removes an idle backend row immediately. A removed backend with selected requests still in flight appears with `registered: false`, zero registrations and null health until those requests settle; then its row disappears. Re-adding the same Server object receives a new ID and fresh backend counters, even while old requests are finishing. Those old requests settle against the old identity. Pool/instance request aggregates retain their lifetime totals. Current identities use weak-key bookkeeping; only active exchanges retain removed identities. There is no unlimited historical backend list.

### Health metrics and shared pools

`pool.health` exposes actual shared-monitor totals: `successfulProbes`, `failedProbes`, `timeoutProbes` (a subset of failures), `healthyTransitions`, `unhealthyTransitions`, `unknownTransitions`, `lastProbeAt` and `lastStateChangeAt`. `enabled` describes active-health configuration; `collecting` indicates whether health statistics have been opted into. Each registered `backend.health` adds its actual `HealthState` and counters for that registration lifetime. Timestamps are Unix epoch milliseconds, separate from monotonic duration measurements.

Only real probe outcomes are counted. Cancellation and stale results after removal/shutdown have no probe outcome. State-transition counters increment only when the actual state changes: repeated healthy results and failures below the threshold do not invent transitions. A fresh monitor start returning a previously known state to UNKNOWN is an UNKNOWN transition. Consecutive health streaks still follow the existing threshold rules.

Health statistics collection is an idempotent, pool-lifetime opt-in when the first metrics-enabled LoadPilot registers the pool. It does not start probes, add subscriptions or change monitoring ownership. Events before that opt-in are not reconstructed. Collection remains enabled for that pool thereafter, including when another non-metrics owner keeps monitoring alive. Pool health totals retain outcomes from removed backends without retaining their objects; removing/re-adding resets only that backend's health statistics.

**Request counters belong to the receiving LoadPilot. Health counters belong to the actual pool monitor.** Two instances sharing a pool have independent request counters and the same read-only health totals, not doubled probes. Do not sum those duplicate shared-monitor views as independent health traffic. A metrics-disabled instance still exposes current topology/health views if another owner enabled collection, but its own request counters stay zero.

### Lifetime, overhead and exposure

Request counters live for the LoadPilot object's lifetime. `stop()` retains them and returns with active gauges zero; restarting resumes accumulation. `uptimeMs` is cumulative bound-listener running time and excludes downtime. There is no reset API, rolling time window or percentile-history retention. Health totals follow the separate pool/registration lifetimes above.

When disabled, requests allocate no metrics scope/events and capture no metrics timestamps. Enabled collection uses counters and fixed histograms; snapshots are materialized only on `getMetrics()`. Memory scales with configured pools/backends plus active removed-backend exchanges, not request count or unique URLs. No metrics polling timers, blocking I/O, disk writes, network collection, automatic request logging or additional dependencies are introduced. Snapshot generation scans current configuration/active retired identities and fixed-size buckets. No measured overhead or throughput guarantee is claimed.

Snapshots include configured names, routes and backend addresses for **trusted operational code**. They do not store client headers, authorization, cookies, bodies, query strings, arbitrary client paths or incoming Host values. Do not publish raw snapshots to untrusted clients. LoadPilot does not expose `/metrics` automatically.

Prometheus/OpenTelemetry exporters, tracing, historical TCP connection metrics, persistence, dashboards, distributed aggregation and alerting are not implemented. `getStatus().connections` reports a current local TCP count separately from request metrics. Dedicated sustained load, fault-injection and resource-leak validation are still needed for production reliability claims.

## Limitations

- HTTP/1.x HTTP(S) client listener and upstreams only; no HTTP/2 or HTTP/3.
- HTTP Upgrade/WebSocket and CONNECT tunneling are rejected with 501. Unexpected upstream upgrades produce 502.
- No cookie/body/refresh rewriting, forwarding of trailers or informational-response relay. Trusted proxy metadata uses only the documented bounded X-Forwarded policy.
- Redirect rewriting requires an exact selected-backend origin and a path inside its configured prefix, as described above.
- No automatic failover/retries, weighted scheduling, circuit breakers, external metrics exporters or clustering.
- Graceful drain cannot guarantee availability during an exchange or delivery beyond the network stack; event-loop stalls delay timers. Omitted host retains Node's default bind address.

## Development and verification

```sh
npm install
npm run typecheck
npm test
npm run build
npm run check:package
npm pack --dry-run --cache .npm
```

`typecheck` covers source and tests. Tests use Node's test/assert libraries and real local HTTP/HTTPS backends on allocated ports. They exercise routing, verbs, headers/cookies, Round Robin, independent listeners, dynamic registration, failures, deadlines, disconnects, incremental streams and an 8 MiB upload. Health tests control probe timers with Node's test timer mocks while exercising real network streams, including thresholds, recovery, no overlap, stale-result protection, passive signals, shared ownership and process-exit cleanup. Metrics tests cover exactly-once outcomes, concurrency, local/backend status origin, cancellations, histograms, immutable snapshots, identity churn, health statistics, disabled/enabled streaming, instrumentation fault isolation, shutdown/restart retention and process exit. The localhost TLS certificate/key under `tests/fixtures` are public test-only material; regenerate them when expired. TLS tests temporarily add that certificate to their test process's trust list and restore it afterward.

Lifecycle, TLS and proxy-security suites additionally exercise drain admission, uploads/downloads, deadlines/escalation, queued HTTP/HTTPS Agent cancellation without replacement connections, raw handshakes, client/backend disconnections, shared health ownership, bind retry, trusted/untrusted forwarding and restart. Source lives under `src/`; the published package contains generated JavaScript/declarations in `dist/` and this README. Internal transport and routing helpers are not package exports. For native connection semantics, see the [Node.js HTTP documentation](https://nodejs.org/api/http.html).

## Performance and reliability validation

Repository-only tooling now runs the client, proxy and backends in separate Node.js processes on loopback with dynamic ports. It compares direct/proxied/metrics-enabled traffic, verifies streaming hashes and concurrent selection counts, injects deterministic faults, and samples CPU, memory, event-loop behavior and actual tracked sockets. Normal tests include bounded reliability regressions, not a long benchmark or soak.

```sh
npm run bench
npm run bench:full -- --concurrency 10 --duration 1 --repetitions 3
npm run bench:stream
npm run fault
npm run soak -- --duration 12 --concurrency 10 --sample-ms 100 --gc
```

See [benchmarks/README.md](benchmarks/README.md) for configuration, limits, methodology and cleanup behavior, and [benchmarks/BASELINE.md](benchmarks/BASELINE.md) for actual reviewed measurements and limitations. Generated JSON/Markdown lives in ignored `benchmarks/results/`; it is local rather than published to GitHub. Percentiles are approximations, resource peaks are sampled, and local ratios include TCP/client/runtime overhead and measurement noise. Short successful runs do not establish production readiness or absence of long-term leaks.

Memory isolation and controlled-arrival characterization add `npm run bench:memory`, `npm run bench:capacity` and `npm run bench:soak`. They reuse the same workers/generator and distinguish RSS from live heap, V8 heap capacity, external memory and ArrayBuffers. Capacity reports include dispatch and schedule-relative latency, missed arrivals, configurable SLOs and per-process saturation evidence. See [benchmarks/MEMORY_AND_CAPACITY.md](benchmarks/MEMORY_AND_CAPACITY.md) for executed findings and unresolved questions. Cross-platform CI covers Node 22.19.0/24.x without running long soaks; `npm run check:package` checks built ESM/declarations and HTTP/HTTPS behavior after a build.

See [Milestone 6 validation](benchmarks/PRODUCTION_SAFETY.md) for executed lifecycle/security checks, before/after performance smoke, short sustained results and hosted CI evidence.
