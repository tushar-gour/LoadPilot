import type { IncomingHttpHeaders } from "node:http";
const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
]);

export function endToEndHeaders(source: IncomingHttpHeaders): IncomingHttpHeaders {
  const excluded = new Set(hopByHop);
  for (const token of source.connection?.split(",") ?? []) {
    excluded.add(token.trim().toLowerCase());
  }
  const result: IncomingHttpHeaders = Object.create(null);
  for (const [name, value] of Object.entries(source)) {
    if (!excluded.has(name)) result[name] = value;
  }
  return result;
}
