import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertNotMatch,
} from "@std/assert";
import { SENTRY_WEB_ENVIRONMENT_NAMES } from "@bakery/config/sentry";
import { SENTRY_WEB_BUILD_ENVIRONMENT_NAMES } from "@bakery/config/sentry-build";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const read = (path: string): Promise<string> =>
  Deno.readTextFile(`${root}${path}`);

/** Strips full-line shell/Dockerfile/Caddyfile comments. */
const withoutComments = (text: string): string =>
  text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

/**
 * Exit status of `git check-ignore --no-index` for one path with only the given
 * file as core.excludesFile. gitignore semantics are the stricter of the
 * dockerignore and railwayignore ones, so a path kept here is kept by both.
 */
async function ignoreStatus(
  excludesFile: string,
  path: string,
): Promise<number> {
  const { code } = await new Deno.Command("git", {
    args: [
      "-C",
      root,
      "-c",
      `core.excludesFile=${root}${excludesFile}`,
      "check-ignore",
      "--no-index",
      "-q",
      path,
    ],
    stdout: "null",
    stderr: "null",
  }).output();
  return code;
}

const keptPaths = [
  "docs/technical-design/api-catalog.json",
  "docs/technical-design/enterprise-mocks/fonts/geist-400.ttf",
  "assets/brand/logo/variants.json",
  "packages/contracts/src/contracts.ts",
  "packages/ui/src/brand/logo-assets.ts",
  "apps/server/Dockerfile",
  "infra/railway/Caddyfile",
  ".bakery-release-sha",
];
const ignoredPaths = [
  "docs/README.md",
  "docs/technical-design/ui-baselines/components.json",
  "docs/technical-design/enterprise-mocks/index.html",
  "tests/rails/workspace_test.ts",
  "apps/web/tests/placeholder.ts",
  "brand/scripts/placeholder.ts",
  ".env",
  "infra/.env",
  "apps/x/.env.local",
  "apps/server/coverage/lcov.info",
  "apps/web/.turbo/turbo-build.log",
  ".git/config",
  "node_modules",
  "apps/web/node_modules",
  "apps/web/dist/index.html",
  ".agents/tasks/railway-qa/plan.md",
];

Deno.test("dockerignore and railwayignore are identical and exclude the sensitive roots", async () => {
  const docker = await read(".dockerignore");
  const railway = await read(".railwayignore");
  assertEquals(docker, railway);
  const lines = docker.split("\n");
  assert(
    lines.includes("**/.env*"),
    "must exclude every .env file, nested too",
  );
  for (const pattern of ["**/.turbo", "**/coverage"]) {
    assert(lines.includes(pattern), `must exclude ${pattern} at any depth`);
  }
  assert(lines.includes("/.git"), "must exclude the git directory");
  assert(lines.includes("**/node_modules"), "must exclude installed trees");
  assert(
    !lines.some((line) => line.includes(".bakery-release-sha")),
    "the release marker must never be matched",
  );
});

Deno.test("ignore patterns are anchored the way Docker reads them", async () => {
  // Docker matches every pattern from the context root: `.env*` only hits a root
  // file, unlike gitignore. A pattern meant to match at any depth must therefore
  // start with `**/`, and any other must start with `/`, or it silently misses
  // nested files such as infra/.env. git check-ignore cannot see the difference.
  for (const file of [".dockerignore", ".railwayignore"]) {
    for (const line of (await read(file)).split("\n")) {
      const pattern = line.replace(/^!/, "");
      if (pattern === "" || pattern.startsWith("#")) continue;
      assert(
        pattern.startsWith("/") || pattern.startsWith("**/"),
        `${file}: "${line}" must start with / or **/ (Docker anchors bare names at the root)`,
      );
    }
  }
});

Deno.test("ignore rules keep every build-time read and drop the rest", async () => {
  for (const path of keptPaths) {
    if (path !== ".bakery-release-sha") {
      await Deno.stat(`${root}${path}`);
    }
    for (const file of [".dockerignore", ".railwayignore"]) {
      assertEquals(
        await ignoreStatus(file, path),
        1,
        `${path} must be kept by ${file}`,
      );
    }
  }
  for (const path of ignoredPaths) {
    for (const file of [".dockerignore", ".railwayignore"]) {
      assertEquals(
        await ignoreStatus(file, path),
        0,
        `${path} must be ignored by ${file}`,
      );
    }
  }
  // Not even the repository's own .gitignore may swallow the release marker,
  // or `railway up` (which honours .gitignore) would drop it.
  const own = await new Deno.Command("git", {
    args: [
      "-C",
      root,
      "check-ignore",
      "--no-index",
      "-q",
      ".bakery-release-sha",
    ],
    stdout: "null",
    stderr: "null",
  }).output();
  assertEquals(own.code, 1, ".bakery-release-sha must not be gitignored");
});

