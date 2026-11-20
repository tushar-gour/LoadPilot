# LoadPilot

LoadPilot is a lightweight TypeScript library for self-hosted HTTP load balancing in Node.js. Register backend servers in route-specific pools, start a listener, and receive real backend responses through a streaming reverse proxy. No runtime dependencies are required.

## Architecture

```text
Client → LoadPilot listener → RouteMatcher → ServerPool.getNextServer()
       → HttpProxy → selected HTTP/HTTPS backend
Client ← streamed status, headers and body ← HttpProxy ← backend
```

- `LoadPilot` owns one HTTP listener, an optional public base route and its pool registry.
- `RouteMatcher` selects the longest matching pool route at complete path-segment boundaries. It has no networking or scheduling responsibilities.
- `ServerPool` owns its backend list, Round Robin cursor and optional health monitor. Its default algorithm is `Algorithm.ROUND_ROBIN`.
- `Server` represents a validated HTTP(S) destination, optionally including a path prefix. Credentials, query strings and fragments are rejected in backend configuration.
- The internal `HttpProxy` manages transport, header filtering, redirects, streaming, deadlines and cancellation. It does not select backends.

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

Incoming `Forwarded` and `X-Forwarded-*` values are discarded. New `X-Forwarded-For` contains only the directly connected client's socket address; `X-Forwarded-Proto` is `http` because this listener speaks HTTP; `X-Forwarded-Host` records the original client-supplied Host as **untrusted metadata**. No trusted proxy chain is inferred. Deployments behind another proxy must account for this policy.

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

`start()` rejects repeated/concurrent starts and bind failures such as `EADDRINUSE`. A failed start can be retried. `stop()` is idempotent once stopped; calling it during start/stop rejects. **Shutdown immediately cancels in-flight proxy exchanges and closes active and idle connections**; graceful draining is not implemented. A stopped instance can be started again.

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

Repeated initialization does not create duplicate monitors. Shared pool objects retain one monitor while any owning LoadPilot listener is running; stopping one listener releases only its ownership. Stopping the final owner cancels pending probes and timers without treating cancellation as failure. Last-known diagnostics remain visible while stopped. A fresh start resets states/counters to UNKNOWN and schedules new probes; adding another owner to an already running monitor does not reset it. Monitoring lifecycle and passive-signal methods marked `@internal` are managed by LoadPilot and need no consumer calls.

Health monitoring has no configurable probe headers/authentication, custom method/status policy, body assertions, redirect following, jitter, global probe concurrency cap, distributed coordination or automatic failover replay. Use a dedicated bounded health endpoint appropriate for the application.

## Limitations

- HTTP/1.x client listener and HTTP/1.x HTTP(S) upstreams only; no inbound TLS termination or HTTP/2.
- HTTP Upgrade/WebSocket and CONNECT tunneling are rejected with 501. Unexpected upstream upgrades produce 502.
- No cookie/body/refresh rewriting, forwarding of trailers, informational-response relay, or trusted multi-proxy configuration.
- Redirect rewriting requires an exact selected-backend origin and a path inside its configured prefix, as described above.
- No automatic failover/retries, weighted scheduling, circuit breakers, metrics, clustering or graceful shutdown draining.
- The listener uses Node's default bind address; network exposure is controlled by the host environment.

## Development and verification

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run --cache .npm
```

`typecheck` covers source and tests. Tests use Node's test/assert libraries and real local HTTP/HTTPS backends on allocated ports. They exercise routing, verbs, headers/cookies, Round Robin, independent listeners, dynamic registration, failures, deadlines, disconnects, incremental streams and an 8 MiB upload. Health tests control probe timers with Node's test timer mocks while exercising real network streams, including thresholds, recovery, no overlap, stale-result protection, passive signals, shared ownership and process-exit cleanup. The localhost TLS certificate/key under `tests/fixtures` are public test-only material; regenerate them when expired. TLS tests temporarily add that certificate to their test process's trust list and restore it afterward.

Source lives under `src/`; the published package contains generated JavaScript/declarations in `dist/` and this README. Internal transport and routing helpers are not package exports. For native connection semantics, see the [Node.js HTTP documentation](https://nodejs.org/api/http.html).
