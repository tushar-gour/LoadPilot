# LoadPilot

LoadPilot is an early-stage TypeScript npm library for building independent HTTP load balancer instances. **This repository is not yet a functioning reverse proxy.** The current prototype supports pool registration, stateless Round Robin selection, and independent HTTP listener lifecycles. Incoming HTTP requests currently receive a placeholder response.

## Architecture

- `LoadPilot`: owns an HTTP listener, optional base route, and multiple server pools.
- `ServerPool`: owns a relative route, backend list, scheduling algorithm and cursor.
- `Server`: holds one validated HTTP(S) backend URL.
- `RoundRobin`: a stateless next-index calculation.

Each LoadPilot instance may own **multiple** ServerPools; one ServerPool may own multiple backend servers. Different LoadPilot instances have separate registries and listeners. Each ServerPool maintains its own selection cursor. To keep scheduling state independent, use distinct ServerPool objects for distinct LoadPilot instances.

## Example (registration only)

```ts
import { LoadPilot, ServerPool, Server, Algorithm } from "loadpilot";

const auth = new ServerPool({
  route: "/auth",
  servers: [new Server("http://localhost:3001"), new Server("http://localhost:3002")],
  algorithm: Algorithm.ROUND_ROBIN,
});

const pilot = new LoadPilot({
  name: "API Gateway",
  port: 8080,
  route: "/gateway",
  pools: [auth],
});

pilot.addPool(new ServerPool({route: "/cart", servers: [new Server("http://localhost:4001")]}));
await pilot.start();
// Later: await pilot.stop();
```

The intended paths will be `/gateway/auth/*` and `/gateway/cart/*`, but request-path matching and forwarding are not implemented yet. The HTTP listener currently responds with `LoadPilot is running`.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```

The TypeScript source lives under `src/`; `dist/` contains generated JavaScript and declarations for npm consumers.
