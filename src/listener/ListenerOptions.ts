import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import {
  DEFAULT_MIN_VERSION,
  DEFAULT_MAX_VERSION,
  type SecureContextOptions,
} from "node:tls";

/** Inbound server certificate configuration; deliberately excludes insecure overrides and SNI callbacks. */
export interface ListenerTlsOptions {
  key: NonNullable<SecureContextOptions["key"]>;
  cert: NonNullable<SecureContextOptions["cert"]>;
  passphrase?: string;
  minVersion?: "TLSv1.2" | "TLSv1.3";
  maxVersion?: "TLSv1.2" | "TLSv1.3";
}

export function validateHost(host: string | undefined): string | undefined {
  if (host === undefined) return undefined;
  if (
    typeof host !== "string" ||
    !host ||
    host.length > 254 ||
    /[\s\x00-\x1f\x7f/\\?#@\[\]]/.test(host)
  )
    throw new Error("host must be an IP address or hostname.");
  if (isIP(host)) return host;
  const ascii = domainToASCII(host).replace(/\.$/, "");
  if (
    !ascii ||
    ascii.includes(":") ||
    ascii
      .split(".")
      .some(
        (label) => !label || label.length > 63 || !/^[a-z\d_-]+$/i.test(label),
      )
  )
    throw new Error("host must be an IP address or hostname.");
  // Validate without rewriting the user-selected binding address.
  return host;
}

export function resolveTls(
  options: ListenerTlsOptions | undefined,
): SecureContextOptions | undefined {
  if (options === undefined) return undefined;
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new Error("tls must be a certificate configuration object.");
  if (
    Object.keys(options).some(
      (key) =>
        !["key", "cert", "passphrase", "minVersion", "maxVersion"].includes(
          key,
        ),
    )
  )
    throw new Error("Unsupported tls option.");
  if (!hasContent(options.key))
    throw new Error("tls.key is required and must not be empty.");
  if (!hasContent(options.cert))
    throw new Error("tls.cert is required and must not be empty.");
  if (
    options.passphrase !== undefined &&
    typeof options.passphrase !== "string"
  )
    throw new Error("tls.passphrase must be a string.");
  const minVersion =
    options.minVersion ??
    (DEFAULT_MIN_VERSION === "TLSv1.3" ? "TLSv1.3" : "TLSv1.2");
  const maxVersion = options.maxVersion ?? DEFAULT_MAX_VERSION;
  if (
    !["TLSv1.2", "TLSv1.3"].includes(minVersion) ||
    !["TLSv1.2", "TLSv1.3"].includes(maxVersion)
  )
    throw new Error("tls protocol versions must be TLSv1.2 or TLSv1.3.");
  if (minVersion === "TLSv1.3" && maxVersion === "TLSv1.2")
    throw new Error("tls.maxVersion must not be lower than tls.minVersion.");
  return {
    key: options.key,
    cert: options.cert,
    passphrase: options.passphrase,
    minVersion,
    maxVersion,
  };
}

function hasContent(value: unknown): boolean {
  if (typeof value === "string" || Buffer.isBuffer(value))
    return value.length > 0;
  if (Array.isArray(value)) return value.length > 0 && value.every(hasContent);
  if (!value || typeof value !== "object") return false;
  return "pem" in value ? hasContent(value.pem) : true; // Native TLS validates supported key-object forms.
}
