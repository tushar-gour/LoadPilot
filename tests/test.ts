import { Pool } from "../src/Pool";
import { Server } from "../src/Server";

const serverList: Server[] = [
  new Server("server 1 url"),
  new Server("server 2 url"),
  new Server("server 3 url"),
  new Server("server 4 url"),
];

const pool1 = new Pool(serverList);

const serverList2: Server[] = [
  new Server("server 1 url pool 2"),
  new Server("server 2 url pool 2"),
  new Server("server 3 url pool 2"),
  new Server("server 4 url pool 2"),
];

const pool2 = new Pool(serverList2);

console.log(pool1.getNextServer());
console.log(pool2.getNextServer());
console.log(pool2.getNextServer());
console.log(pool1.getNextServer());
console.log(pool1.getNextServer());
console.log(pool1.getNextServer());
console.log(pool2.getNextServer());
console.log(pool2.getNextServer());
console.log(pool1.getNextServer());
console.log(pool2.getNextServer());
console.log(pool1.getNextServer());
console.log(pool2.getNextServer());
