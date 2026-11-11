import { assert, assertEquals } from "@std/assert";
import { extname, join, relative } from "node:path";

/**
 * The ticket tables (issue #82) hold what admission stands on: the source
 * policy, the bounded ticket snapshot, the immutable readiness reports, the
 * task links and the requests. The application database role may insert into
 * all five and update a column list of four, so the database cannot tell a
 * request written through the admission code from one written by a shortcut:
 * only the code path decides. These files are the doors:
 *
 * - `ticket-store.ts` writes `ticket_requests`, `external_tickets` and
 *   `ticket_readiness_reports`, and shares `ticket_task_links` and
 *   `ticket_sources` with one command each. Its request writer refuses a
 *   disposition move the state machine does not allow (`canTransition`).
 * - `ticket-request-command.ts` adds a task link (`createTicketTaskLink`).
 * - `ticket-source-command.ts` creates and updates a source.
 *
 * `ticket_readiness_reports` is insert-only everywhere: a recorded evaluation
 * is never rewritten, and the role has no update grant either. No table has a
 * delete grant, so no file may delete from, merge into, truncate or copy any of
 * them. This rail fails on any other writer, so adding one is a reviewed
 * decision that edits this list, not an accident.
 *
 * It is a guardrail against the accidental writer, not a proof. It reads
 * source text of `.ts`, `.tsx`, `.js`, `.mjs` and `.cjs` files under `apps`,
 * `packages`, `ee` and `scripts`, so it does not see: SQL assembled at run
 * time (an interpolated table name, `join`, a helper that takes the statement
 * text), SQL in migrations or other file types, a write through a view,
 * function or differently named relation, or a writer reached by a driver call
 * that never spells the statement. It does tolerate a statement split across
 * lines, a string concatenation and an escaped line break inside one literal.
 * The column-list update grants and the missing delete grant are the
 * database-side bound.
 */
const root = new URL("../..", import.meta.url).pathname;
const productionRoots = ["apps", "packages", "ee", "scripts"] as const;
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const skipDirectories = new Set(["node_modules", "dist", "build", ".next"]);

const STORE = "apps/server/src/modules/work/ticket-store.ts";
const REQUEST_COMMAND =
  "apps/server/src/modules/work/ticket-request-command.ts";
const SOURCE_COMMAND = "apps/server/src/modules/work/ticket-source-command.ts";

export const TABLES = [
  "ticket_requests",
  "external_tickets",
  "ticket_readiness_reports",
  "ticket_task_links",
  "ticket_sources",
] as const;
export type TicketTable = typeof TABLES[number];

/** The files that may insert into or update each table. */
const writers: Readonly<Record<TicketTable, ReadonlySet<string>>> = {
  ticket_requests: new Set([STORE]),
  external_tickets: new Set([STORE]),
  ticket_readiness_reports: new Set([STORE]),
  ticket_task_links: new Set([STORE, REQUEST_COMMAND]),
  ticket_sources: new Set([SOURCE_COMMAND, STORE]),
};

export type Verb =
  | "insert"
  | "update"
  | "delete"
  | "merge"
  | "truncate"
  | "copy";

/** What each verb looks like in front of a table name. */
const verbs: Readonly<Record<Verb, string>> = {
  insert: String.raw`\binsert\s+into\s+`,
  update: String.raw`\bupdate\s+(?:only\s+)?`,
  delete: String.raw`\bdelete\s+from\s+(?:only\s+)?`,
  merge: String.raw`\bmerge\s+into\s+`,
  truncate: String.raw`\btruncate\s+(?:table\s+)?(?:only\s+)?`,
  copy: String.raw`\bcopy\s+`,
};

/** Optional quoting and schema, then the table name. */
const tablePattern = (table: TicketTable) =>
  String.raw`(?:"?bakery"?\s*\.\s*)?"?${table}"?\b`;

/**
 * Source text as SQL would read it: adjacent string literals joined, whichever
 * quotes they use, and an escaped line break or tab turned into a space. Line
 * breaks are kept so reported line numbers stay right.
 */
