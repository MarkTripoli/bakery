import { assertEquals } from "@std/assert";

const root = new URL("../../", import.meta.url);

/**
 * Every route a server module registers, as `METHOD path`.
 *
 * Routes are read from source rather than from a running server: this rail runs
 * in the default lane, and starting the app to enumerate its table would make a
 * catalogue omission cost a database instead of a parse.
 */
async function registeredRoutes(): Promise<Set<string>> {
  const routes = new Set<string>();
  const modules = new URL("apps/server/src/modules/", root);
  for await (const entry of Deno.readDir(modules)) {
    if (!entry.isDirectory) continue;
    const file = new URL(`${entry.name}/routes.ts`, modules);
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    for (
      const match of text.matchAll(
        /app\.(get|post|put|patch|delete)\(\s*\n?\s*"([^"]+)"/g,
      )
    ) {
      routes.add(`${match[1].toUpperCase()} ${normalize(match[2])}`);
    }
  }
  return routes;
}

/**
 * A route path in the spelling the catalogue uses.
 *
 * Hono writes a catch-all parameter as `:path{.+}`; the catalogue writes it as
 * `{path}`. Without this the two spellings never match and a documented route
 * is reported missing, which would make the rail cry wolf on its first run.
 */
function normalize(path: string): string {
  return path.replace(/\{[^}]*\}/g, "");
}

/** Every path the API catalogue documents, in the same `:id` spelling. */
async function cataloguedRoutes(): Promise<Map<string, string>> {
  const catalog = JSON.parse(
    await Deno.readTextFile(
      new URL("docs/technical-design/api-catalog.json", root),
    ),
  ) as {
    actions: {
      method: string;
      path: string;
      action: string;
    }[];
  };
  const byRoute = new Map<string, string>();
  for (const action of catalog.actions) {
    // The catalogue writes path parameters as `{id}`; the server writes `:id`.
    const path = action.path.replace(/\{([^}]+)\}/g, ":$1");
    byRoute.set(`${action.method.toUpperCase()} ${path}`, action.action);
  }
  return byRoute;
}

Deno.test("every registered route is in the API catalogue", async () => {
  // The catalogue is the surface a caller navigates by, so a route missing from
  // it is invisible to everyone who did not read the route table. This rail
  // exists because exactly that happened: the worker's attempt context read
  // shipped in #504 and was absent from the catalogue, so two seats concluded
  // the worker had no way to fetch pinned bytes and nearly built a second read
  // path beside the working one. A description fix cannot prevent a second
  // omission; a parity check can.
  const registered = await registeredRoutes();
  const catalogued = await cataloguedRoutes();
  const missing = [...registered]
    .filter((route) => !catalogued.has(route))
    .sort();
  assertEquals(
    missing,
    [],
    "routes registered by a server module but absent from api-catalog.json",
  );
});

Deno.test("the worker's attempt context read is catalogued", async () => {
  // Named explicitly, so deleting the catalogue entry fails here rather than
  // only in the general parity check, and so the reason survives in the test.
  const catalogued = await cataloguedRoutes();
  assertEquals(
    catalogued.get("GET /v1/worker/attempts/:id/context"),
    "worker.context",
  );
});