Deno.test("every FROM is pinned by digest and shared pins agree", async () => {
  const files = [
    "apps/server/Dockerfile",
    "apps/web/Dockerfile",
    "infra/railway/inngest.Dockerfile",
  ];
  const digests = new Map<string, Set<string>>();
  for (const file of files) {
    const stages = new Set<string>();
    for (const line of (await read(file)).split("\n")) {
      const match = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
      if (!match) continue;
      const [, image, alias] = match;
      if (!stages.has(image)) {
        assertMatch(
          image,
          /^[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/,
          `${file}: ${image} must be pinned by tag and digest`,
        );
        const name = image.split(":")[0];
        const set = digests.get(name) ?? new Set<string>();
        set.add(image.split("@")[1]);
        digests.set(name, set);
      }
      if (alias) stages.add(alias);
    }
  }
  for (const [name, set] of digests) {
    assertEquals(set.size, 1, `${name} must use one digest across images`);
  }
  const devcontainer = await read(".devcontainer/Dockerfile");
  const deno = [...digests.get("denoland/deno")!][0];
  assert(devcontainer.includes(deno), "Deno digest must match .devcontainer");
  const compose = await read("infra/compose.yaml");
  const inngest = [...digests.get("inngest/inngest")!][0];
  assert(
    compose.includes(inngest),
    "Inngest digest must match infra/compose.yaml",
  );
});

Deno.test("server image bakes the Deno cache and requires the release marker", async () => {
  const dockerfile = await read("apps/server/Dockerfile");
  assertMatch(dockerfile, /^ENV DENO_DIR=\/deno-dir$/m);
  assert(dockerfile.includes("test -s /workspace/.bakery-release-sha"));
  assert(
    dockerfile.includes("--ignore-scripts"),
    "install must not run prepare",
  );
  assert(dockerfile.includes("--frozen-lockfile"));
  for (
    const entrypoint of [
      "apps/server/src/main.ts",
      "apps/server/src/dispatch.ts",
      "apps/server/src/tasks.ts",
      "apps/server/scripts/run-dispatch.ts",
      "apps/server/scripts/bootstrap-database.ts",
    ]
  ) {
    assert(
      dockerfile.includes(entrypoint),
      `deno cache must cover ${entrypoint}`,
    );
  }
  const runtime = dockerfile.split("AS runtime")[1];
  assert(/^USER deno$/m.test(runtime), "runtime stage must drop root");
  // The Deno base ENTRYPOINT would leave the full container environment in PID 1.
  assertMatch(runtime, /^ENTRYPOINT \[\]$/m);
  const entrypoint = withoutComments(
    await read("infra/railway/server-entrypoint.sh"),
  );
  assertMatch(
    entrypoint,
    /export BAKERY_RUN_MAIN_INIT=\/tini\n\s+exec bash scripts\/run-main\.sh/,
  );
  assertMatch(entrypoint, /exec \/tini -s -- deno run .*run-dispatch\.ts/);
  const runMain = withoutComments(
    await read("apps/server/scripts/run-main.sh"),
  );
  assertMatch(
    runMain,
    /exec env -i "\$\{sanitized_environment\[@\]\}" \\\n\s+"\$\{init_wrapper\[@\]\}" deno run/,
  );
  assert(
    !runMain.includes("  BAKERY_RUN_MAIN_INIT\n"),
    "the init variable must stay off the environment allowlist",
  );
});

Deno.test("scripts never trace, dump or place secrets on a command line", async () => {
  for (
    const file of [
      "infra/railway/server-entrypoint.sh",
      "infra/railway/inngest-start.sh",
      "infra/railway/secrets-key.sh",
    ]
  ) {
    const script = withoutComments(await read(file));
    assert(!/set\s+-[a-z]*x/.test(script), `${file} must not enable xtrace`);
    assert(!/\bprintenv\b/.test(script), `${file} must not call printenv`);
    assert(
      !/(^|[;&|(]\s*|\s)env\s*(\n|$|[;&|])/m.test(script),
      `${file}: bare env`,
    );
    assert(
      !/\bexport\s+-p\b|\bdeclare\s+-x\b/.test(script),
      `${file}: env dump`,
    );
  }
  const inngest = withoutComments(await read("infra/railway/inngest-start.sh"));
  for (
    const flag of [
      "--postgres-uri",
      "--redis-uri",
      "--signing-key",
      "--event-key",
    ]
  ) {
    assert(!inngest.includes(flag), `inngest-start.sh must not pass ${flag}`);
  }
  assertMatch(inngest, /exec inngest start\s*$/m);
  assert(inngest.includes("INNGEST_HOST='[::]'"));
  assertMatch(inngest, /INNGEST_TICK="\$\{INNGEST_TICK:-1000\}"/);
});

Deno.test("web Caddyfile proxies every server route prefix and retries across restarts", async () => {
  const caddyfile = await read("infra/railway/Caddyfile");
  const matcher = /@api path (.+)/.exec(caddyfile);
  assert(matcher, "Caddyfile needs an @api matcher");
  const tokens = matcher[1].trim().split(/\s+/);
  // Caddy's path matcher is a literal prefix test, so `/health/*` matches
  // `/health/…` and never the bare `/health`. This helper used to accept the
  // bare prefix anyway, which is how #520 shipped: the rail reported `/health`
  // covered while Caddy sent it to the SPA catch-all. Mirror Caddy exactly.
  const covers = (token: string, prefix: string): boolean =>
    token.endsWith("*")
      ? prefix.startsWith(token.slice(0, -1))
      : token === prefix;
  for (
    const prefix of [
      "/health",
      // Subpaths too: the bare prefixes above are satisfied by exact tokens,
      // so without these, dropping `/health/*`, `/v1/*` or `/api/*` would
      // pass while every subpath fell to the SPA shell.
      "/health/ready",
      "/livez",
      "/readyz",
      "/v1",
      "/v1/tasks",
      "/api",
      "/api/auth/get-session",
      "/mcp",
      "/mcp/x",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
    ]
  ) {
    assert(
      tokens.some((token) => covers(token, prefix)),
      `@api must cover ${prefix}`,
    );
  }
  assert(caddyfile.includes("lb_try_duration 10s"));
  assert(caddyfile.includes("header_up X-Forwarded-For {client_ip}"));
  assert(caddyfile.includes("header_up -X-Bakery-Remote-Addr"));
  assertNotEquals(
    (await read("apps/web/Dockerfile")).indexOf("USER 10001:10001"),
    -1,
    "web image must run as an unprivileged user",
  );
});

Deno.test("the web image declares every browser telemetry build argument and ships no build token", async () => {
  const dockerfile = await read("apps/web/Dockerfile");
  const [build, runtime] = dockerfile.split("AS runtime");
  const declared = [...build.matchAll(/^ARG\s+([A-Z0-9_]+)/gm)].map((m) =>
    m[1]
  );
  const viteBuild = build.indexOf("vite build");
  assertNotEquals(viteBuild, -1, "the build stage runs vite build");
  // Railway reaches a Dockerfile build only through ARG. A web Sentry variable
  // missing from this list is silently absent from the bundle, which is how QA
  // ended up serving a SPA that never called Sentry.init.
  for (
    const name of [
      // The release is derived from the stamped SHA, asserted below.
      ...SENTRY_WEB_ENVIRONMENT_NAMES.filter((n) =>
        n !== "VITE_SENTRY_RELEASE"
      ),
      // Upload declaration, target and token: the same rail, because an
      // undeclared SENTRY_UPLOAD_SOURCEMAPS reaches the build as absent and
      // an instrumented build with no declaration fails rather than guessing.
      ...SENTRY_WEB_BUILD_ENVIRONMENT_NAMES,
    ]
  ) {
    assert(declared.includes(name), `apps/web/Dockerfile needs ARG ${name}`);
    assert(
      build.indexOf(`ARG ${name}`) < viteBuild,
      `ARG ${name} must be declared before the build that reads it`,
    );
  }
  assert(
    !declared.includes("VITE_SENTRY_RELEASE"),
    "the release must not be a build argument: a stale one would name a different bundle",
  );
  assertMatch(
    build,
    /VITE_SENTRY_RELEASE="bakery@\$\([^)]*\.bakery-release-sha\)"/,
    "the release must come from the SHA the deploy stamped",
  );
  // A production-mode build with a DSN and no telemetry environment defaults to
  // the `production` environment, so variables applied in the wrong order would
  // quietly file QA events as production instead of staging.
  assert(
    build.includes(
      '[ -n "$VITE_SENTRY_DSN" ] && [ -z "$VITE_SENTRY_ENVIRONMENT" ]',
    ),
    "a DSN with no VITE_SENTRY_ENVIRONMENT must fail the build",
  );
  // Hidden maps are uploaded and then deleted; one that survived would hand the
  // sources to any visitor (Caddy's 404 for *.map is the second line, not the
  // first). The published image is the Caddy stage, so no Sentry value reaches
  // a layer that ships.
  assert(
    build.includes("-name '*.map'"),
    "the build must reject surviving maps",
  );
  assertNotMatch(
    runtime,
    /SENTRY/,
    "the runtime stage must carry no Sentry value",
  );
});

Deno.test("production Caddy template and Vite proxy forward MCP and OAuth discovery", async () => {
  const release = await read("scripts/deploy/release.mjs");
  const matcher = /@api path (.+)/.exec(release);
  assert(matcher, "release.mjs needs an @api matcher");
  const tokens = matcher[1].trim().split(/\s+/);
  for (const path of ["/mcp", "/mcp/*", "/.well-known/oauth-*"]) {
    assert(tokens.includes(path), `production @api must include ${path}`);
  }
  const vite = await read("apps/web/vite.config.ts");
  for (
    const prefix of [
      "/mcp",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
    ]
  ) {
    assert(vite.includes(`"${prefix}"`), `vite proxy must list ${prefix}`);
  }
  assert(
    (await read("infra/railway/Caddyfile")).includes("grace_period"),
    "web Caddyfile must bound shutdown so redeploys are not held by keep-alives",
  );
});
