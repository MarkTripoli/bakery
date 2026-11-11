import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  assertStructuralMigration,
  migrationRoots,
  splitStatements,
} from "../../scripts/lib/postgresql-boundary.ts";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const grandfatheredMigrations = new Map<string, string>([
  [
    "apps/server/src/platform/migrations/0001_platform_bootstrap.sql",
    "b632153f7fd32d306cc1be3cf8cffea3ce673ed753c2cec521a312ea8162816a",
  ],
  [
    "apps/server/src/modules/auth/migrations/provider/0001_better_auth.sql",
    "6fa31a9188826db5b531e6c03d8253e4493718e5007c6287d2b417200f60598d",
  ],
  [
    "apps/server/src/modules/auth/migrations/provider/0002_application_grants.sql",
    "3b2386b98bbf26c43cdc5e8bfb49de158e698ed5f218478d621c1637f88d73f6",
  ],
  [
    "apps/server/src/modules/auth/migrations/provider/0003_bakery_authority_columns.sql",
    "a54b959cffdb7fa4ee7548e92b6b78981b6d38acbbf5818a89a003e3470ce624",
  ],
  [
    "apps/server/src/modules/auth/migrations/bakery/0002_auth_principals.sql",
    "48b5d2aaf7ca4a9416645f3939a991b34ee42b0ab6bf770d630cf8497636a8aa",
  ],
  [
    "apps/server/src/modules/auth/migrations/bakery/0003_live_tenant_authority.sql",
    "3533cf6439e1707f4f6a9603e40005e71b3ad56c7f93cfb31dbf5fdcab073e06",
  ],
  [
    "apps/server/src/modules/auth/migrations/bakery/0005_canonical_lifecycle.sql",
    "32fbc49ec4b879107039bda28cf1b1a339130adb411894e39fba883b9f7f9330",
  ],
  [
    "apps/server/src/modules/auth/migrations/bakery/0007_canonical_lifecycle_mutations.sql",
    "6648b8235643cf0bb497b17f68655321966a78361f5bc5811d5d2cb0330ac77d",
  ],
  [
    "apps/server/src/modules/work/migrations/bakery/0008_task_command_replay.sql",
    "ce1063c0fbc2fc046458030ba0c5abf25b8434a309e1b01efbcd69bb2a38d152",
  ],
]);

async function checksum(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function listSqlFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) files.push(...await listSqlFiles(path));
    else if (entry.isFile && entry.name.endsWith(".sql")) files.push(path);
  }
  return files.sort();
}

Deno.test("new Bakery migrations contain structural PostgreSQL statements only", async () => {
  const paths: string[] = [];
  for (const migrationRoot of migrationRoots) {
    paths.push(...await listSqlFiles(`${root}${migrationRoot}`));
  }
  assert(
    paths.length > grandfatheredMigrations.size,
    "expected governed Bakery migrations",
  );
  for (const path of paths) {
    const relativePath = path.slice(root.length);
    const sql = await Deno.readTextFile(path);
    const historicalChecksum = grandfatheredMigrations.get(relativePath);
    if (historicalChecksum) {
      assertEquals(
        await checksum(sql),
        historicalChecksum,
        `${relativePath} historical checksum`,
      );
      continue;
    }
    assertStructuralMigration(relativePath, sql);
  }
});

Deno.test("PostgreSQL boundary rail rejects business behavior", () => {
  for (
    const sql of [
      "update bakery.outbox set status = 'failed';",
      "select 1; delete from bakery.outbox;",
      "merge into bakery.outbox using source on false when not matched then insert default values;",
      "truncate bakery.outbox;",
      "copy bakery.outbox from stdin;",
      "alter table bakery.outbox add constraint valid_state check (true);",
      "create procedure bakery.transition() language sql as $$ select 1 $$;",
      "create trigger transition before update on bakery.outbox execute function bakery.transition();",
      "create table bakery.snapshot as select * from bakery.outbox;",
    ]
  ) {
    assertThrows(
      () => assertStructuralMigration("tests/fixtures/business.sql", sql),
      Error,
      "POSTGRESQL_BOUNDARY_VIOLATION",
    );
  }
});

