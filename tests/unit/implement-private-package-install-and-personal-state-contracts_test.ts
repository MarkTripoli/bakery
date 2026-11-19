import { assertEquals, assertThrows } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";
import {
  assertPluginNamespace,
  assertPluginStateKey,
  compareVersions,
  parsePluginManifest,
  parseSdkRange,
  parseVersion,
  PLUGIN_SDK_VERSION,
  PluginManifestError,
  satisfiesSdkRange,
  SdkRangeSyntaxError,
} from "@bakery/contracts/plugin-sdk";

/**
 * SDK range evaluation (#15, B14.01).
 *
 * The cases that matter are the refusals. A range this host cannot read must be
 * refused rather than assumed compatible, because "unparseable" and "fits" have
 * opposite consequences: the first refuses activation, the second permits it.
 */

const v = (major: number, minor: number, patch: number) => ({
  major,
  minor,
  patch,
});

Deno.test("versions order by component, not by string", () => {
  // "10.0.0" sorts before "9.0.0" as text, so the parse has to be numeric.
  assertEquals(compareVersions(v(10, 0, 0), v(9, 0, 0)) > 0, true);
  assertEquals(compareVersions(v(1, 2, 3), v(1, 2, 3)), 0);
  assertEquals(compareVersions(v(1, 2, 3), v(1, 2, 4)) < 0, true);
  assertEquals(compareVersions(v(1, 3, 0), v(1, 2, 9)) > 0, true);
});

Deno.test("a version must be three numeric components", () => {
  assertEquals(parseVersion("1.2.3"), v(1, 2, 3));
  // Anything looser is refused: guessing at "1.2" or "v1.2.3" would mean
  // guessing which of the missing or prefixed parts the publisher meant.
  for (const bad of ["1.2", "1", "v1.2.3", "1.2.3.4", "1.2.x", " 1.2.3 "]) {
    const trimmed = bad.trim();
    if (trimmed === "1.2.3") continue;
    assertThrows(() => parseVersion(bad), SdkRangeSyntaxError);
  }
});

Deno.test("caret allows the whole major, except on a 0.x major", () => {
  assertEquals(satisfiesSdkRange("^1.2.3", v(1, 2, 3)), true);
  assertEquals(satisfiesSdkRange("^1.2.3", v(1, 9, 0)), true);
  assertEquals(satisfiesSdkRange("^1.2.3", v(2, 0, 0)), false);
  assertEquals(satisfiesSdkRange("^1.2.3", v(1, 2, 2)), false);
  // 0.x is unstable by convention, so the caret narrows to the minor.
  assertEquals(satisfiesSdkRange("^0.2.3", v(0, 2, 9)), true);
  assertEquals(satisfiesSdkRange("^0.2.3", v(0, 3, 0)), false);
});

Deno.test("tilde allows patch updates within the named minor", () => {
  assertEquals(satisfiesSdkRange("~1.2.3", v(1, 2, 9)), true);
  assertEquals(satisfiesSdkRange("~1.2.3", v(1, 3, 0)), false);
  assertEquals(satisfiesSdkRange("~1.2.3", v(1, 2, 2)), false);
});

Deno.test("comparators and space-separated conjunctions hold", () => {
  assertEquals(satisfiesSdkRange(">=1.0.0", v(1, 0, 0)), true);
  assertEquals(satisfiesSdkRange(">1.0.0", v(1, 0, 0)), false);
  assertEquals(satisfiesSdkRange("<=1.0.0", v(1, 0, 0)), true);
  assertEquals(satisfiesSdkRange("<2.0.0", v(1, 9, 9)), true);
  // A conjunction is an intersection, not a union: both halves must hold.
  assertEquals(satisfiesSdkRange(">=1.0.0 <2.0.0", v(1, 5, 0)), true);
  assertEquals(satisfiesSdkRange(">=1.0.0 <2.0.0", v(2, 0, 0)), false);
});

