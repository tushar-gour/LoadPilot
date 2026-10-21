import assert from "node:assert/strict";
import { LoadPilot } from "../src/LoadPilot.js";
import { Server } from "../src/Server.js";
import { ServerPool } from "../src/ServerPool.js";

const pool1 = new ServerPool("auth", [
  new Server("server 1 url"),
  new Server("server 2 url"),
  new Server("server 3 url"),
  new Server("server 4 url"),
]);

const pool2 = new ServerPool("payments", [
  new Server("pool 2 server A url"),
  new Server("pool 2 server B url"),
]);

assert.equal(pool1.getNextServer()?.baseUrl, "server 1 url");
assert.equal(pool2.getNextServer()?.baseUrl, "pool 2 server A url");
assert.equal(pool2.getNextServer()?.baseUrl, "pool 2 server B url");
assert.deepEqual(
  Array.from({ length: 7 }, () => pool1.getNextServer()?.baseUrl),
  [
    "server 2 url",
    "server 3 url",
    "server 4 url",
    "server 1 url",
    "server 2 url",
    "server 3 url",
    "server 4 url",
  ],
);
assert.equal(pool2.getNextServer()?.baseUrl, "pool 2 server A url");
assert.equal(new ServerPool("empty").getNextServer(), null);

const loadPilot = new LoadPilot({ port: 3000, route: "/" });
loadPilot.addPool(pool1);
loadPilot.addPool(pool2);
assert.throws(
  () => loadPilot.addPool(new ServerPool("auth")),
  /already registered/,
);

// A separate LoadPilot instance has its own registry.
const anotherLoadPilot = new LoadPilot({ port: 3001, route: "/" });
assert.doesNotThrow(() => anotherLoadPilot.addPool(new ServerPool("auth")));

console.log("All LoadPilot pool tests passed.");