Deno.test("PostgreSQL boundary rail preserves dollar-quoted statements", () => {
  const procedural =
    "do $$ begin if exists (select 1 from t) then raise exception 'x'; end if; end $$;";
  assertEquals(splitStatements(procedural), [procedural.slice(0, -1)]);
  const proceduralError = assertThrows(
    () =>
      assertStructuralMigration("tests/fixtures/procedural.sql", procedural),
    Error,
    "POSTGRESQL_BOUNDARY_VIOLATION",
  );
  assert(
    proceduralError.message.endsWith("runs a procedural block"),
    proceduralError.message,
  );

  const routine =
    "create function f() returns void language plpgsql as $body$ begin update t set a = 1; end $body$;";
  assertEquals(splitStatements(routine), [routine.slice(0, -1)]);
  const routineError = assertThrows(
    () => assertStructuralMigration("tests/fixtures/routine.sql", routine),
    Error,
    "POSTGRESQL_BOUNDARY_VIOLATION",
  );
  assert(
    routineError.message.endsWith("defines a stored routine"),
    routineError.message,
  );
});

Deno.test("PostgreSQL boundary rail masks single-quoted literals", () => {
  const comment =
    "comment on column bakery.notes.kind is 'legacy check (do not remove)';";
  const index =
    "create index concurrently notes_kind_idx on bakery.notes (kind) where kind <> 'check (';";
  const defaultValue =
    "alter table bakery.notes add column note text default 'a;b';";
  for (const sql of [comment, index, defaultValue]) {
    assertStructuralMigration("tests/fixtures/structural.sql", sql);
  }
  assertEquals(splitStatements(defaultValue), [defaultValue.slice(0, -1)]);
});

Deno.test("PostgreSQL boundary rail rejects query-time execution", () => {
  for (
    const { sql, behavior } of [
      {
        sql: "refresh materialized view bakery.stats;",
        behavior: "refreshes a materialized view",
      },
      {
        sql: "select bakery.rebuild_stats();",
        behavior: "executes a query or routine at migration time",
      },
    ]
  ) {
    const error = assertThrows(
      () => assertStructuralMigration("tests/fixtures/query.sql", sql),
      Error,
      "POSTGRESQL_BOUNDARY_VIOLATION",
    );
    assert(error.message.endsWith(behavior), error.message);
  }
});

Deno.test("PostgreSQL boundary rail handles escape strings", () => {
  const dataAfterEscapedQuote =
    "comment on table t is E'\\''; delete from t; --';";
  assertEquals(splitStatements(dataAfterEscapedQuote).length, 2);
  const dataError = assertThrows(
    () =>
      assertStructuralMigration(
        "tests/fixtures/escaped-quote.sql",
        dataAfterEscapedQuote,
      ),
    Error,
    "POSTGRESQL_BOUNDARY_VIOLATION",
  );
  assert(dataError.message.endsWith("changes data"), dataError.message);

  const checkWithEscapedQuote =
    "alter table t add column c text default E'\\'', add constraint k check (c <> '');";
  const checkError = assertThrows(
    () =>
      assertStructuralMigration(
        "tests/fixtures/escaped-check.sql",
        checkWithEscapedQuote,
      ),
    Error,
    "POSTGRESQL_BOUNDARY_VIOLATION",
  );
  assert(
    checkError.message.endsWith("defines a CHECK constraint"),
    checkError.message,
  );

  const checkAndData =
    "create table t (a text default E'it\\'s', b int check (b > 0)); delete from t;";
  assertThrows(
    () =>
      assertStructuralMigration(
        "tests/fixtures/escaped-check-and-data.sql",
        checkAndData,
      ),
    Error,
    "POSTGRESQL_BOUNDARY_VIOLATION",
  );
});

