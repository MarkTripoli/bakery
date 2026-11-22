/**
 * Reconciles the approved backend baseline against the code that serves it.
 *
 * The baseline is three lists written by hand: the operation catalog
 * (`api-catalog.json`), the logical data model (`data-model.json`) and the
 * test lanes. Each drifts from the code on its own. The ledger
 * (`docs/technical-design/operation-coverage.json`) is the one place that says,
 * for every baseline row the code does not serve through the usual door, who owns
 * it and what proves it. These functions fail when a row has no such answer, so a
 * new operation, table or skipped test cannot arrive silently.
 *
 * Everything here is pure over text the caller reads, so the same checks run on
 * the real tree and on a deliberately broken copy.
 */

/** An operation served by a route the action registry does not own. */
export interface ServedOperation {
  readonly state: "served-outside-registry";
  readonly route: { readonly file: string; readonly literal: string };
  readonly test: { readonly file: string; readonly contains: string };
}

/** An operation in the catalog that nothing serves yet. */
export interface UnbuiltOperation {
  readonly state: "unbuilt";
  /** An existing open GitHub issue, written `#123`. */
  readonly owner: string;
  readonly reason: string;
}

export type OperationEntry = ServedOperation | UnbuiltOperation;

/** A modeled table the migrations do not create under that name. */
export type ModeledTableEntry =
  | { readonly state: "provider-owned"; readonly implementedAs: string }
  | { readonly state: "implemented-as"; readonly implementedAs: string }
  | {
    readonly state: "unbuilt";
    readonly owner: string;
    readonly reason: string;
  };

/** A migrated table the logical model does not list. */
export interface UnmodeledTableEntry {
  readonly module: string;
  readonly migration: string;
}

export interface ConditionalSkip {
  readonly reason: string;
}

export interface CoverageLedger {
  readonly operations: Readonly<Record<string, OperationEntry>>;
  readonly tables: {
    readonly modeledNotMigrated: Readonly<Record<string, ModeledTableEntry>>;
    readonly migratedNotModeled: Readonly<Record<string, UnmodeledTableEntry>>;
  };
  readonly conditionalSkips: Readonly<Record<string, ConditionalSkip>>;
}

/** Reads a repository-relative text file, or null when it does not exist. */
export type ReadText = (path: string) => string | null;

const OWNER = /^#[1-9][0-9]*$/;

/** An unbuilt row's reason must say something a reader can act on. */
export const MIN_REASON_LENGTH = 20;

/** Source text with `//` and block comments removed, so commented code counts for nothing. */
export function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Every catalog operation must be registered, served with evidence, or owned. */
export function reconcileOperations(input: {
  catalogActions: readonly string[];
  implemented: readonly string[];
  ledger: CoverageLedger["operations"];
  read: ReadText;
}): string[] {
  const problems: string[] = [];
  const catalog = new Set(input.catalogActions);
  const implemented = new Set(input.implemented);

  for (const action of [...catalog].sort()) {
    if (!implemented.has(action) && !Object.hasOwn(input.ledger, action)) {
      problems.push(
        `operation ${action} is neither registered nor in the coverage ledger: add it with an owner or evidence`,
      );
    }
  }

  for (const [action, entry] of Object.entries(input.ledger)) {
    if (!catalog.has(action)) {
      problems.push(`ledger names ${action}, which the catalog does not`);
      continue;
    }
    if (implemented.has(action)) {
      problems.push(
        `ledger still lists ${action}, which is now registered: remove its row`,
      );
      continue;
    }
    if (entry.state === "unbuilt") {
      if (!OWNER.test(entry.owner)) {
        problems.push(
          `${action} owner "${entry.owner}" is not an issue like #12`,
        );
      }
      if (entry.reason.trim().length < MIN_REASON_LENGTH) {
        problems.push(
          `${action} is unbuilt without a plain reason (at least ${MIN_REASON_LENGTH} characters)`,
        );
      }
      continue;
    }
    const route = input.read(entry.route.file);
    if (route === null) {
      problems.push(`${action} route file ${entry.route.file} does not exist`);
    } else if (!withoutComments(route).includes(`"${entry.route.literal}"`)) {
      problems.push(
        `${action} is not served: ${entry.route.file} has no live "${entry.route.literal}"`,
      );
    }
    const test = input.read(entry.test.file);
    if (test === null) {
      problems.push(`${action} test file ${entry.test.file} does not exist`);
    } else if (!test.includes(entry.test.contains)) {
      problems.push(
        `${action} test ${entry.test.file} never mentions ${entry.test.contains}`,
      );
    }
  }
  return problems;
}

