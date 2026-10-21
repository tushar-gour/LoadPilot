import { LoadPilot } from "../src/LoadPilot.js";

const pilot = new LoadPilot({
  name: "LoadPilot",
  port: 3000,
  route: "/",
});

pilot.start();
setTimeout(() => {
  pilot.stop();
}, 10000);