Deno.test("PostgreSQL boundary rail follows PostgreSQL lexing for comments, continued literals, and non-ASCII dollar tags", () => {
  const rejectedWith = (path: string, sql: string, behavior: string) => {
    const error = assertThrows(
      () => assertStructuralMigration(path, sql),
      Error,
      "POSTGRESQL_BOUNDARY_VIOLATION",
    );
    assert(error.message.endsWith(behavior), error.message);
  };

  // A bare carriage return ends a line comment, so the DELETE executes.
  rejectedWith(
    "tests/fixtures/cr-comment.sql",
    "create table t (a int); -- comment\rdelete from t;",
    "changes data",
  );

  // Adjacent quoted chunks separated by a newline are one literal that keeps
  // the E'' mode, so the second chunk's \' is an escaped quote, not a close.
  const continuedEscape =
    "create table t (a text default E'first'\n  'it\\'s', b int check (b > 0)); delete from t; --'";
  assertEquals(splitStatements(continuedEscape).length, 2);
  rejectedWith(
    "tests/fixtures/continued-escape.sql",
    continuedEscape,
    "defines a CHECK constraint",
  );
  // Continuation may span a line comment; the literal still closes normally.
  assertStructuralMigration(
    "tests/fixtures/continued-literal.sql",
    "comment on column t.a is 'costs; check ('\n  -- continued\n  ' more';",
  );
  // Same chunks on ONE line are two literals (a syntax error in PostgreSQL),
  // and nothing after them may be hidden.
  rejectedWith(
    "tests/fixtures/adjacent-literals.sql",
    "comment on column t.a is 'x' 'y'; delete from t;",
    "changes data",
  );

  // Non-ASCII dollar tags are real dollar quotes.
  rejectedWith(
    "tests/fixtures/unicode-dollar.sql",
    "create table t (a text default $é$'$é$, b int check (b > 0)); delete from t; --'",
    "defines a CHECK constraint",
  );
  // Dollar bodies are deliberately left unmasked, so the control avoids
  // forbidden keywords; it proves the quote and `;` inside the body are inert.
  const unicodeBody = "comment on column t.a is $é$'; delete from t;$é$;";
  assertEquals(splitStatements(unicodeBody).length, 1);
  assertStructuralMigration(
    "tests/fixtures/unicode-dollar-ok.sql",
    unicodeBody,
  );
});

Deno.test("PostgreSQL boundary rail closes the verifier's bypass set", () => {
  const rejectedWith = (path: string, sql: string, behavior: string) => {
    const error = assertThrows(
      () => assertStructuralMigration(path, sql),
      Error,
      "POSTGRESQL_BOUNDARY_VIOLATION",
    );
    assert(error.message.endsWith(behavior), error.message);
  };

  // Quote continuation where the line comment comes BEFORE the newline
  // (scan.l: non_newline_whitespace includes {comment}); E'' mode persists.
  for (const newline of ["\n", "\r"]) {
    const sql =
      `comment on table t is E'a' -- c${newline}'\\''; delete from t; --';`;
    assertEquals(splitStatements(sql).length, 2, JSON.stringify(sql));
    rejectedWith(
      "tests/fixtures/continuation-comment.sql",
      sql,
      "changes data",
    );
  }

  for (
    const { sql, behavior } of [
      {
        sql:
          "create or replace trigger tr before update on t for each row execute function f();",
        behavior: "defines a trigger",
      },
      {
        sql:
          "create or replace constraint trigger tr after insert on t deferrable for each row execute function f();",
        behavior: "defines a trigger",
      },
      {
        sql: "(select bakery.rebuild_stats());",
        behavior: "executes a query or routine at migration time",
      },
      {
        sql: "with x as (select 1) select bakery.rebuild_stats() from x;",
        behavior: "executes a query or routine at migration time",
      },
      {
        sql: "declare c cursor for select bakery.rebuild_stats();",
        behavior: "executes a query or routine at migration time",
      },
      {
        sql: "table bakery.outbox;",
        behavior: "executes a query or routine at migration time",
      },
      {
        sql: "notify bakery_events, 'migrated';",
        behavior: "executes a query or routine at migration time",
      },
      {
        sql: "create table bakery.snapshot as (select * from bakery.outbox);",
        behavior: "materializes query results",
      },
      {
        sql: "create table bakery.snapshot as table bakery.outbox;",
        behavior: "materializes query results",
      },
      {
        sql: "create table bakery.seed as values (1, 'a'), (2, 'b');",
        behavior: "materializes query results",
      },
      {
        sql:
          "create global temporary table snap as select * from bakery.outbox;",
        behavior: "materializes query results",
      },
      {
        sql: "create table snap as execute p;",
        behavior: "materializes query results",
      },
      {
        sql: "create table snap as ((select * from bakery.outbox));",
        behavior: "materializes query results",
      },
      {
        sql: "create table snap as (\n  ( table bakery.outbox )\n);",
        behavior: "materializes query results",
      },
      {
        sql: "create temp recursive view v (n) as select 1;",
        behavior: "defines a view",
      },
      {
        sql: "fetch all from c;",
        behavior: "executes a query or routine at migration time",
      },
      {
        sql: "alter table bakery.outbox disable trigger all;",
        behavior: "toggles a trigger or rule",
      },
      {
        sql: "alter table bakery.outbox enable always trigger audit_outbox;",
        behavior: "toggles a trigger or rule",
      },
      {
        sql: "alter table bakery.outbox disable rule protect_outbox;",
        behavior: "toggles a trigger or rule",
      },
      {
        sql:
          "create recursive view bakery.seq (n) as select 1 union all select n + 1 from bakery.seq where n < 10;",
        behavior: "defines a view",
      },
    ]
  ) {
    rejectedWith("tests/fixtures/verifier-bypass.sql", sql, behavior);
  }

  // Structural statements that graze the widened patterns stay accepted.
  for (
    const sql of [
      "create table t (as_of timestamptz not null, with_flag boolean);",
      "create index i on t (a) where a is not null;",
      "alter table t add column note text default 'as select';",
    ]
  ) {
    assertStructuralMigration("tests/fixtures/verifier-ok.sql", sql);
  }
});

