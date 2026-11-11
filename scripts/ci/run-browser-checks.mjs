import { appendFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import {
  readBrowserSelection,
  retainExistingConsumers,
} from "./browser-selection.mjs";
import { browserCommands, readBrowserShard } from "./browser-plan.mjs";
import { browserCore, coreListingIssues } from "./browser-core.mjs";

const lane = process.argv[2];
if (lane !== "web" && lane !== "storybook") {
  throw new Error("Expected web or storybook browser lane");
}
const planOnly = process.argv.includes("--plan");
const shard = lane === "web" ? readBrowserShard() : null;
const selection = retainExistingConsumers(
  readBrowserSelection(),
  (spec) => existsSync(`apps/web/tests/${spec}`),
);
console.log(`browser selection: ${JSON.stringify(selection)}`);
if (shard) console.log(`browser shard: ${JSON.stringify(shard)}`);
const commands = browserCommands(lane, selection, shard);

if (planOnly) {
  // Lets the workflow skip a shard's expensive setup when it has no work.
  const line = `work=${commands.length > 0}`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  }
  process.exit(0);
}

function playwright(packageDir, args, env, stdio) {
  return spawnSync("pnpm", [
    "--dir",
    packageDir,
    "exec",
    "playwright",
    "test",
    ...args,
  ], {
    stdio,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
}

function collectListed(node, tests) {
  for (const spec of node.specs ?? []) {
    for (const test of spec.tests) {
      tests.push({
        project: test.projectName,
        file: basename(spec.file),
        title: spec.title,
      });
    }
  }
  for (const child of node.suites ?? []) collectListed(child, tests);
}

// A shard sees only its slice, so prove against the unsharded list that every
// core case exists exactly once before any slice runs.
function assertCoreListed(packageDir) {
  const result = playwright(
    packageDir,
    ["--list", "--reporter=json"],
    {
      BAKERY_BROWSER_MODE: "full",
      BAKERY_BROWSER_REQUIRE_CORE: "0",
      BAKERY_BROWSER_SPECS: "[]",
    },
    ["ignore", "pipe", "inherit"],
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const listed = [];
  collectListed({ suites: JSON.parse(result.stdout).suites }, listed);
  const issues = coreListingIssues(listed);
  for (const issue of issues) console.error(`browser core: ${issue}`);
  if (issues.length) process.exit(1);
  console.log(
    `browser core: ${browserCore.length} core cases each listed once in ${listed.length} tests`,
  );
}

// Same admin the unsharded run seeds in `auth-journey.spec.ts` `beforeAll`
// (shared by every shared-admin spec); same script, same defaults.
function seedBootstrapAdmin() {
  const email = process.env.BAKERY_REAL_EMAIL?.trim().toLowerCase() ||
    (process.env.BAKERY_ENV === "test" ? "browser-admin@example.test" : "");
  const password = process.env.BAKERY_REAL_PASSWORD ||
    (process.env.BAKERY_ENV === "test" ? "Browser-Admin-Passw0rd-1" : "");
  if (!email || !password) {
    throw new Error("Cannot seed the bootstrap admin without credentials");
  }
  const result = spawnSync("deno", [
    "run",
    "--allow-env",
    "--allow-net",
    "--allow-read",
    "tests/helpers/web-auth-seed.ts",
    email,
  ], {
    stdio: "inherit",
    env: { ...process.env, WEB_AUTH_SEED_PASSWORD: password },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function run(
  { packageDir, mode, requireCore, presentOnly, projects, shard: slice },
) {
  const start = performance.now();
  const args = [
    ...(projects ?? []).flatMap((project) => ["--project", project]),
    ...(slice ? [`--shard=${slice}`] : []),
  ];
  const result = playwright(packageDir, args, {
    BAKERY_BROWSER_MODE: mode,
    BAKERY_BROWSER_REQUIRE_CORE: requireCore ? "1" : "0",
    BAKERY_BROWSER_SPECS: JSON.stringify(selection.webSpecs),
    ...(presentOnly ? { BAKERY_BROWSER_CORE_PRESENT_ONLY: "1" } : {}),
  }, "inherit");
  console.log(
    `browser elapsed: ${mode}${projects ? ` ${projects.join(",")}` : ""}${
      slice ? ` shard ${slice}` : ""
    } ${((performance.now() - start) / 1000).toFixed(3)}s`,
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (commands.some((command) => command.presentOnly)) {
  assertCoreListed(commands[0].packageDir);
}
let seeded = false;
for (const command of commands) {
  if (command.seedAdmin && !seeded) {
    seedBootstrapAdmin();
    seeded = true;
  }
  run(command);
}
