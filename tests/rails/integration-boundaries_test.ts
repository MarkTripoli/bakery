import { assert, assertEquals } from "@std/assert";
import {
  BOUNDARY_LEDGER_PATH,
  boundaryViolations,
  buildLedger,
  collectViolations,
  compareToLedger,
  ledgerKey,
  PROVIDER_PENDING,
  SERVER_REGISTRY,
  WEB_REGISTRY,
} from "../../scripts/check-integration-boundaries.ts";

const root = new URL("../..", import.meta.url).pathname;

type Case = {
  name: string;
  path: string;
  source: string;
  rules: readonly string[];
};

/**
 * One case per B1 rule, each written as the shortest source that expresses the
 * mistake. A rail whose cases all pass while the rule is broken is worse than no
 * rail, so every case names the rule it must produce.
 */
const cases: readonly Case[] = [
  {
    name: "a web file reaching server code by relative path",
    path: "apps/web/src/pages/x.ts",
    source: 'import { y } from "../../../server/src/app.ts";',
    rules: ["b1a"],
  },
  {
    name: "a web file importing a provider server entry",
    path: "apps/web/src/pages/x.ts",
    source: 'import { y } from "@bakery/integration-github/server";',
    rules: ["b1a", "b1b"],
  },
  {
    name: "a provider web file reaching server code",
    path: "packages/integration-github/src/web/mod.ts",
    source: 'import { y } from "../server/mod.ts";',
    rules: ["b1a"],
  },
  {
    name: "core importing a provider server entry outside the registry",
    path: "apps/server/src/modules/work/x.ts",
    source: 'import { y } from "@bakery/integration-github/server";',
    rules: ["b1b"],
  },
  {
    name: "a provider importing another provider",
    path: "packages/integration-github/src/server/mod.ts",
    source: 'import { y } from "@bakery/integration-slack/server";',
    rules: ["b1c"],
  },
  {
    name: "a relative import leaving its package",
    path: "packages/integration-github/src/server/mod.ts",
    source: 'import { y } from "../../../integration-sdk/mod.ts";',
    rules: ["b1d"],
  },
  {
    name: "a provider importing outside its allowlist",
    path: "packages/integration-github/src/server/mod.ts",
    source: 'import { y } from "@bakery/contracts/secret-identity";',
    rules: ["b1e"],
  },
  {
    name: "a provider importing the postgres driver",
    path: "packages/integration-github/src/server/mod.ts",
    source: 'import pg from "pg";',
    rules: ["b1e", "b1f"],
  },
  {
    name: "a provider calling bare fetch",
    path: "packages/integration-github/src/server/mod.ts",
    source: 'const response = await fetch("https://api.example.com");',
    rules: ["b1f"],
  },
  {
    name: "a provider reading Deno globals",
    path: "packages/integration-github/src/server/mod.ts",
    source: 'const key = Deno.env.get("SECRET");',
    rules: ["b1f"],
  },
  {
    name: "a provider reading process.env",
    path: "packages/integration-github/src/server/mod.ts",
    source: "const key = process.env.SECRET;",
    rules: ["b1f"],
  },
  {
    name: "a provider import of a node builtin",
    path: "packages/integration-github/src/server/mod.ts",
    source: 'import { readFile } from "node:fs/promises";',
    rules: ["b1f"],
  },
];

Deno.test("every B1 rule fires on the source that expresses it", () => {
  for (const testCase of cases) {
    const violations = boundaryViolations(testCase.path, testCase.source);
    const rules = new Set(violations.map((violation) => violation.rule));
    for (const rule of testCase.rules) {
      assert(
        rules.has(rule as never),
        `${testCase.name}: expected ${rule}, saw ${
          [...rules].join(",") || "nothing"
        }`,
      );
    }
  }
});

Deno.test("the registry files are the only allowed importer of provider entries", () => {
  const serverEntry = "@bakery/integration-github/server";
  assertEquals(
    boundaryViolations(SERVER_REGISTRY, `import x from "${serverEntry}";`)
      .filter((violation) => violation.rule === "b1b"),
    [],
  );
  assertEquals(
    boundaryViolations(
      WEB_REGISTRY,
      'import x from "@bakery/integration-github/web";',
    )
      .filter((violation) => violation.rule === "b1b"),
    [],
  );
  // One path away from the registry is already a violation, so the allowance is
  // about the file, not the directory.
  assert(
    boundaryViolations(
      "apps/server/src/modules/integrations/registry-copy.ts",
      `import x from "${serverEntry}";`,
    ).some((violation) => violation.rule === "b1b"),
  );
});