Deno.test("PostgreSQL boundary rail re-tokenizes statements with the same boundaries and rejects configuration changes", () => {
  const rejectedWith = (path: string, sql: string, behavior: string) => {
    const error = assertThrows(
      () => assertStructuralMigration(path, sql),
      Error,
      "POSTGRESQL_BOUNDARY_VIOLATION",
    );
    assert(error.message.endsWith(behavior), error.message);
  };

  // A comment between `default` and `E'…'` must stay a token boundary when the
  // split statement is tokenized again; otherwise `defaultE'…'` lexes as a
  // plain string and the real CHECK hides inside the masked literal.
  rejectedWith(
    "tests/fixtures/comment-boundary.sql",
    "alter table t add column c text default/*c*/E'\\'\"\\'\"x', add constraint k check (c > 0), add column d text default 'z', add column e text default/*c*/E'\\'', add column f int;",
    "defines a CHECK constraint",
  );

  // Turning standard_conforming_strings off (at any scope) would change how
  // every later literal lexes, so configuration statements are never structural.
  for (
    const sql of [
      "set standard_conforming_strings = off;",
      "reset standard_conforming_strings;",
      "alter database bakery set standard_conforming_strings = off;",
      "alter role bakery_app set search_path = bakery;",
      "alter system set work_mem = '64MB';",
    ]
  ) {
    rejectedWith(
      "tests/fixtures/configuration.sql",
      sql,
      "changes session or cluster configuration",
    );
  }
  // `set` inside a routine head is still caught by the routine rule, and a
  // column named `settings` is not a SET statement.
  assertStructuralMigration(
    "tests/fixtures/settings-column.sql",
    "alter table t add column settings jsonb not null default '{}';",
  );
});

Deno.test("PostgreSQL boundary rail respects identifier dollar signs", () => {
  const indexedIdentifier =
    "create index i1 on t (col$x$);\ndelete from t;\ncreate index i2 on t (col$x$);";
  assertEquals(splitStatements(indexedIdentifier).length, 3);
  const indexedError = assertThrows(
    () =>
      assertStructuralMigration(
        "tests/fixtures/identifier-dollar.sql",
        indexedIdentifier,
      ),
    Error,
    "POSTGRESQL_BOUNDARY_VIOLATION",
  );
  assert(indexedError.message.endsWith("changes data"), indexedError.message);

  const tableIdentifier = "create table t$tag$ (a int); delete from t$tag$;";
  const tableError = assertThrows(
    () =>
      assertStructuralMigration(
        "tests/fixtures/tagged-identifier.sql",
        tableIdentifier,
      ),
    Error,
    "POSTGRESQL_BOUNDARY_VIOLATION",
  );
  assert(tableError.message.endsWith("changes data"), tableError.message);

  const quotedIdentifier =
    'create table "t\'" (a int check (a > 0)); delete from "t\'";';
  const quotedError = assertThrows(
    () =>
      assertStructuralMigration(
        "tests/fixtures/quoted-identifier.sql",
        quotedIdentifier,
      ),
    Error,
    "POSTGRESQL_BOUNDARY_VIOLATION",
  );
  assert(
    quotedError.message.endsWith("defines a CHECK constraint"),
    quotedError.message,
  );
});

