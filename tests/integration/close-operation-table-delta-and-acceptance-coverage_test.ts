/**
 * #47 against the real server: what the coverage ledger says about an operation
 * is what the running app's route table does. An operation the ledger calls
 * served outside the registry is mounted for its method and path, and an
 * operation it calls unbuilt is not mounted at all, so nothing answers for a
 * capability nobody owns and nothing is claimed that the server does not serve.
 *
 * The route table is read from the real application, not from source text, so a
 * route registered by any mechanism counts, and one that is commented out or
 * only matched by a catch-all middleware does not.
 */

import { assert, assertEquals } from "@std/assert";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  loadLedger,
  readRepoText,
} from "../helpers/operation-coverage-tree.ts";

interface CatalogAction {
  action: string;
  method: string;
  path: string;
}

const catalog = JSON.parse(
  readRepoText("docs/technical-design/api-catalog.json") ?? "{}",
) as { actions: CatalogAction[] };

/** A path with every parameter spelled the same, whichever router wrote it. */
function shape(path: string): string {
  return path
    .replace(/\{[^}]*\}/g, (match) => (match === "{.+}" ? "" : ":p"))
    .replace(/:[A-Za-z_]+/g, ":p")
    .replace(/:p+/g, ":p");
}

const key = (method: string, path: string) =>
  method.toUpperCase() + " " + shape(path);

/** The method and path of every route the real application mounts, middleware excluded. */
function mountedRoutes(fixture: { app: unknown }): Set<string> {
  const table = (fixture.app as {
    routes?: readonly { method: string; path: string }[];
  }).routes;
  assert(
    table !== undefined,
    "the application does not expose its route table",
  );
  return new Set(
    table.filter((route) => route.method !== "ALL")
      .map((route) => key(route.method, route.path)),
  );
}

function ledgerRows(state: "served-outside-registry" | "unbuilt") {
  const { operations } = loadLedger();
  return Object.entries(operations)
    .filter(([, entry]) => entry.state === state)
    .map(([action]) => {
      const row = catalog.actions.find((a) => a.action === action);
      assert(row !== undefined, action + " is not in the catalog");
      return row;
    });
}

Deno.test("AC2: every operation the ledger says is served is mounted for its method and path", () =>
  withWorkerFixture((fixture) => {
    const mounted = mountedRoutes(fixture);
    assert(mounted.size > 100, "the app route table looks empty");
    const missing = ledgerRows("served-outside-registry")
      .filter((row) => !mounted.has(key(row.method, row.path)))
      .map((row) => row.action + " " + row.method + " " + row.path);
    assertEquals(
      missing,
      [],
      "the ledger says these are served and the server does not mount them",
    );
    return Promise.resolve();
  }));

Deno.test("AC2: every operation the ledger says is unbuilt is not mounted", () =>
  withWorkerFixture((fixture) => {
    const mounted = mountedRoutes(fixture);
    const answering = ledgerRows("unbuilt")
      .filter((row) => mounted.has(key(row.method, row.path)))
      .map((row) => row.action + " " + row.method + " " + row.path);
    assertEquals(
      answering,
      [],
      "an operation the ledger calls unbuilt is mounted: register it or fix its row",
    );
    return Promise.resolve();
  }));

Deno.test("AC2: a mounted route is found by method and path, whatever its parameter spelling", () => {
  assertEquals(
    key("get", "/v1/skill-versions/:id/files/:path{.+}"),
    key("GET", "/v1/skill-versions/{id}/files/{path}"),
  );
  assert(
    key("POST", "/v1/artifacts") !== key("GET", "/v1/artifacts"),
    "a method that is not mounted must not be covered by another",
  );
});