Deno.test("a provider package that follows the rules produces nothing", () => {
  const clean = [
    'import { defineServerProvider } from "@bakery/integration-sdk/provider";',
    'import type { ProviderManifest } from "@bakery/integration-sdk/provider";',
    'import { z } from "zod";',
    'import { providers } from "./providers.ts";',
  ].join("\n");
  assertEquals(
    boundaryViolations("packages/integration-github/src/server/mod.ts", clean),
    [],
  );
});

Deno.test("the definition tier may not reach the driver tier", () => {
  // The manifest is the one file three consumers share (gate, server, web), so a
  // driver import there would leak into the web bundle.
  for (
    const source of [
      'import pg from "pg";',
      "const key = process.env.SECRET;",
      'const response = await fetch("https://api.example.com");',
    ]
  ) {
    assert(
      boundaryViolations("packages/integration-github/src/manifest.ts", source)
            .length === 0 ||
        !source.includes("fetch"),
      `manifest.ts must not reach the driver tier: ${source}`,
    );
  }
});

Deno.test("a mention in a comment is not a violation", () => {
  const commented = [
    "// We used to import pg here; the host owns the driver now.",
    "/* fetch( was removed on purpose */",
    'import { z } from "zod";',
  ].join("\n");
  assertEquals(
    boundaryViolations(
      "packages/integration-github/src/server/mod.ts",
      commented,
    ),
    [],
  );
});

Deno.test("the ledger treats a new violation, a bigger one and a stale line differently", () => {
  const recorded = {
    schemaVersion: 1 as const,
    description: "",
    counts: { "b1f\tpackages/integration-github/src/server/mod.ts": 1 },
  };
  const one = boundaryViolations(
    "packages/integration-github/src/server/mod.ts",
    'const response = await fetch("https://api.example.com");',
  );
  // The same violation the ledger already records is not a regression.
  assertEquals(compareToLedger(one, recorded), {
    novel: [],
    stale: [],
    exceeded: [],
  });
  // The same violation twice is: the slice meant to remove coupling added more.
  const two = [...one, ...one];
  assertEquals(
    compareToLedger(two, recorded).exceeded.map((row) => row.allowed),
    [1],
  );
  // A violation in a file the ledger never recorded is a regression, however
  // small.
  const novel = boundaryViolations(
    "packages/integration-slack/src/server/mod.ts",
    'const response = await fetch("https://api.example.com");',
  );
  assertEquals(compareToLedger(novel, recorded).novel.length, 1);
  // And a ledger row with no violation left must be deleted, or a later slice
  // could re-add that coupling without the rail noticing.
  const empty = {
    schemaVersion: 1 as const,
    description: "",
    counts: { "b1f\tpackages/integration-github/src/server/mod.ts": 1 },
  };
  assertEquals(compareToLedger([], empty).stale, [
    "b1f\tpackages/integration-github/src/server/mod.ts",
  ]);
});

Deno.test("the ledger key is rule plus file so a count can only shrink", () => {
  const [violation] = boundaryViolations(
    "packages/integration-github/src/server/mod.ts",
    'const response = await fetch("https://api.example.com");',
  );
  assert(violation);
  assertEquals(
    ledgerKey(violation),
    "b1f\tpackages/integration-github/src/server/mod.ts",
  );
});

Deno.test("the committed ledger matches the tree and may only shrink", async () => {
  const ledgerText = await Deno.readTextFile(
    `${root}${BOUNDARY_LEDGER_PATH}`,
  );
  const ledger = JSON.parse(ledgerText) as ReturnType<typeof buildLedger>;
  assertEquals(ledger.schemaVersion, 1);
  const comparison = compareToLedger(await collectViolations(), ledger);
  // This is the ratchet. While slice 1 is report-only the rail still records the
  // truth: no new coupling, no grown coupling, and no stale line.
  assertEquals(
    comparison.novel.map((violation) => ledgerKey(violation)),
    [],
  );
  assertEquals(comparison.exceeded, []);
  assertEquals(comparison.stale, []);
});

Deno.test("the provider-pending list may only shrink", async () => {
  // Every entry must still exist. A lifted file disappears from this list, which
  // is a one-line deletion in the same PR as the lift; a file that vanished
  // without the list changing would mean the list is describing a tree that no
  // longer exists.
  for (const path of PROVIDER_PENDING) {
    const exists = await Deno.stat(`${root}${path}`).then(
      () => true,
      () => false,
    );
    assertEquals(
      exists,
      true,
      `${path} is listed as provider-pending but absent`,
    );
  }
  assertEquals(new Set(PROVIDER_PENDING).size, PROVIDER_PENDING.length);
});
