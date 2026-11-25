export type ProxyEvent =
  | { type: "response"; statusCode: number; headersMs: number }
  | { type: "completed" }
  | { type: "failure"; reason: "upstream" | "timeout" }
  | { type: "cancelled"; reason: "client" | "shutdown" };
export type ProxyObserver = (event: ProxyEvent) => void;

export function notify(observer: ProxyObserver | undefined, event: ProxyEvent): void {
  if (!observer) return;
  try {
    observer(event);
  } catch {
    // Only optional instrumentation is isolated; transport errors keep their
    // existing handlers and must never become telemetry callback errors.
    return;
  }
}
