import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  PLUGIN_AUTHORING_KIT_DIGEST,
  PLUGIN_AUTHORING_KIT_FILES,
} from "@bakery/contracts/plugin-authoring-kit";
import {
  buildPluginBundle,
  checkPluginPackage,
  freezeAuthoringPolicy,
  PLUGIN_PACKAGE_CHECK_IDS,
  readPluginBundle,
} from "../../apps/server/src/modules/workflows/plugin-authoring/checks.ts";

/**
 * The authored-plugin checks (#45, B14.04): the kit's own example passes, each
 * rule refuses what it names, and every attempt reports the same check ids.
 */

const KIT_DIGEST_PIN =
  "f15e1e6bf499803ffddb8f942eac2cc4b2983dac4d71a9481a429a2b7e0abb8a";

function example(overrides: Record<string, string | undefined> = {}) {
  const files: Record<string, string> = {
    "manifest.json": PLUGIN_AUTHORING_KIT_FILES["example/manifest.json"],
    "plugin.json": PLUGIN_AUTHORING_KIT_FILES["example/plugin.json"],
    "job.ts": PLUGIN_AUTHORING_KIT_FILES["example/job.ts"],
  };
  for (const [path, content] of Object.entries(overrides)) {
    if (content === undefined) delete files[path];
    else files[path] = content;
  }
  return files;
}

const POLICY = freezeAuthoringPolicy(["state.read", "state.write"]);

Deno.test("the kit digest is pinned: a kit change updates this pin on purpose", () => {
  assertEquals(PLUGIN_AUTHORING_KIT_DIGEST, KIT_DIGEST_PIN);
});

Deno.test("the kit's example package passes every check and builds", async () => {
  const result = await checkPluginPackage(example(), POLICY);
  assertEquals(result.diagnostics, []);
  assert(result.ok);
  assertEquals(
    result.report.checks.map((check) => [check.id, check.status]),
    PLUGIN_PACKAGE_CHECK_IDS.map((id) => [id, "passed"]),
  );
  assertEquals(result.sdkRange, "^1.0.0");
  assert(result.bundle !== null);
  const files = readPluginBundle(result.bundle.bytes);
  assertEquals(Object.keys(files).sort(), [
    "job.ts",
    "manifest.json",
    "plugin.json",
    "runner.ts",
    "sdk.ts",
  ]);
});

Deno.test("the bundle is deterministic in its files", () => {
  const a = buildPluginBundle(example());
  const reordered = Object.fromEntries(Object.entries(example()).reverse());
  assertEquals(buildPluginBundle(reordered).digest, a.digest);
  assertNotEquals(
    buildPluginBundle(example({ "util.ts": "export const x = 1;\n" })).digest,
    a.digest,
  );
});

Deno.test("a capability the request did not authorize is AUTHORITY_EXCEEDED", async () => {
  const manifest = JSON.stringify({
    name: "counter",
    requestedCapabilities: ["state.read", "state.write", "jobs.schedule"],
    stateNamespaces: ["counter"],
  });
  const result = await checkPluginPackage(
    example({ "manifest.json": manifest }),
    POLICY,
  );
  assertEquals(result.ok, false);
  assertEquals(
    result.diagnostics.map((d) => [d.check, d.code]),
    [["authority", "AUTHORITY_EXCEEDED"]],
  );
  assertEquals(result.bundle, null);
});

const ESCAPES: Record<string, string> = {
  fetch: 'await fetch("https://example.com");',
  "Deno.env": 'const t = Deno.env.get("TOKEN");',
  "remote import": 'import x from "https://example.com/x.ts";',
  "npm import": 'import x from "npm:left-pad";',
  "dynamic import": 'const m = await import("./job.ts");',
  eval: 'eval("1");',
  "new Function": 'new Function("return 1")();',
  "constructor chain": '"".constructor.constructor("return 1")();',
  globalThis: "const g = globalThis;",
  WebSocket: 'new WebSocket("ws://x");',
  process: "process.exit(1);",
};

