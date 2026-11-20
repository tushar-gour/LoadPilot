import { test } from "node:test";
import assert from "node:assert/strict";

import { LoadPilot } from "../src/LoadPilot.js";
import { Server } from "../src/server/Server.js";
import { ServerPool } from "../src/server/ServerPool.js";
import { routeMatcher } from "../src/routing/RouteMatcher.js";

// Test helpers

function pool(route: string, ...urls: string[]): ServerPool {
  return new ServerPool({
    route,
    servers: urls.map((url) => new Server(url)),
  });
}

function poolRegistry(
  ...serverPools: ServerPool[]
): ReadonlyMap<string, ServerPool> {
  return new Map(
    serverPools.map((serverPool) => [serverPool.route, serverPool]),
  );
}

// ServerPool and Round Robin tests

test("Round Robin cycles through servers", () => {
  const auth = pool(
    "/auth",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://localhost:3003",
  );

  const sequence = Array.from(
    { length: 7 },
    () => auth.getNextServer()?.baseUrl,
  );

  assert.deepEqual(sequence, [
    "http://localhost:3001",
    "http://localhost:3002",
    "http://localhost:3003",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://localhost:3003",
    "http://localhost:3001",
  ]);
});

test("Pools maintain independent rotation state", () => {
  const auth = pool("/auth", "http://localhost:3001", "http://localhost:3002");

  const cart = pool("/cart", "http://localhost:4001", "http://localhost:4002");

  assert.equal(auth.getNextServer()?.baseUrl, "http://localhost:3001");

  assert.equal(auth.getNextServer()?.baseUrl, "http://localhost:3002");

  assert.equal(cart.getNextServer()?.baseUrl, "http://localhost:4001");

  assert.equal(auth.getNextServer()?.baseUrl, "http://localhost:3001");

  assert.equal(cart.getNextServer()?.baseUrl, "http://localhost:4002");
});

test("Empty pool returns null and added backend participates", () => {
  const auth = pool("/auth");

  assert.equal(auth.getNextServer(), null);

  auth.add(new Server("http://localhost:3001"));

  assert.equal(auth.getNextServer()?.baseUrl, "http://localhost:3001");
});

test("ServerPool takes a snapshot of initial servers", () => {
  const initial = [new Server("http://localhost:3001")];

  const auth = new ServerPool({
    route: "/auth",
    servers: initial,
  });

  initial.push(new Server("http://localhost:3002"));

  assert.equal(auth.getNextServer()?.baseUrl, "http://localhost:3001");

  assert.equal(auth.getNextServer()?.baseUrl, "http://localhost:3001");
});

// Route validation tests

test("Routes are normalized and invalid routes are rejected", () => {
  assert.equal(pool("/auth/").route, "/auth");

  assert.throws(() => pool("auth"), /Invalid route/);

  assert.throws(() => pool("/auth?x=1"), /Invalid route/);

  assert.throws(() => new Server("not-a-url"), /Invalid backend URL/);
});

// RouteMatcher tests

test("RouteMatcher selects pool with LoadPilot base route", () => {
  const auth = pool("/auth");
  const cart = pool("/cart");

  const pools = poolRegistry(auth, cart);

  const result = routeMatcher.getServerPoolFromRoute(
    "/gateway/auth/login",
    "/gateway",
    pools,
  );

  assert.strictEqual(result, auth);
});

test("RouteMatcher works without LoadPilot base route", () => {
  const auth = pool("/auth");

  const result = routeMatcher.getServerPoolFromRoute(
    "/auth/login",
    "/",
    poolRegistry(auth),
  );

  assert.strictEqual(result, auth);
});

test("RouteMatcher supports multi-segment base routes", () => {
  const auth = pool("/auth");
  const cart = pool("/cart");

  const pools = poolRegistry(auth, cart);

  assert.strictEqual(
    routeMatcher.getServerPoolFromRoute("/api/v1/auth/login", "/api/v1", pools),
    auth,
  );

  assert.strictEqual(
    routeMatcher.getServerPoolFromRoute("/api/v1/cart/items", "/api/v1", pools),
    cart,
  );
});

