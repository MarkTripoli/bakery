import { defineConfig, devices } from "@playwright/test";
import type { ReporterDescription } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTH_BOOTSTRAP_PROJECT,
  coreGrep,
} from "../../scripts/ci/browser-core.mjs";

const mode = process.env.BAKERY_BROWSER_MODE ?? "full";
const requireCore = mode === "core" ||
  process.env.BAKERY_BROWSER_REQUIRE_CORE === "1";
if (!["full", "core", "affected"].includes(mode)) {
  throw new Error("Unknown BAKERY_BROWSER_MODE");
}
const selectedSpecs: unknown = JSON.parse(
  process.env.BAKERY_BROWSER_SPECS ?? "[]",
);
if (
  !Array.isArray(selectedSpecs) ||
  !selectedSpecs.every((spec) =>
    typeof spec === "string" && /^[a-z0-9-]+\.spec\.ts$/.test(spec)
  )
) throw new Error("Invalid BAKERY_BROWSER_SPECS");
const consumerSelection = (project: string) => ({
  ...(mode === "core" ? { grep: coreGrep(project) } : {}),
  ...(mode === "affected" ? { grepInvert: coreGrep(project) } : {}),
});
const reporters: ReporterDescription[] = [
  ["list"],
  ...(requireCore
    ? [
      ["./tests/helpers/browser-core-reporter.ts"] satisfies ReporterDescription,
    ]
    : []),
  ...(process.env.CI
    ? [
      ["html", {
        outputFolder: "../../artifacts/ui-baseline/report",
        open: "never",
      }] satisfies ReporterDescription,
      ["./tests/helpers/headroom-reporter.ts"] satisfies ReporterDescription,
    ]
    : []),
];

// vite.config.ts reads the same variable; CI sets it to a free port so runner
// users sharing a host do not collide. Local default stays 5173.
const webPort = process.env.BAKERY_WEB_PORT || "5173";
const webOrigin = `http://127.0.0.1:${webPort}`;
// CI serves a production build through `vite preview`: the unbundled dev server
// answers each hard load with hundreds of /@fs module requests and Chromium
// fails some with ERR_NETWORK_CHANGED / ERR_INSUFFICIENT_RESOURCES. Local runs
// keep the dev server unless BAKERY_WEB_PREVIEW=1. The bundle is built with
// NODE_ENV=development so import.meta.env.DEV stays true: the specs drive the
// DEV-only /__fixtures__ routes, which a production build drops.
const useBuiltPreview = Boolean(process.env.CI) ||
  process.env.BAKERY_WEB_PREVIEW === "1";
