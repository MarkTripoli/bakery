import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  CLOUD_CREDENTIAL_ENVIRONMENT,
  cloudCredentialsPresent,
  collectRevision,
  composeImages,
  CREDENTIAL_REFUSAL_EXIT,
  parseVerifyBackendArgs,
  runVerifyBackend,
  VERIFY_BACKEND_STEPS,
  type VerifyBackendCapture,
  VerifyBackendManifestSchema,
  type VerifyBackendRevision,
} from "../../scripts/verify-backend.ts";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

const REVISION: VerifyBackendRevision = {
  gitSha: "a".repeat(40),
  dirty: false,
  pnpmLockSha256: "b".repeat(64),
  denoLockSha256: "c".repeat(64),
  images: ["postgres:16-alpine@sha256:" + "d".repeat(64)],
  migrations: { count: 3, checksum: "e".repeat(64) },
};

function harness(exitCodes: Partial<Record<string, number>> = {}) {
  const ran: string[] = [];
  const written: { path: string; text: string }[] = [];
  const logs: string[] = [];
  let clock = 1_700_000_000_000;
  return {
    ran,
    written,
    logs,
    options: (args: string[], environment: Record<string, string> = {}) => ({
      root: "/repo",
      args,
      environment,
      runner: (command: readonly string[]) => {
        const step = command.at(-1) === "typecheck"
          ? "typecheck"
          : command.at(-1)!;
        ran.push(step);
        clock += 5;
        return Promise.resolve(exitCodes[step] ?? 0);
      },
      capture: (() => {
        throw new Error("capture must not run in this test");
      }) as VerifyBackendCapture,
      now: () => clock,
      log: (line: string) => logs.push(line),
      writeManifest: (path: string, text: string) => {
        written.push({ path, text });
        return Promise.resolve();
      },
      revision: () => Promise.resolve(REVISION),
      toolchain: () => Promise.resolve({ deno: "2.9.1", node: "v24.1.0" }),
    }),
  };
}

Deno.test("verify:backend refuses cloud credentials before anything runs", async () => {
  for (
    const name of [
      ...CLOUD_CREDENTIAL_ENVIRONMENT.exact,
      "AWS_ACCESS_KEY_ID",
      "AZURE_CLIENT_SECRET",
    ]
  ) {
    const h = harness();
    const result = await runVerifyBackend(
      h.options([], { PATH: "/usr/bin", [name]: "secret-value" }),
    );
    assertEquals(result.exitCode, CREDENTIAL_REFUSAL_EXIT, name);
    assertEquals(h.ran, [], name);
    assertEquals(h.written, [], name);
    assert(h.logs.join("\n").includes(name), name);
    assert(!h.logs.join("\n").includes("secret-value"), "value leaked");
  }
});

Deno.test("credential detection ignores empty and unrelated variables", () => {
  assertEquals(
    cloudCredentialsPresent({
      GITHUB_TOKEN: "",
      PATH: "/bin",
      HOME: "/h",
      AWSOME: "x",
      GH_TOKEN: "t",
      AWS_PROFILE: "p",
    }),
    ["AWS_PROFILE", "GH_TOKEN"],
  );
});

Deno.test("a login directory counts only when it holds the login file", () => {
  const environment = { CODEX_HOME: "/empty", CLAUDE_CONFIG_DIR: "/claude" };
  // The lanes point CODEX_HOME at an empty directory: that is not a credential.
  assertEquals(cloudCredentialsPresent(environment, () => false), []);
  assertEquals(
    cloudCredentialsPresent(
      environment,
      (path) =>
        path === "/empty/auth.json" || path === "/claude/.credentials.json",
    ),
    ["CLAUDE_CONFIG_DIR", "CODEX_HOME"],
  );
});

