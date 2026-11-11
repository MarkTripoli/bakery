import assert from "node:assert/strict";
import test from "node:test";
import webConfig from "../../apps/web/vite.config.ts";
import { readSentryConfig } from "../../packages/config/src/sentry.ts";

// Every name the resolved configuration can read, so one case cannot leak into
// the next through the ambient environment Vite merges over its .env files.
const names = [
  "BAKERY_ENV",
  "VITE_SENTRY_ENABLED",
  "VITE_SENTRY_ENVIRONMENT",
  "VITE_SENTRY_DSN",
  "VITE_SENTRY_RELEASE",
  "VITE_SENTRY_TRACES_SAMPLE_RATE",
  "SENTRY_UPLOAD_SOURCEMAPS",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "SENTRY_AUTH_TOKEN",
];

/** The QA shape: telemetry on, staging environment, DSN but no token yet. */
const reporting = {
  VITE_SENTRY_ENABLED: "true",
  VITE_SENTRY_ENVIRONMENT: "staging",
  VITE_SENTRY_DSN: "https://public@o1.ingest.us.sentry.io/123",
  VITE_SENTRY_RELEASE: "bakery@0123456789abcdef0123456789abcdef01234567",
};

const uploadTarget = {
  SENTRY_ORG: "trike-solutions",
  SENTRY_PROJECT: "bakery-web",
  SENTRY_AUTH_TOKEN: "upload-token-sentinel",
};

