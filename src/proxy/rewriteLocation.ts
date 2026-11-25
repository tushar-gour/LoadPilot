export function rewriteLocation(
  location: string,
  backend: URL,
  upstreamPath: string,
  baseRoute: string,
): string | undefined {
  let destination: URL;
  try {
    destination = new URL(location, `${backend.origin}${upstreamPath}`);
  } catch {
    return undefined;
  }
  if (destination.origin !== backend.origin) return location;
  const prefix = backend.pathname.replace(/\/+$/, "");
  if (
    prefix &&
    destination.pathname !== prefix &&
    !destination.pathname.startsWith(`${prefix}/`)
  ) {
    // No public mapping exists outside the configured backend path prefix.
    return undefined;
  }
  const path = destination.pathname.slice(prefix.length) || "/";
  const publicPath = `${baseRoute === "/" ? "" : baseRoute}${path}`;
  // Never turn a path into a network-path redirect, even with hostile headers.
  if (publicPath.startsWith("//")) return undefined;
  return publicPath + destination.search + destination.hash;
}
