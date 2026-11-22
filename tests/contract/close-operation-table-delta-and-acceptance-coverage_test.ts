/**
 * #47 AC1 and AC3. AC3 runs on the real catalog, registry, data model and
 * migrations: every baseline row resolves to current code and evidence, or to
 * an owner in the coverage ledger. AC1 runs on a small fixed catalog, registry,
 * ledger and set of files, so each negative case fails for its own reason and a
 * real drift in the tree fails only the AC3 tests.
 */

import { assert, assertEquals } from "@std/assert";
import {
  catalogActions,
  loadLedger,
  migratedTables,
  modeledTables,
  readRepoText,
  registeredActions,
} from "../helpers/operation-coverage-tree.ts";
import {
  type CoverageLedger,
  reconcileOperations,
  reconcileTables,
} from "../helpers/operation-coverage.ts";

// ---------------------------------------------------------------- the real tree

Deno.test("AC3: every catalog operation is registered, served with evidence, or owned", () => {
  const ledger = loadLedger().operations;
  assert(Object.keys(ledger).length > 0, "the ledger lists no operation");
  assertEquals(
    reconcileOperations({
      catalogActions: catalogActions(),
      implemented: registeredActions(),
      ledger,
      read: readRepoText,
    }),
    [],
  );
});

Deno.test("AC3: every modeled and every migrated table resolves to a migration or a ledger row", () => {
  assertEquals(
    reconcileTables({
      modeled: modeledTables(),
      migrated: migratedTables(),
      ledger: loadLedger().tables,
    }),
    [],
  );
});

// ------------------------------------------------------------- a small fixed world

const REASON = "Arrives with the work that owns it.";

const FILES: Readonly<Record<string, string>> = {
  "routes.ts": 'app.get("/v1/served", handler);',
  "served_test.ts": "calls /v1/served and checks the answer",
};
const read = (path: string): string | null => FILES[path] ?? null;

const operationsLedger = (): Record<
  string,
  CoverageLedger["operations"][string]
> => ({
  "b.served": {
    state: "served-outside-registry",
    route: { file: "routes.ts", literal: "/v1/served" },
    test: { file: "served_test.ts", contains: "/v1/served" },
  },
  "c.unbuilt": { state: "unbuilt", owner: "#12", reason: REASON },
});

const operations = (
  overrides: {
    catalogActions?: readonly string[];
    implemented?: readonly string[];
    ledger?: Record<string, CoverageLedger["operations"][string]>;
    read?: (path: string) => string | null;
  } = {},
) =>
  reconcileOperations({
    catalogActions: overrides.catalogActions ??
      ["a.registered", "b.served", "c.unbuilt"],
    implemented: overrides.implemented ?? ["a.registered"],
    ledger: overrides.ledger ?? operationsLedger(),
    read: overrides.read ?? read,
  });

const tablesLedger = (): CoverageLedger["tables"] => ({
  modeledNotMigrated: {
    t_unbuilt: { state: "unbuilt", owner: "#43", reason: REASON },
    t_renamed: { state: "implemented-as", implementedAs: "t_new_name" },
  },
  migratedNotModeled: {
    t_extra: { module: "work", migration: "m/0002_extra.sql" },
    t_new_name: { module: "work", migration: "m/0003_new_name.sql" },
  },
});

const tables = (
  overrides: {
    modeled?: readonly string[];
    migrated?: Record<string, string>;
    ledger?: CoverageLedger["tables"];
  } = {},
) =>
  reconcileTables({
    modeled: overrides.modeled ??
      ["t_ok", "t_unbuilt", "t_renamed"],
    migrated: overrides.migrated ?? {
      t_ok: "m/0001_ok.sql",
      t_new_name: "m/0003_new_name.sql",
      t_extra: "m/0002_extra.sql",
    },
    ledger: overrides.ledger ?? tablesLedger(),
  });

Deno.test("AC1: the fixed world is consistent", () => {
  assertEquals(operations(), []);
  assertEquals(tables(), []);
});