Deno.test("verify:backend runs every step in order by default", async () => {
  const h = harness();
  const result = await runVerifyBackend(h.options([]));
  assertEquals(result.exitCode, 0);
  assertEquals(h.ran, [...VERIFY_BACKEND_STEPS]);
  assertEquals(VERIFY_BACKEND_STEPS, [
    "typecheck",
    "rails",
    "unit",
    "contract",
    "integration",
    "security",
    "recovery",
    "e2e",
  ]);
  const manifest = VerifyBackendManifestSchema.parse(
    JSON.parse(h.written[0]!.text),
  );
  assertEquals(manifest.outcome, "passed");
  assertEquals(manifest.revision, REVISION);
  assertEquals(manifest.toolchain, { deno: "2.9.1", node: "v24.1.0" });
  assertEquals(manifest.steps.map((step) => step.step), [
    ...VERIFY_BACKEND_STEPS,
  ]);
  assert(
    manifest.steps.every((step) =>
      step.exitCode === 0 && step.durationMs === 5
    ),
  );
  assertEquals(manifest.steps[0]!.command, ["pnpm", "typecheck"]);
  assertEquals(manifest.steps[1]!.command.slice(-2), [
    "scripts/run-tests.ts",
    "rails",
  ]);
  assertMatch(
    h.written[0]!.path,
    /^\/repo\/\.scratch\/verify-backend\/aaaaaaaaaaaa-.*\.json$/,
  );
  assertEquals(result.manifestPath, h.written[0]!.path);
});

Deno.test("verify:backend stops at the first failing step and records it", async () => {
  const h = harness({ unit: 7 });
  const result = await runVerifyBackend(h.options(["--out", "/x/m.json"]));
  assertEquals(result.exitCode, 1);
  assertEquals(h.ran, ["typecheck", "rails", "unit"]);
  const manifest = VerifyBackendManifestSchema.parse(
    JSON.parse(h.written[0]!.text),
  );
  assertEquals(manifest.outcome, "failed");
  assertEquals(manifest.steps.map((step) => [step.step, step.exitCode]), [
    ["typecheck", 0],
    ["rails", 0],
    ["unit", 7],
  ]);
  assertEquals(h.written[0]!.path, "/x/m.json");
});

Deno.test("--lanes narrows the run but keeps the fixed order", async () => {
  assertEquals(parseVerifyBackendArgs(["--lanes=e2e,rails"]).lanes, [
    "rails",
    "e2e",
  ]);
  const h = harness();
  const result = await runVerifyBackend(
    h.options(["--lanes", "unit,typecheck"]),
  );
  assertEquals(result.exitCode, 0);
  assertEquals(h.ran, ["typecheck", "unit"]);
  const bad = harness();
  assertEquals(
    (await runVerifyBackend(bad.options(["--lanes", "unit,nope"]))).exitCode,
    2,
  );
  assertEquals(bad.ran, []);
});

Deno.test("the manifest schema rejects an image without a digest", () => {
  const parsed = VerifyBackendManifestSchema.safeParse({
    schema: "bakery.verify-backend/v1",
    startedAt: new Date(0).toISOString(),
    outcome: "passed",
    revision: { ...REVISION, images: ["postgres:16-alpine"] },
    toolchain: { deno: "2.9.1", node: null },
    requestedSteps: ["rails"],
    steps: [],
  });
  assertEquals(parsed.success, false);
});

Deno.test("revision facts come from this checkout", async () => {
  const capture: VerifyBackendCapture = async (command, { cwd }) => {
    const output = await new Deno.Command(command[0]!, {
      args: command.slice(1),
      cwd,
      stdout: "piped",
      stderr: "null",
    }).output();
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
    };
  };
  const revision = await collectRevision(root, capture);
  const head = await capture(["git", "rev-parse", "HEAD"], { cwd: root });
  assertEquals(revision.gitSha, head.stdout.trim());
  const sha = async (path: string) =>
    [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          await Deno.readFile(root + "/" + path),
        ),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  assertEquals(revision.pnpmLockSha256, await sha("pnpm-lock.yaml"));
  assertEquals(revision.denoLockSha256, await sha("deno.lock"));
  const compose = await Deno.readTextFile(root + "/infra/compose.yaml");
  assertEquals(revision.images, composeImages(compose));
  assert(revision.images.length > 0);
  assert(revision.images.every((image) => /@sha256:[0-9a-f]{64}$/.test(image)));
  assert(revision.migrations.count > 0);
  assertMatch(revision.migrations.checksum, /^[0-9a-f]{64}$/);
});

Deno.test("package.json wires verify:backend to the script", async () => {
  const pkg = JSON.parse(await Deno.readTextFile(root + "/package.json"));
  assert(
    String(pkg.scripts["verify:backend"]).endsWith(
      " scripts/verify-backend.ts",
    ),
  );
});