const previewOutDir = join(
  process.env.RUNNER_TEMP || tmpdir(),
  `bakery-web-shell-${webPort}`,
);
const quotedOutDir = `'${previewOutDir.replaceAll("'", `'\\''`)}'`;
const webServerCommand = useBuiltPreview
  ? `env NODE_ENV=development pnpm exec vite build --mode test --outDir ${quotedOutDir} --emptyOutDir && ` +
    `pnpm exec vite preview --outDir ${quotedOutDir} --host 127.0.0.1 --port ${webPort} --strictPort`
  : `pnpm dev --host 127.0.0.1 --port ${webPort}`;
const authSpec = "**/auth-journey.spec.ts";

/**
 * Specs that sign in as the one bootstrap admin or run `web-auth-seed`. They
 * share state no worker may touch concurrently: assertion 8 of
 * `auth-journey` turns TOTP on, the seed's `already-complete` path resets it,
 * assertion 4 revokes other sessions, and every sign-in draws on the same
 * Better Auth rate-limit buckets. They run in their own single-worker,
 * auth-bootstrap project followed by its dependent shared-admin project, so
 * only one serial owner holds the admin while other browsers keep parallelism.
 */
export const SHARED_ADMIN_SPECS: readonly string[] = [
  authSpec,
  "**/settings-journey.spec.ts",
  "**/account-security-journey.spec.ts",
  "**/repository-profile-real-api.spec.ts",
  "**/organization-access-real-api.spec.ts",
  "**/installation-integrations-real-api.spec.ts",
  // Not the bootstrap admin, but its child API owns the one GitHub App
  // registration row, which installation-integrations-real-api reads.
  "**/organization-integrations-fake-github.spec.ts",
  "**/browser-artifact-core.spec.ts",
];

/**
 * Real-API specs that seed their own admin and data and need no shared-admin
 * serialization: they run alone in the `desktop-real-api` project (never as
 * skipped copies in the fixture projects). They drive coordinator turns and
 * run starts, so they need the scripted-coordinator stack of
 * per-worktree stack (scripts/dev/compose-up.sh) (`BAKERY_ENV=test` server with
 * `BAKERY_SCRIPTED_COORDINATOR_DIR`, Redis, Inngest and the outbox
 * dispatcher). The CI `ui_web` job starts only Postgres and the API with
 * `BAKERY_REAL_API=1` for the profile spec, so these run only when the
 * operator also sets `BAKERY_REAL_API_COORDINATOR=1` against that stack;
 * they are operator-run evidence, not CI-selected.
 */
export const REAL_API_SPECS: readonly string[] = [
  "**/task-conversation-real-api.spec.ts",
  "**/shared-conversation-real-api.spec.ts",
  "**/task-run-control-real-api.spec.ts",
];

/**
 * Real-harness run-observation journey. It drives a real
 * enrolled worker running the Claude Code harness (or the $0 fake executable
 * of `tests/fixtures/fake-harness/fake-claude-slow.sh`) and
 * seeds through the database owner, so it needs the isolated per-worktree
 * per-worktree stack (scripts/dev/compose-up.sh) plus that separate
 * worker. A real model run costs money: the project is selected only when the
 * operator sets both `BAKERY_REAL_API=1` and `BAKERY_REAL_API_HARNESS=1`, and
 * it is never CI-selected.
 */
export const REAL_HARNESS_SPECS: readonly string[] = [
  "**/run-observation-real-harness.spec.ts",
];

/**
 * M1 (#132) real-journey proof: one serial spec that signs in, registers a
 * worker through the Machines UI, plans with the real Claude Code
 * coordinator, approves, observes a real Claude Code executor run and drills
 * browser, server, engine and worker faults. It needs the fresh per-worktree
 * stack, the Claude Code worker and the funded run that
 * `scripts/evidence/prove-m1.ts` provides and exports, so the project is
 * selected only when the operator (the orchestrator) sets both
 * `BAKERY_REAL_API=1` and `BAKERY_REAL_API_M1=1`; it is never CI-selected and
 * no fixture project runs it.
 */
export const REAL_M1_SPECS: readonly string[] = [
  "**/m1-journey-real.spec.ts",
];

/**
 * Repository rules (#65) against the real API: a Deno child
 * (tests/helpers/repository-rules-server.child.ts) runs the real Bakery app on a
 * real test database. It seeds its own Admin and Developer through
 * `openInstallationFixture`, whose `createSuperuser` fails AUTH_BOOTSTRAP_CONFLICT
 * on an installation the auth-bootstrap project already bootstrapped, so it
 * cannot join the shared-admin lanes. It needs only a migrated test database
 * (`DATABASE_URL`, `BAKERY_APP_DATABASE_URL`, `BAKERY_ENV=test`) and `deno`; the
 * project is selected only when the operator sets both `BAKERY_REAL_API=1` and
 * `BAKERY_REAL_API_RULES=1`, and it is never CI-selected.
 */
export const REAL_RULES_SPECS: readonly string[] = [
  "**/organization-repository-rules-real-api.spec.ts",
];

export default defineConfig({
  testDir: "./tests",
  ...(mode === "affected"
    ? { testMatch: selectedSpecs.map((spec) => `**/${spec}`) }
    : {}),
  outputDir: "../../artifacts/ui-baseline/test-results",
  timeout: process.env.CI ? 45_000 : 15_000,
  fullyParallel: true,
  // The shared self-hosted CI runner also hosts Vite and the real API. Two browsers
  // leave capacity for cold fixture transforms and route navigation.
  workers: process.env.CI ? 2 : 4,
  reporter: reporters,
  use: {
    baseURL: process.env.BASE_URL ?? webOrigin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  globalTeardown: "./tests/helpers/preview-teardown.ts",
  webServer: process.env.BASE_URL ? undefined : {
    command: webServerCommand,
    url: webOrigin,
    // The built-preview command runs a full production build first.
    timeout: useBuiltPreview ? 240_000 : 60_000,
    reuseExistingServer: !process.env.CI && !useBuiltPreview,
    // Surface Vite re-optimize and reload lines in the CI log.
    stdout: process.env.CI ? "pipe" : "ignore",
  },
  projects: [
    ...(mode === "affected" ? [] : [{
      name: AUTH_BOOTSTRAP_PROJECT,
      use: { ...devices["Desktop Chrome"] },
      testMatch: [authSpec],
      ...consumerSelection(AUTH_BOOTSTRAP_PROJECT),
      workers: 1,
      fullyParallel: false,
    }]),
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: [
        ...SHARED_ADMIN_SPECS,
        ...REAL_API_SPECS,
        ...REAL_HARNESS_SPECS,
        ...REAL_M1_SPECS,
        ...REAL_RULES_SPECS,
      ],
      ...consumerSelection("desktop"),
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], browserName: "chromium" },
      testIgnore: [
        ...SHARED_ADMIN_SPECS,
        ...REAL_API_SPECS,
        ...REAL_HARNESS_SPECS,
        ...REAL_M1_SPECS,
        ...REAL_RULES_SPECS,
      ],
      ...consumerSelection("mobile"),
    },
    {
      name: "desktop-real-api",
      use: { ...devices["Desktop Chrome"] },
      testMatch: process.env.BAKERY_REAL_API === "1" &&
          process.env.BAKERY_REAL_API_COORDINATOR === "1"
        ? [...REAL_API_SPECS]
        : [],
      workers: 1,
      fullyParallel: false,
    },
    {
      // The run itself is `--workers=2`; the project serializes its own tests
      // because every test shares the one funded run and one worker.
      name: "desktop-real-harness",
      use: { ...devices["Desktop Chrome"] },
      testMatch: process.env.BAKERY_REAL_API === "1" &&
          process.env.BAKERY_REAL_API_HARNESS === "1"
        ? [...REAL_HARNESS_SPECS]
        : [],
      workers: 1,
      fullyParallel: false,
    },
    {
      // Serial: one child API, one seeded Admin and one growing revision list.
      name: "desktop-real-rules",
      use: { ...devices["Desktop Chrome"] },
      testMatch: process.env.BAKERY_REAL_API === "1" &&
          process.env.BAKERY_REAL_API_RULES === "1"
        ? [...REAL_RULES_SPECS]
        : [],
      workers: 1,
      fullyParallel: false,
    },
    {
      // Every phase shares the one stack, the one worker and the one funded
      // spend, so the project runs the serial journey on one worker.
      name: "desktop-real-m1",
      use: { ...devices["Desktop Chrome"] },
      testMatch: process.env.BAKERY_REAL_API === "1" &&
          process.env.BAKERY_REAL_API_M1 === "1"
        ? [...REAL_M1_SPECS]
        : [],
      workers: 1,
      fullyParallel: false,
    },
    {
      name: "desktop-shared-admin",
      use: { ...devices["Desktop Chrome"] },
      ...(mode === "affected"
        ? {}
        : { dependencies: [AUTH_BOOTSTRAP_PROJECT] }),
      testMatch: SHARED_ADMIN_SPECS.filter((spec) =>
        spec !== authSpec &&
        (mode !== "affected" || selectedSpecs.includes(spec.slice(3)))
      ),
      ...consumerSelection("desktop-shared-admin"),
      workers: 1,
      fullyParallel: false,
    },
  ],
});