async function resolve(environment, command = "build") {
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, environment);
  try {
    return await webConfig({ mode: "production", command });
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

const plugins = (resolved) =>
  resolved.plugins.flat(Infinity).filter(Boolean).map((plugin) => plugin.name);

test("an instrumented build that declares upload emits hidden maps for the plugin", async () => {
  const resolved = await resolve({
    ...reporting,
    ...uploadTarget,
    SENTRY_UPLOAD_SOURCEMAPS: "true",
  });
  assert.ok(plugins(resolved).includes("sentry-vite-plugin"));
  // Hidden, not inline: the plugin uploads them and deletes them, and the
  // Dockerfile fails the build if one survives into the published image.
  assert.equal(resolved.build.sourcemap, "hidden");
});

test("an instrumented build that declares upload off still reports, with no map and no plugin", async () => {
  const environment = { ...reporting, SENTRY_UPLOAD_SOURCEMAPS: "false" };
  const resolved = await resolve(environment);
  // The bundle still initializes the SDK: this is what lets QA report a browser
  // failure at all without the organization auth token (#353 AC1, #523).
  assert.deepEqual(readSentryConfig(environment, "web", "production"), {
    enabled: true,
    dsn: reporting.VITE_SENTRY_DSN,
    environment: "staging",
    release: reporting.VITE_SENTRY_RELEASE,
    tracesSampleRate: 0.1,
  });
  assert.ok(!plugins(resolved).includes("sentry-vite-plugin"));
  // No source map is written at all, so no `.map` can reach the served image
  // by construction rather than by a separate check. Frames stay minified.
  assert.equal(resolved.build.sourcemap, false);
});

test("`0` declares upload off and `1` declares it on", async () => {
  assert.equal(
    (await resolve({ ...reporting, SENTRY_UPLOAD_SOURCEMAPS: "0" })).build
      .sourcemap,
    false,
  );
  assert.equal(
    (await resolve({
      ...reporting,
      ...uploadTarget,
      SENTRY_UPLOAD_SOURCEMAPS: "1",
    }))
      .build.sourcemap,
    "hidden",
  );
});

test("an instrumented build with no declaration fails instead of defaulting to off", async () => {
  await assert.rejects(
    () => resolve({ ...reporting, ...uploadTarget }),
    /SENTRY_BUILD_UPLOAD_DECISION_REQUIRED/,
  );
  // An empty ARG default is an absent declaration, not a decision.
  await assert.rejects(
    () =>
      resolve({
        ...reporting,
        ...uploadTarget,
        SENTRY_UPLOAD_SOURCEMAPS: "  ",
      }),
    /SENTRY_BUILD_UPLOAD_DECISION_REQUIRED/,
  );
});

test("an unrecognised declaration fails rather than being read as either state", async () => {
  for (const value of ["yes", "no", "off", "TRUE", "False", "2"]) {
    await assert.rejects(
      () =>
        resolve({
          ...reporting,
          ...uploadTarget,
          SENTRY_UPLOAD_SOURCEMAPS: value,
        }),
      /SENTRY_BUILD_UPLOAD_DECISION_INVALID/,
      `${value} must not be accepted`,
    );
  }
});

test("declared upload keeps requiring the token and the whole target", async () => {
  const on = { ...reporting, SENTRY_UPLOAD_SOURCEMAPS: "true" };
  await assert.rejects(
    () =>
      resolve({
        ...on,
        SENTRY_ORG: uploadTarget.SENTRY_ORG,
        SENTRY_PROJECT: uploadTarget.SENTRY_PROJECT,
      }),
    /SENTRY_BUILD_AUTH_TOKEN_REQUIRED/,
  );
  for (const name of ["SENTRY_ORG", "SENTRY_PROJECT"]) {
    const partial = { ...on, ...uploadTarget };
    delete partial[name];
    await assert.rejects(
      () => resolve(partial),
      /SENTRY_BUILD_TARGET_REQUIRED/,
      `${name} must be required when upload is declared on`,
    );
  }
});

test("declaring upload off does not make the enable's DSN optional", async () => {
  // The apply order the runbook states, as a rail: VITE_SENTRY_ENABLED is a
  // literal in `.railway/railway.ts` while the DSN is `preserve()`, so an apply
  // that lands the enable before the DSN exists fails the web build and takes
  // the deploy with it. Splitting upload out of reporting must not read as
  // "upload off means nothing has to be set first".
  const { VITE_SENTRY_DSN: _dsn, ...noDsn } = reporting;
  await assert.rejects(
    () => resolve({ ...noDsn, SENTRY_UPLOAD_SOURCEMAPS: "false" }),
    /SENTRY_CONFIGURATION_INVALID:VITE_SENTRY_DSN/,
  );
});

test("an uninstrumented build and a dev server need no declaration", async () => {
  // An ordinary `docker build` with the empty ARG defaults: no telemetry, so
  // nothing to upload and nothing to declare.
  const bare = await resolve({});
  assert.equal(bare.build.sourcemap, false);
  assert.ok(!plugins(bare).includes("sentry-vite-plugin"));
  assert.equal(
    readSentryConfig({}, "web", "production").enabled,
    false,
  );
  // `vite dev` never uploads, so a developer with a DSN is not asked to decide.
  const served = await resolve(reporting, "serve");
  assert.equal(served.build.sourcemap, false);
  assert.ok(!plugins(served).includes("sentry-vite-plugin"));
});

test("a test-mode build declares nothing and reports nothing", async () => {
  const resolved = await resolve({ ...reporting, BAKERY_ENV: "test" });
  assert.equal(resolved.build.sourcemap, false);
  assert.ok(!plugins(resolved).includes("sentry-vite-plugin"));
});

test("a declared upload that cannot complete fails the build instead of shipping unresolvable frames", async () => {
  const resolved = await resolve({
    ...reporting,
    ...uploadTarget,
    SENTRY_UPLOAD_SOURCEMAPS: "true",
  });
  const plugin = resolved.plugins.flat(Infinity).filter(Boolean).find(
    (candidate) => candidate.name === "sentry-vite-plugin",
  );
  assert.ok(
    plugin,
    "an instrumented build that declares upload adds the plugin",
  );
  const writeBundle = typeof plugin.writeBundle === "function"
    ? plugin.writeBundle
    : plugin.writeBundle.handler;

  // Without an error handler the plugin only logs a failed upload, the build
  // exits 0, and the maps are deleted afterwards: the release ships with frames
  // that can never resolve and nothing says so. Port 1 is closed, so the
  // upload fails here and nothing leaves the host.
  const saved = process.env.SENTRY_URL;
  process.env.SENTRY_URL = "http://127.0.0.1:1";
  try {
    await assert.rejects(
      writeBundle.call({}, { dir: "/nonexistent-output-dir" }, {}),
      /sentry-cli|Could not connect|API request failed/i,
    );
  } finally {
    if (saved === undefined) delete process.env.SENTRY_URL;
    else process.env.SENTRY_URL = saved;
  }
});
