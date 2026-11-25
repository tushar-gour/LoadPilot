import { STATUS_CODES, type ServerResponse } from "node:http";
/** Internal HTTP error response; never include upstream or exception details. */
export function sendError(res: ServerResponse, status: number): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  for (const name of res.getHeaderNames()) res.removeHeader(name);
  const body = `${STATUS_CODES[status] ?? "Internal Server Error"}\n`;
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  res.end(body);
}