/** Every modeled table is migrated or explained; every migrated table is modeled or listed. */
export function reconcileTables(input: {
  modeled: readonly string[];
  migrated: Readonly<Record<string, string>>;
  ledger: CoverageLedger["tables"];
}): string[] {
  const problems: string[] = [];
  const modeled = new Set(input.modeled);

  for (const table of [...modeled].sort()) {
    const migrated = Object.hasOwn(input.migrated, table);
    const row = input.ledger.modeledNotMigrated[table];
    if (!migrated && row === undefined) {
      problems.push(
        `modeled table ${table} has no migration and no ledger row: add an owner or the table it became`,
      );
    }
    if (migrated && row !== undefined) {
      problems.push(`ledger still lists ${table}, which is now migrated`);
    }
  }
  for (const [table, row] of Object.entries(input.ledger.modeledNotMigrated)) {
    if (!modeled.has(table)) {
      problems.push(
        `ledger names modeled table ${table}, which the model does not`,
      );
    } else if (row.state === "unbuilt") {
      if (!OWNER.test(row.owner)) {
        problems.push(
          `table ${table} owner "${row.owner}" is not an issue like #12`,
        );
      }
      if (row.reason.trim().length < MIN_REASON_LENGTH) {
        problems.push(
          `table ${table} is unbuilt without a plain reason (at least ${MIN_REASON_LENGTH} characters)`,
        );
      }
    } else if (!Object.hasOwn(input.migrated, row.implementedAs)) {
      problems.push(
        `table ${table} says it became ${row.implementedAs}, which no migration creates`,
      );
    }
  }

  for (const [table, migration] of Object.entries(input.migrated).sort()) {
    if (modeled.has(table)) continue;
    const row = input.ledger.migratedNotModeled[table];
    if (row === undefined) {
      problems.push(
        `table ${table} (${migration}) is neither in the data model nor in the ledger: list it`,
      );
    } else if (row.migration !== migration) {
      problems.push(
        `table ${table} is created in ${migration}, but the ledger says ${row.migration}`,
      );
    }
  }
  for (const table of Object.keys(input.ledger.migratedNotModeled)) {
    if (!Object.hasOwn(input.migrated, table) || modeled.has(table)) {
      problems.push(
        `ledger lists ${table} as migrated and unmodeled, but it is not: remove its row`,
      );
    }
  }
  return problems;
}

/** Table names a migration file creates, in file order. */
export function createdTables(sql: string): string[] {
  return [
    ...sql.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?bakery"?\.)?"?([A-Za-z_0-9]+)"?/gi,
    ),
  ].map((match) => match[1]);
}

/** Table names a migration file drops. */
export function droppedTables(sql: string): string[] {
  return [
    ...sql.matchAll(
      /drop\s+table\s+(?:if\s+exists\s+)?(?:"?bakery"?\.)?"?([A-Za-z_0-9]+)"?/gi,
    ),
  ].map((match) => match[1]);
}

/** Markers that make a route answer without doing its work. */
const STUB_MARKERS: readonly { name: string; pattern: RegExp }[] = [
  {
    name: "a 501 status",
    pattern:
      /\b(?:status|Status)\s*[:=(]\s*501\b|\bc\.(?:body|json|text)\([^)]*,\s*501\)/,
  },
  {
    name: "NOT_IMPLEMENTED",
    pattern: /NOT_IMPLEMENTED|NotImplemented|notImplemented/,
  },
  {
    name: "a not-implemented throw",
    pattern:
      /throw\s+new\s+Error\(\s*["'`][^"'`]*not\s+(?:yet\s+)?implemented/i,
  },
  { name: "a TODO or FIXME", pattern: /\b(?:TODO|FIXME)\b/ },
];

/** Server source files whose live code stubs a route out. */
export function findStubs(
  files: Readonly<Record<string, string>>,
): string[] {
  const found: string[] = [];
  for (const [path, text] of Object.entries(files).sort()) {
    const code = withoutComments(text);
    for (const marker of STUB_MARKERS) {
      if (
        marker.pattern.test(marker.name === "a TODO or FIXME" ? text : code)
      ) {
        found.push(`${path} contains ${marker.name}`);
      }
    }
  }
  return found;
}

const SKIP_CALL =
  /(?:^|[{,\s])ignore\s*:\s*[^\s/]|\bDeno\.test\.ignore\b|\.(?:ignore|skip)\s*\(|\b(?:xit|xdescribe)\s*\(/m;

/** Test files that ignore or skip a test and are not in the ledger. */
export function findUnlistedSkips(
  tests: Readonly<Record<string, string>>,
  allowed: CoverageLedger["conditionalSkips"],
): string[] {
  const problems: string[] = [];
  for (const [path, text] of Object.entries(tests).sort()) {
    const skips = SKIP_CALL.test(text);
    const listed = Object.hasOwn(allowed, path);
    if (skips && !listed) {
      problems.push(
        `${path} ignores or skips a test and is not in conditionalSkips`,
      );
    }
    if (!skips && listed) {
      problems.push(
        `${path} is in conditionalSkips but no longer skips anything: remove its row`,
      );
    }
  }
  for (const path of Object.keys(allowed)) {
    if (!Object.hasOwn(tests, path)) {
      problems.push(`conditionalSkips names ${path}, which is not a test file`);
    }
  }
  return problems;
}
