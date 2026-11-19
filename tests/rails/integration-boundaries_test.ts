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
    // The SDK is not a provider: every provider web module imports its `/web`
    // entry for the types it satisfies, and a rule that called that a coupling
    // would make the web tier impossible to write.
    name: "a provider web file importing the SDK's web entry",
    path: "packages/integration-github/src/web/mod.ts",
    source: 'import { defineWebProvider } from "@bakery/integration-sdk/web";',
    rules: [],
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

Deno.test("the ratchet fails from the command line, not only in process (QA finding)", async () => {
  // QA planted a stale ledger row and found the script printed the right message
  // and still exited 0: `--strict` was the only non-zero route and nothing in the
  // repo passed it, so the failure branch was dead code. The comparison and the
  // ledger were both correct while no exit code consumed them. This runs the real
  // command, because a test that only imports the comparison functions cannot see
  // that defect.
  //
  // The ledger is supplied as text through the environment rather than written to
  // disk: `test:rails` grants no write access, and a test should not need write
  // permission over the repository to observe an exit status.
  const root = new URL("../..", import.meta.url).pathname;
  const committed = await Deno.readTextFile(`${root}${BOUNDARY_LEDGER_PATH}`);
  const run = async (ledger: string, args: string[] = []) => {
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        `${root}scripts/check-integration-boundaries.ts`,
        ...args,
      ],
      env: { BAKERY_INTEGRATION_LEDGER_JSON: ledger },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: output.code,
      text: new TextDecoder().decode(output.stdout) +
        new TextDecoder().decode(output.stderr),
    };
  };
  // A stale row: debt the ledger records that the tree no longer has. This is the
  // direction that silently re-admits coupling a slice removed, so it must fail.
  const planted = JSON.stringify({
    ...JSON.parse(committed),
    counts: { "b1f\tpackages/integration-github/src/server/mod.ts": 5 },
  });

  const stale = await run(planted);
  assertEquals(stale.code, 1, "a stale ledger row must fail the command");
  assert(stale.text.includes("no longer exists"));

  // The committed ledger passes as-is.
  const clean = await run(committed);
  assertEquals(clean.code, 0, "the committed ledger must pass as-is");

  // The explicit opt-in is the only way to read a failing report without a
  // failure, and nothing in the repo calls it.
  const reportOnly = await run(planted, ["--report-only"]);
  assertEquals(reportOnly.code, 0);
  assert(reportOnly.text.includes("no longer exists"));
});

Deno.test("no script or workflow passes a mode that ignores a regression", async () => {
  // The defect QA found was not in the comparison, it was in the wiring: the
  // failing route existed and nothing called it. This pins the wiring from the
  // other side, so a future edit cannot quietly restore report-only as the
  // default used by CI.
  const root = new URL("../..", import.meta.url).pathname;
  const packageJson = JSON.parse(
    await Deno.readTextFile(`${root}package.json`),
  ) as { scripts: Record<string, string> };
  for (
    const script of ["rails:integration-boundaries", "rails:provider-literals"]
  ) {
    const command = packageJson.scripts[script];
    assert(command, `package.json has no ${script} script`);
    assertEquals(
      command.includes("--report-only"),
      false,
      `${script} must not opt out of failing on a regression`,
    );
    // A script that reads the environment needs --allow-env, and the flag has to
    // be present in the command rather than assumed: B1 accepts a ledger through
    // BAKERY_INTEGRATION_LEDGER_JSON, and omitting the flag made the command
    // throw instead of report. Only the scripts that read it are held to this.
    const source = await Deno.readTextFile(
      `${root}scripts/${script.replace("rails:", "")}.ts`.replace(
        "integration-boundaries",
        "check-integration-boundaries",
      ).replace("provider-literals", "check-provider-literals"),
    );
    if (source.includes("Deno.env")) {
      assert(
        command.includes("--allow-env"),
        `${script} reads Deno.env and needs --allow-env`,
      );
    }
  }
  // And the CI job runs both, not just the test lane that proves the comparison.
  const workflow = await Deno.readTextFile(
    `${root}.github/workflows/ci.yml`,
  );
  const railsJob = /rails:\n[\s\S]*?\n {2}\w/.exec(workflow)?.[0] ?? "";
  for (
    const script of ["rails:integration-boundaries", "rails:provider-literals"]
  ) {
    assert(
      railsJob.includes(`pnpm ${script}`),
      `the backend rails job must run pnpm ${script}`,
    );
  }
});
