import { BlockList, isIP } from "node:net";
import { TLSSocket } from "node:tls";
import type { IncomingMessage, IncomingHttpHeaders } from "node:http";

/** Strict HTTP authority metadata, never an upstream destination. */
export function validForwardedHost(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 260) return false;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(value);
  if (bracketed) return !bracketed[1].includes("%") && isIP(bracketed[1]) === 6 && validPort(bracketed[2]);
  const parts = /^([a-z\d.-]+)(?::(\d{1,5}))?$/i.exec(value);
  if (!parts || !validPort(parts[2])) return false;
  const name = parts[1].replace(/\.$/, "");
  if (/^[\d.]+$/.test(name)) return isIP(name) === 4;
  return name.length <= 253 && name.split(".").every((label) => label.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label));
}
function validPort(value: string | undefined): boolean { return value === undefined || (Number(value) >= 1 && Number(value) <= 65535); }
function validAddress(value: string): boolean { return !value.includes("%") && isIP(value) !== 0; }

/** Per-instance immutable policy. Node's BlockList handles native IPv4/IPv6 and mapped IPv4 matching. */
export class ForwardedHeaders {
  readonly addresses: readonly string[];
  private readonly trusted = new BlockList();

  constructor(addresses: readonly string[] = []) {
    if (!Array.isArray(addresses) || addresses.length > 256) throw new Error("trustedProxies must be an array of at most 256 IP addresses/CIDRs.");
    for (const entry of addresses) {
      if (typeof entry !== "string" || entry.length > 64) throw new Error("Invalid trustedProxies address/CIDR.");
      const [address, prefix, extra] = entry.split("/");
      const version = isIP(address);
      if (!version || address.includes("%") || extra !== undefined) throw new Error("Invalid trustedProxies address/CIDR.");
      const family = version === 4 ? "ipv4" : "ipv6";
      if (prefix === undefined) this.trusted.addAddress(address, family);
      else {
        if (!/^[1-9]\d{0,2}$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)) throw new Error("Invalid trustedProxies CIDR prefix; universal ranges are unsupported.");
        this.trusted.addSubnet(address, Number(prefix), family);
      }
    }
    this.addresses = Object.freeze([...addresses]);
  }

  isTrusted(address: string): boolean {
    if (!this.addresses.length || !validAddress(address)) return false;
    return this.trusted.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");
  }

  apply(headers: IncomingHttpHeaders, req: IncomingMessage): void {
    const peer = req.socket.remoteAddress ?? "";
    let client = peer;
    let protocol = req.socket instanceof TLSSocket && req.socket.encrypted ? "https" : "http";
    let host: unknown = req.headers.host;
    if (this.isTrusted(peer)) {
      const chain = req.headers["x-forwarded-for"];
      if (typeof chain === "string" && chain.length <= 1024) {
        const hops = chain.split(",").map((hop) => hop.trim());
        if (hops.length <= 16 && hops.every(validAddress)) {
          for (let index = hops.length - 1; index >= 0 && this.isTrusted(client); index--) client = hops[index];
        }
      }
      const forwardedProtocol = req.headers["x-forwarded-proto"];
      if (forwardedProtocol === "http" || forwardedProtocol === "https") protocol = forwardedProtocol;
      if (validForwardedHost(req.headers["x-forwarded-host"])) host = req.headers["x-forwarded-host"];
    }
    if (validAddress(client)) headers["x-forwarded-for"] = client;
    if (validForwardedHost(host)) headers["x-forwarded-host"] = host;
    headers["x-forwarded-proto"] = protocol;
  }
}
