import { test } from "node:test";
import assert from "node:assert/strict";

import { LoadPilot } from "../src/LoadPilot.js";
import { Server } from "../src/Server.js";
import { ServerPool } from "../src/ServerPool.js";

// 1. Round Robin
test("Round Robin cycles through servers", () => {
  const pool = new ServerPool("auth", [
    new Server("server1"),
    new Server("server2"),
    new Server("server3"),
  ]);

  const results = Array.from(
    { length: 7 },
    () => pool.getNextServer()?.baseUrl,
  );

  assert.deepEqual(results, [
    "server1",
    "server2",
    "server3",
    "server1",
    "server2",
    "server3",
    "server1",
  ]);
});

// 2. Independent pool state
test("Pools rotate independently", () => {
  const auth = new ServerPool("auth", [
    new Server("auth1"),
    new Server("auth2"),
  ]);

  const cart = new ServerPool("cart", [
    new Server("cart1"),
    new Server("cart2"),
  ]);

  assert.equal(auth.getNextServer()?.baseUrl, "auth1");
  assert.equal(auth.getNextServer()?.baseUrl, "auth2");

  assert.equal(cart.getNextServer()?.baseUrl, "cart1");

  assert.equal(auth.getNextServer()?.baseUrl, "auth1");
  assert.equal(cart.getNextServer()?.baseUrl, "cart2");
});

// 3. Empty pools
test("Empty pool returns null", () => {
  const pool = new ServerPool("empty");

  assert.equal(pool.getNextServer(), null);
});

// 4. Duplicate pool registration
test("LoadPilot rejects duplicate categories", () => {
  const pilot = new LoadPilot({
    name: "TestPilot",
    port: 18080,
    route: "/",
  });

  pilot.addPool(new ServerPool("auth"));

  assert.throws(
    () => pilot.addPool(new ServerPool("auth")),
    /already registered/,
  );
});

// 5. HTTP server lifecycle
test("LoadPilot starts and serves HTTP requests", async () => {
  const pilot = new LoadPilot({
    name: "HTTPTest",
    port: 18081,
    route: "/",
  });

  await pilot.start();

  try {
    const response = await fetch("http://127.0.0.1:18081/");

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "LoadPilot is running");
  } finally {
    await pilot.stop();
  }
});

// 6. Multiple independent LoadPilot instances
test("Multiple LoadPilot instances serve independently", async () => {
  const pilot1 = new LoadPilot({
    name: "Pilot1",
    port: 18082,
    route: "/",
  });

  const pilot2 = new LoadPilot({
    name: "Pilot2",
    port: 18083,
    route: "/",
  });

  try {
    await Promise.all([pilot1.start(), pilot2.start()]);

    const [response1, response2] = await Promise.all([
      fetch("http://127.0.0.1:18082/"),
      fetch("http://127.0.0.1:18083/"),
    ]);

    assert.equal(response1.status, 200);
    assert.equal(response2.status, 200);

    assert.equal(await response1.text(), "LoadPilot is running");
    assert.equal(await response2.text(), "LoadPilot is running");
  } finally {
    await Promise.all([pilot1.stop(), pilot2.stop()]);
  }
});
