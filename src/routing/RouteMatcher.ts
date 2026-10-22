import { ServerPool } from "../server/ServerPool.js";

class RouteMatcher {
  getServerPoolFromRoute(
    pathname: string,
    baseRoute: string,
    pools: ReadonlyMap<string, ServerPool>,
  ): ServerPool | null {
    // match exact routes or complete path-segment prefixes.
    const matchesRoute = (path: string, route: string): boolean => {
      return route === "/" || path === route || path.startsWith(`${route}/`);
    };

    // validate LoadPilot's base route.
    if (!matchesRoute(pathname, baseRoute)) {
      return null;
    }

    // remove LoadPilot's base route.
    const remainingPath =
      baseRoute === "/" ? pathname : pathname.slice(baseRoute.length) || "/";

    // find the most specific matching pool.
    let matchedPool: ServerPool | null = null;
    let longestMatch = -1;

    for (const [poolRoute, pool] of pools) {
      if (
        matchesRoute(remainingPath, poolRoute) &&
        poolRoute.length > longestMatch
      ) {
        matchedPool = pool;
        longestMatch = poolRoute.length;
      }
    }

    // return matching pool or null.
    return matchedPool;
  }
}

const routeMatcher = new RouteMatcher();

export { RouteMatcher, routeMatcher };
