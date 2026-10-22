import { test } from "node:test";
import assert from "node:assert/strict";
import { LoadPilot } from "../src/LoadPilot.js";
import { Server } from "../src/server/Server.js";
import { ServerPool } from "../src/server/ServerPool.js";

function pool(route: string, ...urls: string[]): ServerPool {
  return new ServerPool({ route, servers: urls.map((url) => new Server(url)) });
}

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
  const auth = new ServerPool({ route: "/auth", servers: initial });
  initial.push(new Server("http://localhost:3002"));
  assert.equal(auth.getNextServer()?.baseUrl, "http://localhost:3001");
  assert.equal(auth.getNextServer()?.baseUrl, "http://localhost:3001");
});

test("Routes are normalized and invalid routes are rejected", () => {
  assert.equal(pool("/auth/").route, "/auth");
  assert.throws(() => pool("auth"), /Invalid route/);
  assert.throws(() => pool("/auth?x=1"), /Invalid route/);
  assert.throws(() => new Server("not-a-url"), /Invalid backend URL/);
});

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

test("LoadPilot starts and responds to an HTTP request", async () => {
  const pilot = new LoadPilot({ name: "HTTPTest", port: 18081 });
  await pilot.start();
  try {
    const response = await fetch("http://127.0.0.1:18081/");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "LoadPilot is running");
    await assert.rejects(() => pilot.start(), /cannot start/);
  } finally {
    await pilot.stop();
  }
  await pilot.stop();
});

test("Multiple LoadPilot instances listen independently", async () => {
  const first = new LoadPilot({
    name: "First",
    port: 18082,
    pools: [pool("/auth")],
  });
  const second = new LoadPilot({
    name: "Second",
    port: 18083,
    pools: [pool("/auth")],
  });
  try {
    await Promise.all([first.start(), second.start()]);
    const responses = await Promise.all([
      fetch("http://127.0.0.1:18082/"),
      fetch("http://127.0.0.1:18083/"),
    ]);
    assert.deepEqual(
      responses.map((r) => r.status),
      [200, 200],
    );
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test("Port collisions reject start rather than hanging", async () => {
  const first = new LoadPilot({ name: "First", port: 18084 });
  const second = new LoadPilot({ name: "Second", port: 18084 });
  await first.start();
  try {
    await assert.rejects(() => second.start(), { code: "EADDRINUSE" });
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});