function joinLiterals(code: string): string {
  return code
    .replace(/["'`]\s*\+\s*["'`]/g, (match) => match.replace(/[^\n]/g, ""))
    .replace(/\\[nrt]/g, " ");
}

function stripComments(source: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(
    /(^|[^:])\/\/[^\n]*/g,
    (match, lead: string) => lead + blank(match.slice(lead.length)),
  );
}

export type TicketWrite = {
  path: string;
  line: number;
  table: TicketTable;
  verb: Verb;
};

/** The statement an insert starts: up to the closing backtick or semicolon. */
const statementFrom = (code: string, index: number) =>
  code.slice(index, index + 4000).split(/[`;]/, 1)[0];

/**
 * Every write to a ticket table that `source` spells out. An insert that ends
 * in `on conflict ... do update` is also an update of its table.
 */
export function ticketWrites(path: string, source: string): TicketWrite[] {
  const code = joinLiterals(stripComments(source));
  const writes: TicketWrite[] = [];
  for (const table of TABLES) {
    for (const [verb, prefix] of Object.entries(verbs) as [Verb, string][]) {
      for (
        const match of code.matchAll(
          new RegExp(prefix + tablePattern(table), "gi"),
        )
      ) {
        const line = code.slice(0, match.index).split("\n").length;
        writes.push({ path, line, table, verb });
        if (
          verb === "insert" &&
          /\bon\s+conflict\b[\s\S]*\bdo\s+update\b/i.test(
            statementFrom(code, match.index),
          )
        ) {
          writes.push({ path, line, table, verb: "update" });
        }
      }
    }
  }
  return writes.sort((a, b) => a.line - b.line);
}

/** Whether the rail lets `write` be: an insert or update by an allowed file, and no update of a report. */
function permitted(write: TicketWrite): boolean {
  if (write.verb !== "insert" && write.verb !== "update") return false;
  if (write.table === "ticket_readiness_reports" && write.verb === "update") {
    return false;
  }
  return writers[write.table].has(write.path);
}

/** Writes of `source` the rail refuses, as `path:line verb table`. */
export function ticketWriteViolations(
  path: string,
  source: string,
): string[] {
  return ticketWrites(path, source).filter((write) => !permitted(write)).map((
    write,
  ) => `${write.path}:${write.line} ${write.verb} ${write.table}`);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) {
      if (!skipDirectories.has(entry.name)) {
        files.push(...await sourceFiles(path));
      }
    } else if (entry.isFile && sourceExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Test code that lives inside a production root: the three packages that keep
 * their tests beside their sources, and any file named as a test. A directory
 * that merely contains `test` or `tests` in its name is production code.
 */
const TEST_ROOTS = ["apps/web/tests/", "packages/ui/tests/", "ee/tests/"];

export function isTestPath(path: string): boolean {
  return TEST_ROOTS.some((root) => path.startsWith(root)) ||
    /[._]test\.[cm]?[jt]sx?$/.test(path);
}

/** Every production source file as [repository path, text], tests left out. */
async function productionSources(): Promise<[string, string][]> {
  const files: [string, string][] = [];
  for (const directory of productionRoots) {
    // The community build deletes ee/, so an absent root has nothing to scan.
    if (!await Deno.stat(join(root, directory)).then(() => true, () => false)) {
      continue;
    }
    for (const path of await sourceFiles(join(root, directory))) {
      const repositoryPath = relative(root, path);
      if (!isTestPath(repositoryPath)) {
        files.push([repositoryPath, await Deno.readTextFile(path)]);
      }
    }
  }
  assert(files.length > 0, "the rail scanned no production file");
  return files;
}

Deno.test("only the ticket store and the request and source commands write the ticket tables", async () => {
  const violations: string[] = [];
  for (const [path, source] of await productionSources()) {
    violations.push(...ticketWriteViolations(path, source));
  }
  assertEquals(violations, []);
});

Deno.test("ticket_readiness_reports is insert-only, even for the store", async () => {
  const updates: string[] = [];
  for (const [path, source] of await productionSources()) {
    for (const write of ticketWrites(path, source)) {
      if (
        write.table === "ticket_readiness_reports" && write.verb !== "insert"
      ) {
        updates.push(`${path}:${write.line} ${write.verb}`);
      }
    }
  }
  assertEquals(updates, []);
});

Deno.test("no source file deletes from, merges into, truncates or copies a ticket table", async () => {
  const forbidden: string[] = [];
  for (const [path, source] of await productionSources()) {
    for (const write of ticketWrites(path, source)) {
      if (write.verb !== "insert" && write.verb !== "update") {
        forbidden.push(`${path}:${write.line} ${write.verb} ${write.table}`);
      }
    }
  }
  assertEquals(forbidden, []);
});

Deno.test("each allowed writer still writes its tables", async () => {
  for (const table of TABLES) {
    for (const path of writers[table]) {
      const writes = ticketWrites(
        path,
        await Deno.readTextFile(join(root, path)),
      )
        .filter((write) => write.table === table && permitted(write));
      assert(
        writes.length > 0,
        `${path} no longer writes ${table}; remove it from the allowed list`,
      );
    }
  }
});

Deno.test("only real test code is exempt from the scan", () => {
  for (
    const path of [
      "apps/web/tests/helpers/seed.ts",
      "packages/ui/tests/a.test.ts",
      "ee/tests/integration/x.ts",
      "apps/server/src/modules/x/y_test.ts",
      "scripts/z.test.mjs",
    ]
  ) assert(isTestPath(path), path);
  for (
    const path of [
      "apps/server/src/test/writer.ts",
      "apps/server/src/modules/tests/writer.ts",
      "packages/persistence/src/__tests__/writer.ts",
      "scripts/tests/writer.ts",
      "apps/server/src/modules/work/ticket-store.ts",
    ]
  ) assert(!isTestPath(path), path);
});

const OTHER = "apps/server/src/modules/work/other.ts";

Deno.test("the detector sees a write split across lines, concatenated or escaped", () => {
  const writes = [
    'q("insert into " + "bakery.ticket_requests (id) values ($1)")',
    "q(`insert into ` +\n  'bakery.ticket_requests (id) values ($1)')",
    "q('insert into ' +\n    \"bakery\" + '.ticket_requests (id) values ($1)')",
    'q("update\\nbakery.ticket_requests set version = 1")',
    'q("delete from " +\n  "bakery." + "ticket_requests where true")',
  ];
  for (const source of writes) {
    assertEquals(ticketWrites(OTHER, source).length, 1, source);
  }
  // Line numbers survive the joining.
  assertEquals(
    ticketWrites(
      OTHER,
      'const a = 1;\nconst b = "insert into " +\n  "bakery.ticket_requests (id)";\n',
    ).map((write) => write.line),
    [2],
  );
  // Joining literals must not invent a write out of unrelated strings.
  assertEquals(
    ticketWrites(
      OTHER,
      'q("select 1 from " + "bakery.ticket_requests"); q("insert into " + "other")',
    ),
    [],
  );
});

Deno.test("the detector flags every write form on every ticket table and ignores reads and comments", () => {
  for (const table of TABLES) {
    const flagged: [string, Verb][] = [
      [`insert into bakery.${table} (id) values ($1)`, "insert"],
      [`INSERT INTO "bakery"."${table}" (id) values ($1)`, "insert"],
      [`insert\n  into ${table} (id) values ($1)`, "insert"],
      [`update bakery.${table} set version = 2`, "update"],
      [`update only bakery.${table} set version = 2`, "update"],
      [
        `with moved as (update bakery.${table} set version = 2) select 1`,
        "update",
      ],
      [`delete from bakery.${table} where id = $1`, "delete"],
      [`merge into bakery.${table} using x on true`, "merge"],
      [`truncate table bakery.${table}`, "truncate"],
      [`copy bakery.${table} from stdin`, "copy"],
    ];
    for (const [sql, verb] of flagged) {
      assertEquals(
        ticketWrites(OTHER, `await q(\`${sql}\`);`).map((write) => [
          write.table,
          write.verb,
        ]),
        [[table, verb]],
        sql,
      );
    }
    const clean = [
      `select * from bakery.${table} where id = $1`,
      `select id from bakery.${table}_archive`,
      `insert into bakery.${table}_archive (id) values ($1)`,
      `select id from bakery.${table} for update`,
      `update bakery.tasks set version = 2 from bakery.${table} where true`,
      `// insert into bakery.${table} (id) values ($1)`,
      `/* delete from bakery.${table} */`,
      `const line = 1; // update bakery.${table} set version = 2`,
    ];
    for (const source of clean) {
      assertEquals(ticketWrites(OTHER, source), [], source);
    }
  }
});