Deno.test("a bare version is an exact pin and || is a union", () => {
  assertEquals(satisfiesSdkRange("1.0.0", v(1, 0, 0)), true);
  assertEquals(satisfiesSdkRange("1.0.0", v(1, 0, 1)), false);
  assertEquals(satisfiesSdkRange("=1.0.0", v(1, 0, 0)), true);
  assertEquals(satisfiesSdkRange("^2.0.0 || ^1.0.0", v(1, 4, 0)), true);
  assertEquals(satisfiesSdkRange("^2.0.0 || ^3.0.0", v(1, 4, 0)), false);
});

Deno.test("a range this host cannot read is refused, never assumed to fit", () => {
  for (const bad of ["", "   ", "latest", "1.x", "*", ">= 1.0.0", "^1.2"]) {
    assertThrows(() => parseSdkRange(bad), SdkRangeSyntaxError);
  }
  // The specific trap: a wildcard would mean "any version", which is the most
  // permissive reading available. Refusing is the only safe answer.
  assertThrows(() => satisfiesSdkRange("*"), SdkRangeSyntaxError);
});

Deno.test("the host SDK version satisfies its own minor-pinned range", () => {
  assertEquals(PLUGIN_SDK_VERSION, v(1, 0, 0));
  assertEquals(satisfiesSdkRange("^1.0.0"), true);
  assertEquals(satisfiesSdkRange(">=1.0.0 <2.0.0"), true);
  // A range for a future host is a legitimate publication, so this is false
  // rather than a throw - refusing the build would be the activation check's
  // job, not the parser's.
  assertEquals(satisfiesSdkRange("^2.0.0"), false);
});

Deno.test("the package and version vocabularies are validated in the contracts", () => {
  // These rules used to be CHECK constraints on 0193's tables. PostgreSQL owns
  // storage structure and relational integrity only, so the rules moved here,
  // where a refusal is a described validation error rather than a driver
  // exception. Each case below is one of the constraints that was removed.
  const pkg = contractSchemas.PluginPackageCreate;
  const packageBase = {
    name: "weather-tools",
    displayName: "Weather tools",
    license: "MIT",
    provenance: { author: "someone" },
  };
  assertEquals(pkg.safeParse(packageBase).success, true);
  for (
    const [field, value] of [
      ["name", "   "],
      ["name", ""],
      ["displayName", "  "],
    ] as const
  ) {
    assertEquals(
      pkg.safeParse({ ...packageBase, [field]: value }).success,
      false,
      `${field} accepted ${
        JSON.stringify(value)
      }, so the non-blank rule is gone`,
    );
  }

  const version = contractSchemas.PluginVersionCreate;
  const versionBase = {
    versionName: "1.0.0",
    sdkRange: "^1.0.0",
    manifest: {},
    bundleObjectRef: "bundles/a/1.0.0.tgz",
    bundleDigest: "a".repeat(64),
    sourceEvidence: {},
    buildEvidence: {},
  };
  assertEquals(version.safeParse(versionBase).success, true);
  for (
    const [label, patch] of [
      // The digest rule: lowercase hex, exactly 64 characters.
      ["uppercase digest", { bundleDigest: "A".repeat(64) }],
      ["short digest", { bundleDigest: "a".repeat(63) }],
      ["long digest", { bundleDigest: "a".repeat(65) }],
      ["non-hex digest", { bundleDigest: "z".repeat(64) }],
      ["blank version name", { versionName: " " }],
      ["blank sdk range", { sdkRange: "  " }],
      ["blank bundle ref", { bundleObjectRef: "\t" }],
    ] as const
  ) {
    assertEquals(
      version.safeParse({ ...versionBase, ...patch }).success,
      false,
      `${label} was accepted, so its rule is not enforced`,
    );
  }

  // The output vocabularies are closed too: a stored value outside them would
  // reach a client that cannot render it.
  assertEquals(
    contractSchemas.PluginPackage.safeParse({
      id: crypto.randomUUID(),
      organizationId: crypto.randomUUID(),
      name: "p",
      displayName: "P",
      provenance: {},
      license: "MIT",
      visibility: "public-ish",
      listingStatus: "unlisted",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    }).success,
    false,
    "an unknown visibility was accepted",
  );
});