Deno.test("PostgreSQL boundary rail handles nested and unterminated syntax", () => {
  const nestedComment =
    "create table t (a int /* outer /* inner */ ' */); delete from t;";
  const nestedError = assertThrows(
    () =>
      assertStructuralMigration(
        "tests/fixtures/nested-comment.sql",
        nestedComment,
      ),
    Error,
    "POSTGRESQL_BOUNDARY_VIOLATION",
  );
  assert(nestedError.message.endsWith("changes data"), nestedError.message);

  for (
    const sql of [
      "create table t (a text default 'oops); delete from t;",
      "comment on table t is $one$x$two$; delete from t;",
    ]
  ) {
    assertThrows(
      () => assertStructuralMigration("tests/fixtures/unterminated.sql", sql),
      Error,
      "POSTGRESQL_BOUNDARY_VIOLATION",
    );
  }
});

Deno.test("PostgreSQL boundary rail rejects procedural and wrapped execution", () => {
  const procedural = "do language plpgsql $$ begin delete from t; end $$;";
  const proceduralError = assertThrows(
    () =>
      assertStructuralMigration(
        "tests/fixtures/language-procedural.sql",
        procedural,
      ),
    Error,
    "POSTGRESQL_BOUNDARY_VIOLATION",
  );
  assert(
    proceduralError.message.endsWith("runs a procedural block"),
    proceduralError.message,
  );

  for (
    const { sql, behavior } of [
      {
        sql: "explain analyze delete from t;",
        behavior: "executes a query or routine at migration time",
      },
      {
        sql:
          "create constraint trigger tr after insert on t for each row execute function f();",
        behavior: "defines a trigger",
      },
    ]
  ) {
    const error = assertThrows(
      () => assertStructuralMigration("tests/fixtures/wrapped.sql", sql),
      Error,
      "POSTGRESQL_BOUNDARY_VIOLATION",
    );
    assert(error.message.endsWith(behavior), error.message);
  }
});

Deno.test("PostgreSQL boundary rail preserves safe dollar and quoted syntax", () => {
  const safeIndex = "create index i on t (a) where a <> '$1';";
  const safeComment = "comment on column t.a is 'costs $5';";
  const weirdIdentifier = 'create table "weird;name" (a int);';
  for (const sql of [safeIndex, safeComment, weirdIdentifier]) {
    assertStructuralMigration("tests/fixtures/safe-syntax.sql", sql);
  }
  assertEquals(splitStatements(weirdIdentifier), [
    weirdIdentifier.slice(0, -1),
  ]);
});

const approvedFunction = await Deno.readTextFile(
  `${root}apps/server/src/modules/auth/migrations/bakery/0080_set_installation_license_function.sql`,
);
const approvedStatement = splitStatements(approvedFunction)[0];