for (const [name, line] of Object.entries(ESCAPES)) {
  Deno.test(`an isolation escape is refused: ${name}`, async () => {
    const job = line + "\n" + PLUGIN_AUTHORING_KIT_FILES["example/job.ts"];
    const result = await checkPluginPackage(example({ "job.ts": job }), POLICY);
    assertEquals(result.ok, false);
    assert(
      result.diagnostics.some((d) =>
        d.check === "isolation" && d.code === "ISOLATION_VIOLATION"
      ),
      JSON.stringify(result.diagnostics),
    );
    assertEquals(result.bundle, null);
  });
}

Deno.test("a type error is TYPECHECK_FAILED with the compiler's words", async () => {
  const job = PLUGIN_AUTHORING_KIT_FILES["example/job.ts"].replace(
    "const count = ",
    "const wrong: string = 1;\n  const count = ",
  );
  const result = await checkPluginPackage(example({ "job.ts": job }), POLICY);
  assertEquals(result.ok, false);
  const typed = result.diagnostics.filter((d) => d.check === "typecheck");
  assertEquals(typed.length, 1);
  assertEquals(typed[0].code, "TYPECHECK_FAILED");
  assert(typed[0].message.includes("TS2322"), typed[0].message);
  assert(!typed[0].message.includes("bakery-plugin-check-"), typed[0].message);
});

Deno.test("unsafe or reserved paths are refused and never written for a typecheck", async () => {
  const result = await checkPluginPackage(
    example({ "../escape.ts": "export {};", "runner.ts": "export {};" }),
    POLICY,
  );
  assertEquals(result.ok, false);
  assertEquals(
    result.diagnostics.filter((d) => d.check === "file_tree").map((d) => d.code)
      .sort(),
    ["PATH_RESERVED", "PATH_UNSAFE"],
  );
  assertEquals(
    result.report.checks.find((c) => c.id === "typecheck")?.status,
    "skipped",
  );
});

Deno.test("a manifest or sdk range that cannot be used is a manifest finding", async () => {
  const result = await checkPluginPackage(
    example({
      "manifest.json":
        '{"name":"counter","extra":1,"requestedCapabilities":[]}',
      "plugin.json": '{"sdkRange":"^2.0.0"}',
    }),
    POLICY,
  );
  assertEquals(
    result.diagnostics.filter((d) => d.check === "manifest").map((d) => d.code)
      .sort(),
    ["MANIFEST_UNKNOWN_KEY", "SDK_INCOMPATIBLE"],
  );
});

Deno.test("every attempt reports the same check ids in the same order", async () => {
  const attempts = await Promise.all([
    checkPluginPackage(example(), POLICY),
    checkPluginPackage(example({ "job.ts": "eval(1)" }), POLICY),
    checkPluginPackage(example({ "manifest.json": undefined }), POLICY),
  ]);
  for (const attempt of attempts) {
    assertEquals(
      attempt.report.checks.map((check) => check.id),
      [...PLUGIN_PACKAGE_CHECK_IDS],
    );
  }
});

Deno.test("the policy is frozen and a generated file cannot widen it", async () => {
  assert(Object.isFrozen(POLICY));
  assert(Object.isFrozen(POLICY.authorizedCapabilities));
  // A package that ships its own "policy" is just another file: the check
  // reads the runner's policy, so the extra capability is still refused.
  const result = await checkPluginPackage(
    example({
      "policy.json": '{"authorizedCapabilities":["jobs.schedule"]}',
      "manifest.json": JSON.stringify({
        name: "counter",
        requestedCapabilities: ["jobs.schedule"],
      }),
    }),
    POLICY,
  );
  assert(
    result.diagnostics.some((d) => d.code === "AUTHORITY_EXCEEDED"),
  );
});