Deno.test("the rail lets the allowed writers insert and update their tables and refuses everything else", () => {
  const insert = "insert into bakery.ticket_requests (id) values ($1)";
  assertEquals(ticketWriteViolations(STORE, `q(\`${insert}\`)`), []);
  assertEquals(
    ticketWriteViolations(OTHER, `q(\`${insert}\`)`),
    [`${OTHER}:1 insert ticket_requests`],
  );
  // A door is per table: the request command writes links, not requests.
  assertEquals(
    ticketWriteViolations(
      REQUEST_COMMAND,
      "q(`insert into bakery.ticket_task_links (id) values ($1)`)",
    ),
    [],
  );
  assertEquals(
    ticketWriteViolations(REQUEST_COMMAND, `q(\`${insert}\`)`),
    [`${REQUEST_COMMAND}:1 insert ticket_requests`],
  );
  assertEquals(
    ticketWriteViolations(
      SOURCE_COMMAND,
      "q(`update bakery.ticket_sources set enabled = false`)",
    ),
    [],
  );
  // A delete is refused for the store as for anyone.
  assertEquals(
    ticketWriteViolations(STORE, "q(`delete from bakery.ticket_sources`)"),
    [`${STORE}:1 delete ticket_sources`],
  );
});

Deno.test("a readiness report is insert-only: an update, or an insert that updates on conflict, is refused for the store too", () => {
  const insert = "insert into bakery.ticket_readiness_reports (id) values ($1)";
  assertEquals(ticketWriteViolations(STORE, `q(\`${insert}\`)`), []);
  assertEquals(
    ticketWriteViolations(
      STORE,
      "q(`update bakery.ticket_readiness_reports set verdict = 'ready'`)",
    ),
    [`${STORE}:1 update ticket_readiness_reports`],
  );
  assertEquals(
    ticketWriteViolations(
      STORE,
      `q(\`${insert} on conflict (id) do update set verdict = 'ready'\`)`,
    ),
    [`${STORE}:1 update ticket_readiness_reports`],
  );
  // Another table may upsert in its own door; the conflict clause is read per statement.
  assertEquals(
    ticketWriteViolations(
      STORE,
      "q(`insert into bakery.external_tickets (id) values ($1) on conflict (id) do update set key = $2`)",
    ),
    [],
  );
  assertEquals(
    ticketWriteViolations(
      STORE,
      `q(\`${insert} on conflict (id) do nothing\`)`,
    ),
    [],
  );
});
