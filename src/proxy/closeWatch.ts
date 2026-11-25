import type { EventEmitter } from "node:events";
export interface CloseWatch {
  promise: Promise<void>;
  cleanup: () => void;
}
export function watchClose(stream: EventEmitter & { closed: boolean }): CloseWatch {
  let onClose = () => {};
  const promise =
    stream.closed ?
      Promise.resolve()
    : new Promise<void>((resolve) => {
        onClose = resolve;
        stream.once("close", onClose);
      });
  return { promise, cleanup: () => stream.off("close", onClose) };
}