Deno.test("PostgreSQL boundary rail admits the real licence function and nothing smuggled into it", () => {
  assertStructuralMigration("0080.sql", approvedFunction);
  const reject = (sql: string, note: string) =>
    assertThrows(
      () => assertStructuralMigration(`tests/fixtures/${note}.sql`, sql),
      Error,
      "POSTGRESQL_BOUNDARY_VIOLATION",
    );
  const header = approvedStatement.slice(0, approvedStatement.indexOf("$$"));
  reject(
    approvedStatement.replace("security definer\n", ""),
    "no-definer",
  );
  reject(
    approvedStatement.replace(/set search_path = [^\n]*\n/, ""),
    "no-search-path",
  );
  reject(
    approvedStatement.replace(
      "pg_catalog, bakery, pg_temp",
      "pg_catalog, bakery",
    ),
    "search-path-without-pg-temp",
  );
  reject(
    approvedStatement.replaceAll("set_installation_license", "set_anything"),
    "other-name",
  );
  // The markers only in the body or a comment, not in the header.
  reject(
    `create function bakery.set_installation_license(new_key text, expected_version integer, updater uuid) returns integer language sql as $$ select 1 -- security definer set search_path = pg_catalog, bakery, pg_temp
$$`,
    "marker-in-body-comment",
  );
  reject(
    `${
      header.replace("security definer\n", "").replace(
        /set search_path = [^\n]*\n/,
        "",
      )
    }$$ select 'security definer set search_path = pg_catalog, bakery, pg_temp' $$`,
    "marker-in-body-string",
  );
  reject(
    `/* security definer set search_path = pg_catalog, bakery, pg_temp */ ${
      header.replace("security definer\n", "").replace(
        /set search_path = [^\n]*\n/,
        "",
      )
    }$$ select 1 $$`,
    "marker-in-header-comment",
  );
  // Extra work smuggled into the body of an otherwise exact header.
  for (
    const extra of [
      "; create trigger t before update on bakery.outbox execute function bakery.f()",
      "; alter role bakery_app superuser",
      "; delete from bakery.audit_events",
    ]
  ) {
    reject(
      approvedStatement.replace(
        "returning version",
        `returning version${extra}`,
      ) + ";",
      "smuggled-body",
    );
  }
  // Wrong signature, including an overload with an extra argument.
  reject(
    approvedStatement.replace("updater uuid", "updater uuid, extra text"),
    "overload",
  );
  reject(
    approvedStatement.replace("new_key text", "new_key varchar"),
    "wrong-type",
  );
});

const purgeFunction = await Deno.readTextFile(
  `${root}apps/server/src/modules/auth/migrations/bakery/0090_audit_retention.sql`,
);
const purgeStatement = splitStatements(purgeFunction).find((statement) =>
  /^create\s+function\b/i.test(statement.trim())
)!;

Deno.test("PostgreSQL boundary rail admits the real audit purge function and nothing smuggled into it", () => {
  assertStructuralMigration("0090.sql", purgeFunction);
  const reject = (sql: string, note: string) =>
    assertThrows(
      () => assertStructuralMigration(`tests/fixtures/${note}.sql`, sql),
      Error,
      "POSTGRESQL_BOUNDARY_VIOLATION",
    );
  const header = purgeStatement.slice(0, purgeStatement.indexOf("$$"));
  reject(purgeStatement.replace("security definer\n", ""), "purge-no-definer");
  reject(
    purgeStatement.replace(/set search_path = [^\n]*\n/, ""),
    "purge-no-search-path",
  );
  reject(
    purgeStatement.replace(
      "pg_catalog, bakery, pg_temp",
      "pg_catalog, bakery",
    ),
    "purge-search-path-without-pg-temp",
  );
  reject(
    purgeStatement.replace(
      "pg_catalog, bakery, pg_temp",
      "pg_temp, pg_catalog, bakery",
    ),
    "purge-pg-temp-not-last",
  );
  reject(
    purgeStatement.replaceAll("purge_audit_events", "purge_anything"),
    "purge-other-name",
  );
  // The markers only in the body or a comment, not in the header.
  reject(
    `${
      header.replace("security definer\n", "").replace(
        /set search_path = [^\n]*\n/,
        "",
      )
    }$$ select 'security definer set search_path = pg_catalog, bakery, pg_temp' $$`,
    "purge-marker-in-body-string",
  );
  // Extra work smuggled into the body of an otherwise exact header.
  for (
    const extra of [
      "; alter role bakery_app superuser",
      "; delete from bakery.domain_events",
      "; drop table bakery.audit_events",
    ]
  ) {
    reject(
      purgeStatement.replace("return purged;", `return purged${extra};`) + ";",
      "purge-smuggled-body",
    );
  }
  // A weakened body: the cutoff floor or the evidence guard removed.
  reject(
    purgeStatement.replace(
      "if p_before > now() - interval '30 days' then\n    return 0;\n  end if;\n",
      "",
    ),
    "purge-no-floor",
  );
  reject(
    purgeStatement.replace(
      /and not exists \([\s\S]*?\)\s+order by/,
      "order by",
    ),
    "purge-no-evidence-guard",
  );
  // Wrong signature, including an overload with an extra argument.
  reject(
    purgeStatement.replace("p_max_rows integer", "p_max_rows integer, x text"),
    "purge-overload",
  );
  reject(
    purgeStatement.replace("p_before timestamptz", "p_before timestamp"),
    "purge-wrong-type",
  );
});
