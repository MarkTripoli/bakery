/**
 * #47 AC1 and AC3 against the real catalog, registry, data model and
 * migrations: every baseline row resolves to current code and evidence, or to
 * an owner in the coverage ledger, and a newly added or missing operation,
 * table or ledger row fails.
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

const operationProblems = (
  overrides: {
    catalogActions?: readonly string[];
    implemented?: readonly string[];
    ledger?: CoverageLedger["operations"];
    read?: (path: string) => string | null;
  } = {},
) =>
  reconcileOperations({
    catalogActions: overrides.catalogActions ?? catalogActions(),
    implemented: overrides.implemented ?? registeredActions(),
    ledger: overrides.ledger ?? loadLedger().operations,
    read: overrides.read ?? readRepoText,
  });

const tableProblems = (
  overrides: {
    modeled?: readonly string[];
    migrated?: Record<string, string>;
    ledger?: CoverageLedger["tables"];
  } = {},
) =>
  reconcileTables({
    modeled: overrides.modeled ?? modeledTables(),
    migrated: overrides.migrated ?? migratedTables(),
    ledger: overrides.ledger ?? loadLedger().tables,
  });

Deno.test("AC3: every catalog operation is registered, served with evidence, or owned", () => {
  assertEquals(operationProblems(), []);
});

Deno.test("AC3: every modeled and every migrated table resolves to a migration or a ledger row", () => {
  assertEquals(tableProblems(), []);
});

Deno.test("AC3: every unbuilt row names an existing issue and every served row names live code and a test", () => {
  const { operations } = loadLedger();
  const rows = Object.entries(operations);
  assert(rows.length > 0, "the ledger lists no operation");
  for (const [action, entry] of rows) {
    if (entry.state === "unbuilt") {
      assert(/^#[1-9][0-9]*$/.test(entry.owner), action + " owner");
      assert(entry.reason.trim().length > 20, action + " needs a plain reason");
    } else {
      assert(readRepoText(entry.route.file) !== null, action + " route file");
      assert(readRepoText(entry.test.file) !== null, action + " test file");
    }
  }
});

Deno.test("AC1: a newly added operation with no registration and no owner fails", () => {
  const problems = operationProblems({
    catalogActions: [...catalogActions(), "widgets.explode"],
  });
  assertEquals(problems.length, 1);
  assert(problems[0].includes("widgets.explode"), problems[0]);
});

Deno.test("AC1: an operation whose ledger row is removed fails", () => {
  const ledger = { ...loadLedger().operations };
  const [victim] = Object.keys(ledger);
  delete ledger[victim];
  const problems = operationProblems({ ledger });
  assertEquals(problems.length, 1);
  assert(problems[0].includes(victim), problems[0]);
});

Deno.test("AC1: a ledger row for an operation that became registered must be removed", () => {
  const [victim] = Object.keys(loadLedger().operations);
  const problems = operationProblems({
    implemented: [...registeredActions(), victim],
  });
  assertEquals(problems.length, 1);
  assert(problems[0].includes("now registered"), problems[0]);
});

Deno.test("AC1: an unbuilt row without a real issue owner or a reason fails", () => {
  const ledger: Record<string, CoverageLedger["operations"][string]> = {
    ...loadLedger().operations,
  };
  const unbuilt = Object.keys(ledger).find((a) =>
    ledger[a].state === "unbuilt"
  )!;
  ledger[unbuilt] = { state: "unbuilt", owner: "later", reason: " " };
  const problems = operationProblems({ ledger });
  assertEquals(problems.length, 2);
  assert(problems.some((p) => p.includes("owner")), problems.join("\n"));
  assert(problems.some((p) => p.includes("no reason")), problems.join("\n"));
});

Deno.test("AC2: a route that is only commented out is not served", () => {
  const [action, entry] = Object.entries(loadLedger().operations).find(
    ([, e]) => e.state === "served-outside-registry",
  )!;
  assert(entry.state === "served-outside-registry");
  const real = readRepoText(entry.route.file)!;
  const disabled = real.replaceAll(
    '"' + entry.route.literal + '"',
    '/* "' + entry.route.literal + '" */ "/disabled"',
  );
  const problems = operationProblems({
    read: (path) => path === entry.route.file ? disabled : readRepoText(path),
  });
  assertEquals(problems.length, 1);
  assert(
    problems[0].includes(action) && problems[0].includes("not served"),
    problems[0],
  );
});

Deno.test("AC1: a served row whose test no longer mentions the route fails", () => {
  const [action, entry] = Object.entries(loadLedger().operations).find(
    ([, e]) => e.state === "served-outside-registry",
  )!;
  assert(entry.state === "served-outside-registry");
  const problems = operationProblems({
    read: (path) =>
      path === entry.test.file ? "nothing here" : readRepoText(path),
  });
  assertEquals(problems.length, 1);
  assert(
    problems[0].includes(action) && problems[0].includes("never mentions"),
    problems[0],
  );
});

Deno.test("AC1: a newly migrated table the model and the ledger do not know fails", () => {
  const problems = tableProblems({
    migrated: {
      ...migratedTables(),
      widget_audit: "apps/server/x/0999_widgets.sql",
    },
  });
  assertEquals(problems.length, 1);
  assert(problems[0].includes("widget_audit"), problems[0]);
});

Deno.test("AC1: a newly modeled table with no migration and no owner fails", () => {
  const problems = tableProblems({ modeled: [...modeledTables(), "widgets"] });
  assertEquals(problems.length, 1);
  assert(problems[0].includes("widgets"), problems[0]);
});

Deno.test("AC1: a ledger row for a table that is now modeled or migrated under its modeled name must be removed", () => {
  const ledger = loadLedger().tables;
  const [victim] = Object.keys(ledger.migratedNotModeled);
  const problems = tableProblems({ modeled: [...modeledTables(), victim] });
  assert(problems.some((p) => p.includes(victim)), problems.join("\n"));
});