test("RouteMatcher selects longest matching pool route", () => {
  const auth = pool("/auth");
  const admin = pool("/auth/admin");

  const pools = poolRegistry(auth, admin);

  assert.strictEqual(
    routeMatcher.getServerPoolFromRoute(
      "/gateway/auth/admin/users",
      "/gateway",
      pools,
    ),
    admin,
  );

  assert.strictEqual(
    routeMatcher.getServerPoolFromRoute(
      "/gateway/auth/login",
      "/gateway",
      pools,
    ),
    auth,
  );
});

test("RouteMatcher respects route segment boundaries", () => {
  const auth = pool("/auth");
  const pools = poolRegistry(auth);

  assert.strictEqual(
    routeMatcher.getServerPoolFromRoute("/authentication/login", "/", pools),
    null,
  );

  assert.strictEqual(
    routeMatcher.getServerPoolFromRoute(
      "/gatewayXYZ/auth/login",
      "/gateway",
      pools,
    ),
    null,
  );

  assert.strictEqual(
    routeMatcher.getServerPoolFromRoute(
      "/gateway/authentication/login",
      "/gateway",
      pools,
    ),
    null,
  );
});

test("RouteMatcher returns null for unknown routes", () => {
  const auth = pool("/auth");
  const pools = poolRegistry(auth);

  assert.strictEqual(
    routeMatcher.getServerPoolFromRoute(
      "/gateway/cart/items",
      "/gateway",
      pools,
    ),
    null,
  );

  assert.strictEqual(
    routeMatcher.getServerPoolFromRoute(
      "/gateway/auth/login",
      "/gateway",
      new Map<string, ServerPool>(),
    ),
    null,
  );
});

test("RouteMatcher supports exact routes and root pools", () => {
  const root = pool("/");
  const auth = pool("/auth");

  const pools = poolRegistry(root, auth);

  assert.strictEqual(
    routeMatcher.getServerPoolFromRoute("/gateway", "/gateway", pools),
    root,
  );

  assert.strictEqual(
    routeMatcher.getServerPoolFromRoute("/gateway/other", "/gateway", pools),
    root,
  );

  assert.strictEqual(
    routeMatcher.getServerPoolFromRoute("/gateway/auth", "/gateway", pools),
    auth,
  );
});

// LoadPilot registration tests

test("LoadPilot constructor and addPool reject duplicate routes", () => {
  const pilot = new LoadPilot({
    name: "TestPilot",
    port: 18080,
    route: "/gateway/",
    pools: [pool("/auth", "http://localhost:3001")],
  });

  assert.equal(pilot.options.route, "/gateway");

  pilot.addPool(pool("/cart", "http://localhost:4001"));

  assert.throws(() => pilot.addPool(pool("/auth/")), /already registered/);

  assert.throws(
    () =>
      new LoadPilot({
        name: "Duplicate",
        port: 18086,
        pools: [pool("/x"), pool("/x")],
      }),
    /already registered/,
  );
});

// HTTP lifecycle tests

test("LoadPilot starts and responds to an HTTP request", async () => {
  const pilot = new LoadPilot({
    name: "HTTPTest",
    port: 0,
  });

  await pilot.start();

  try {
    const response = await fetch(`http://127.0.0.1:${pilot.port}/`);

    assert.equal(response.status, 404);

    assert.equal(await response.text(), "Not Found\n");

    await assert.rejects(() => pilot.start(), /cannot start/);
  } finally {
    await pilot.stop();
  }

  await pilot.stop();
});

test("Multiple LoadPilot instances listen independently", async () => {
  const first = new LoadPilot({
    name: "First",
    port: 0,
    pools: [pool("/auth")],
  });

  const second = new LoadPilot({
    name: "Second",
    port: 0,
    pools: [pool("/auth")],
  });

  try {
    await Promise.all([first.start(), second.start()]);

    const responses = await Promise.all([
      fetch(`http://127.0.0.1:${first.port}/auth`),
      fetch(`http://127.0.0.1:${second.port}/other`),
    ]);

    assert.deepEqual(
      responses.map((response) => response.status),
      [503, 404],
    );
    await Promise.all(responses.map((response) => response.text()));
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test("Port collisions reject start rather than hanging", async () => {
  const first = new LoadPilot({
    name: "First",
    port: 0,
  });
  await first.start();
  assert.ok(first.port);
  const second = new LoadPilot({
    name: "Second",
    port: first.port,
  });

  try {
    await assert.rejects(() => second.start(), { code: "EADDRINUSE" });
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});
