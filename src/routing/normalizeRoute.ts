/** Canonicalize an HTTP route prefix without accepting query strings or URLs. */
export function normalizeRoute(route: string): string {
  if (
    typeof route !== "string" ||
    !route.startsWith("/") ||
    route.includes("?") ||
    route.includes("#") ||
    route.includes("\\") ||
    route.includes("//") ||
    /\s/.test(route)
  ) {
    throw new Error(`Invalid route: ${String(route)}. Expected a path starting with '/'.`);
  }
  return route.replace(/\/+$/, "") || "/";
}