Deno.test("AC1: a newly added operation with no registration and no owner fails", () => {
  const problems = operations({
    catalogActions: [
      "a.registered",
      "b.served",
      "c.unbuilt",
      "widgets.explode",
    ],
  });
  assertEquals(problems.length, 1);
  assert(problems[0].includes("widgets.explode"), problems[0]);
});

Deno.test("AC1: an operation whose ledger row is removed fails", () => {
  const ledger = operationsLedger();
  delete ledger["c.unbuilt"];
  const problems = operations({ ledger });
  assertEquals(problems.length, 1);
  assert(problems[0].includes("c.unbuilt"), problems[0]);
});

Deno.test("AC1: a ledger row for an operation that became registered must be removed", () => {
  const problems = operations({ implemented: ["a.registered", "c.unbuilt"] });
  assertEquals(problems.length, 1);
  assert(problems[0].includes("now registered"), problems[0]);
});

Deno.test("AC1: an unbuilt row without a real issue owner fails", () => {
  const ledger = operationsLedger();
  ledger["c.unbuilt"] = { state: "unbuilt", owner: "later", reason: REASON };
  const problems = operations({ ledger });
  assertEquals(problems.length, 1);
  assert(problems[0].includes("owner"), problems[0]);
});

Deno.test("AC1: an unbuilt operation or table with a thin reason fails", () => {
  const ledger = operationsLedger();
  ledger["c.unbuilt"] = { state: "unbuilt", owner: "#12", reason: "later" };
  const operationProblems = operations({ ledger });
  assertEquals(operationProblems.length, 1);
  assert(operationProblems[0].includes("plain reason"), operationProblems[0]);

  const rows: CoverageLedger["tables"] = {
    ...tablesLedger(),
    modeledNotMigrated: {
      ...tablesLedger().modeledNotMigrated,
      t_unbuilt: { state: "unbuilt", owner: "#43", reason: " " },
    },
  };
  const tableProblems = tables({ ledger: rows });
  assertEquals(tableProblems.length, 1);
  assert(tableProblems[0].includes("plain reason"), tableProblems[0]);
});

Deno.test("AC2: a route that is only commented out is not served", () => {
  const problems = operations({
    read: (path) =>
      path === "routes.ts"
        ? '/* app.get("/v1/served", handler); */'
        : read(path),
  });
  assertEquals(problems.length, 1);
  assert(
    problems[0].includes("b.served") && problems[0].includes("not served"),
    problems[0],
  );
});

Deno.test("AC1: a served row whose test no longer mentions the route fails", () => {
  const problems = operations({
    read: (path) => path === "served_test.ts" ? "nothing here" : read(path),
  });
  assertEquals(problems.length, 1);
  assert(
    problems[0].includes("b.served") && problems[0].includes("never mentions"),
    problems[0],
  );
});

Deno.test("AC1: a newly migrated table the model and the ledger do not know fails", () => {
  const problems = tables({
    migrated: {
      t_ok: "m/0001_ok.sql",
      t_new_name: "m/0003_new_name.sql",
      t_extra: "m/0002_extra.sql",
      widget_audit: "m/0999_widgets.sql",
    },
  });
  assertEquals(problems.length, 1);
  assert(problems[0].includes("widget_audit"), problems[0]);
});

Deno.test("AC1: a newly modeled table with no migration and no owner fails", () => {
  const problems = tables({
    modeled: ["t_ok", "t_unbuilt", "t_renamed", "widgets"],
  });
  assertEquals(problems.length, 1);
  assert(problems[0].includes("widgets"), problems[0]);
});

Deno.test("AC1: a ledger row for a table that is now modeled must be removed", () => {
  const problems = tables({
    modeled: ["t_ok", "t_unbuilt", "t_renamed", "t_extra"],
  });
  assertEquals(problems.length, 1);
  assert(problems[0].includes("t_extra"), problems[0]);
});
