/**
 * #47 AC2 against the real source: a required route cannot be stubbed or
 * disabled, and a required test cannot be ignored or conditionally skipped,
 * without the coverage rails failing. A skip is allowed only for a test file
 * the ledger names with its reason.
 */

import { assert, assertEquals } from "@std/assert";
import {
  loadLedger,
  serverSources,
  testSources,
} from "../helpers/operation-coverage-tree.ts";
import {
  findStubs,
  findUnlistedSkips,
  withoutComments,
} from "../helpers/operation-coverage.ts";

Deno.test("AC2: no server source stubs a route out", () => {
  assertEquals(findStubs(serverSources()), []);
});

Deno.test("AC2: no test file ignores or skips a test unless the ledger names it with a reason", () => {
  assertEquals(
    findUnlistedSkips(testSources(), loadLedger().conditionalSkips),
    [],
  );
});

Deno.test("AC2: every listed conditional skip carries a plain reason", () => {
  const skips = Object.entries(loadLedger().conditionalSkips);
  assert(skips.length > 0, "the ledger lists no conditional skip");
  for (const [path, skip] of skips) {
    assert(skip.reason.trim().length > 20, path + " needs a plain reason");
  }
});

Deno.test("AC2: a stubbed route is found in any of its usual shapes", () => {
  for (
    const [name, text] of [
      ["501", 'app.post("/v1/x", (c) => c.json({}, 501));'],
      ["status 501", "return new Response(null, { status: 501 });"],
      [
        "NOT_IMPLEMENTED",
        'throw new StandardError({ code: "NOT_IMPLEMENTED" });',
      ],
      ["notImplemented", "return notImplemented(c);"],
      ["throw", 'throw new Error("not yet implemented");'],
      ["TODO", "// TODO: wire the real handler"],
    ] as const
  ) {
    assertEquals(
      findStubs({ "apps/server/src/x.ts": text }).length,
      1,
      name + " should be found",
    );
  }
});

Deno.test("AC2: ordinary words are not mistaken for a stub", () => {
  assertEquals(
    findStubs({
      "apps/server/src/ok.ts":
        'const code = 0x501; // the 501 in a comment is prose\nthrow new Error("not found");',
    }),
    [],
  );
});

Deno.test("AC2: an ignored or conditionally skipped test is found, and a listed one is allowed", () => {
  const allowed = {
    "tests/a_test.ts": {
      reason: "Needs a real provider login that CI never has.",
    },
  };
  // The skip words are spelled out of pieces so this file does not trip its own scan.
  const k = "ign" + "ore";
  for (
    const text of [
      `Deno.test({ name: "x", ${k}: true, fn() {} });`,
      `Deno.test({ name: "x", ${k}: !ready, fn() {} });`,
      `Deno.test.${k}("x", () => {});`,
      `Deno.test({\n  name: "x",\n  ${k}: Deno.env.get("CI") === "1",\n  fn() {},\n});`,
    ]
  ) {
    assertEquals(
      findUnlistedSkips({ "tests/b_test.ts": text }, {}).length,
      1,
      text,
    );
    assertEquals(findUnlistedSkips({ "tests/a_test.ts": text }, allowed), []);
  }
});

Deno.test("AC2: a plain test, and a regex that mentions ignore, are not skips", () => {
  assertEquals(
    findUnlistedSkips(
      {
        "tests/c_test.ts":
          'Deno.test("x", () => {});\nassert(/ignore:\\s*ready/.test(source));',
      },
      {},
    ),
    [],
  );
});

Deno.test("AC2: a listed skip that no longer skips, or a listed file that is gone, is stale", () => {
  const allowed = {
    "tests/a_test.ts": {
      reason: "Needs a real provider login that CI never has.",
    },
  };
  assertEquals(
    findUnlistedSkips(
      { "tests/a_test.ts": 'Deno.test("x", () => {});' },
      allowed,
    ).length,
    1,
  );
  assertEquals(findUnlistedSkips({}, allowed).length, 1);
});

Deno.test("AC2: commented-out code counts for nothing", () => {
  assertEquals(
    withoutComments('const a = 1; // app.get("/x")\n/* app.get("/y") */'),
    "const a = 1; \n",
  );
});