/**
 * Manifest and state-namespace validation (#15, B14.01, slice 2, AC2).
 *
 * Every case here is a refusal, and each refusal is a capability question
 * rather than a formatting one: a manifest that names a capability the host does
 * not grant, a locale the host owns, or a namespace that reads as a path would
 * otherwise become authority nobody reviewed.
 */

const manifest = (overrides: Record<string, unknown> = {}) => ({
  name: "demo-plugin",
  requestedCapabilities: ["state.read", "state.write"],
  locales: ["demo-plugin.en"],
  stateSchemaVersion: 1,
  stateNamespaces: ["settings"],
  ...overrides,
});

Deno.test("a manifest that asks only for grantable capabilities is accepted", () => {
  const parsed = parsePluginManifest(manifest());
  assertEquals(parsed.requestedCapabilities, ["state.read", "state.write"]);
  assertEquals(parsed.stateNamespaces, ["settings"]);
  assertEquals(parsed.stateSchemaVersion, 1);
});

Deno.test("a capability outside the allowlist is refused, never filtered out", () => {
  // Filtering would leave an install whose grants disagree with its manifest.
  assertThrows(
    () =>
      parsePluginManifest(
        manifest({ requestedCapabilities: ["secrets.read"] }),
      ),
    PluginManifestError,
  );
  assertThrows(
    () => parsePluginManifest(manifest({ requestedCapabilities: ["*"] })),
    PluginManifestError,
  );
});

Deno.test("a locale that claims the host's namespace is refused", () => {
  // A plugin may ship its own catalog; it may not replace core Bakery copy.
  assertThrows(
    () => parsePluginManifest(manifest({ locales: ["bakery.en"] })),
    PluginManifestError,
  );
  assertEquals(
    parsePluginManifest(manifest({ locales: ["demo-plugin.fr"] })).locales,
    [
      "demo-plugin.fr",
    ],
  );
});

Deno.test("an unknown manifest key is refused rather than ignored", () => {
  // A key an author believed had an effect it does not have is a security bug
  // reported as a compatibility bug.
  assertThrows(
    () =>
      parsePluginManifest(manifest({ grantedCapabilities: ["tools.invoke"] })),
    PluginManifestError,
  );
});

Deno.test("a state namespace that reads as a path is refused", () => {
  for (const bad of ["../escape", "a/b", "a\\b", "", "Settings", "a\u0000b"]) {
    assertThrows(
      () => parsePluginManifest(manifest({ stateNamespaces: [bad] })),
      PluginManifestError,
      undefined,
      `namespace ${JSON.stringify(bad)} must be refused`,
    );
  }
  // The names a plugin legitimately uses still pass.
  for (const good of ["settings", "view-state", "com.example.thing"]) {
    assertPluginNamespace(good);
  }
});

Deno.test("a state key is bounded and cannot traverse", () => {
  assertPluginStateKey("theme");
  assertPluginStateKey("panel.order");
  for (const bad of ["", "..", "a/b", "x".repeat(129)]) {
    assertThrows(() => assertPluginStateKey(bad), PluginManifestError);
  }
});

Deno.test("a manifest is not an object, or has a bad schema version, is refused", () => {
  for (const bad of [null, [], "manifest", 42]) {
    assertThrows(() => parsePluginManifest(bad), PluginManifestError);
  }
  for (const version of [0, -1, 1.5, "1"]) {
    assertThrows(
      () => parsePluginManifest(manifest({ stateSchemaVersion: version })),
      PluginManifestError,
    );
  }
});
