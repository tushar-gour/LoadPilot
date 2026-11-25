import type { Agent as HttpAgent } from "node:http";
import { Socket } from "node:net";
export function managedAgent<T extends HttpAgent>(agent: T) {
  const gate = { closed: false },
    create = agent.createConnection.bind(agent);
  agent.createConnection = function (...args) {
    if (!gate.closed) return create(...args);
    // Native Agent can assign cancelled queued requests after socket closure.
    // Give that native cleanup path an unconnected socket, never fresh DNS/TCP.
    const socket = new Socket();
    queueMicrotask(() => socket.destroy());
    return socket;
  };
  return {
    agent,
    closeGate: () => {
      gate.closed = true;
    },
  };
}
