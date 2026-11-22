import { assert, assertEquals } from "@std/assert";
import {
  isClassifiedPluginVersionForeignKey,
  pluginBundleNeutralReferences,
  pluginBundleProtection,
  pluginBundleReferences,
} from "../../apps/server/src/modules/catalog/retention/bundle-references.ts";

/**
 * A rail for plugin bundle retention, and for what the rail can see.
 *
 * #15 asked for "retained state/evidence follows policy". The artifact rail
 * answered that for artifact versions and, because it only walks foreign keys
 * that point at `artifact_versions`, said nothing at all about plugin bundles:
 * its green was true and its coverage was narrower than the green implied. So
 * this file does two jobs — it classifies every foreign key that can keep a
 * plugin bundle alive, and it states out loud which relation it inspects, so a
 * future table cannot be added in the gap and be mistaken for classification.
 */

const MIGRATION_ROOTS = [
  "apps/server/src/modules/catalog/migrations",
];

async function* migrationFiles(): AsyncGenerator<string> {
  for (const root of MIGRATION_ROOTS) {
    for await (const entry of walk(root)) {
      if (entry.path.endsWith(".sql")) yield entry.path;
    }
  }
}

async function* walk(path: string): AsyncGenerator<{ path: string }> {
  try {
    for await (const entry of Deno.readDir(path)) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory) yield* walk(child);
      else yield { path: child };
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}

/** Each statement in a migration, with the table it creates or alters. */
function statements(sql: string): { table: string | null; text: string }[] {
  return sql.split(";").map((text) => ({
    table: /(?:create|alter)\s+table\s+bakery\.(\w+)/i.exec(text)?.[1] ?? null,
    text,
  }));
}

Deno.test("every foreign key to plugin_versions is classified, so collection cannot miss one", async () => {
  let found = 0;
  for await (const path of migrationFiles()) {
    const sql = await Deno.readTextFile(path);
    for (const statement of statements(sql)) {
      const total = [
        ...statement.text.matchAll(
          /references\s+bakery\.plugin_versions\s*\(/gi,
        ),
      ].length;
      if (total === 0) continue;
      // Each reference is paired with its own constraint: a statement can name
      // several keys, so matching the first constraint in it and calling that
      // the one would classify the wrong column.
      const named = [
        ...statement.text.matchAll(
          /constraint\s+(\w+)\s+foreign\s+key\s*\([^)]*\)\s*references\s+bakery\.plugin_versions/gi,
        ),
      ];
      assert(
        named.length === total,
        `Every foreign key to plugin_versions must be a named table constraint: ${path}`,
      );
      for (const match of named) {
        found++;
        assert(
          statement.table &&
            isClassifiedPluginVersionForeignKey(statement.table, match[1]),
          `Unclassified plugin bundle reference: ${path} ${statement.table}.${
            match[1]
          }`,
        );
      }
    }
  }
  // A rail that silently found nothing would pass forever.
  assert(found >= 1, "at least the install reference is classified");
  assertEquals(
    isClassifiedPluginVersionForeignKey("plugin_installs", "made_up_fk"),
    false,
  );
});

Deno.test("only an install and the snapshot an install keeps keep a bundle alive", () => {
  // Stated as a test because it is the whole retention rule: everything that
  // is not `active` is collectable once the version is withdrawn or unpublished.
  // A snapshot is the way back to the version it came from (#34), so it wants
  // the bytes for as long as its install can still be moved.
  const active = pluginBundleReferences.filter((entry) =>
    entry.protection === "active"
  );
  assertEquals(active.map((entry) => entry.table).sort(), [
    "plugin_install_snapshots",
    "plugin_installs",
  ]);
  assertEquals(
    pluginBundleProtection(
      "plugin_installs",
      "plugin_installs_package_version_fk",
    ),
    "active",
  );
  assertEquals(
    pluginBundleProtection(
      "plugin_install_snapshots",
      "plugin_install_snapshots_version_fk",
    ),
    "active",
  );
  for (const entry of pluginBundleNeutralReferences) {
    assertEquals(pluginBundleProtection(entry.table, entry.constraint), "none");
  }
  assertEquals(pluginBundleProtection("plugin_installs", "nope"), null);
});

Deno.test("the rail states which relation it inspects", async () => {
  // The scope is the point. If plugin bundles ever move to another reference
  // (a shared archive table, a second install kind), the rail must be widened
  // in the same change rather than continuing to pass on the old relation.
  const sql = await Deno.readTextFile(
    "apps/server/src/modules/catalog/migrations/bakery/0218_plugin_bundle_retention.sql",
  );
  assert(
    sql.includes("bundle_purged_at"),
    "the tombstone column exists for the rail to read",
  );
  assert(
    /grant update \(bundle_purged_at, purge_policy\)/.test(sql),
    "collection writes exactly the tombstone, never the manifest or digest",
  );
  const references = await Deno.readTextFile(
    "apps/server/src/modules/catalog/retention/bundle-references.ts",
  );
  assert(
    references.includes("plugin_versions"),
    "the registry names the relation it classifies",
  );
});

Deno.test("every writer and deleter of an object locks the same key", async () => {
  // A static pin, not a timing test: it proves all three sides name one key
  // through one function, which is the part an edit can break silently. That
  // each holds it across its own write or delete is visible in each function.
  const reader = (path: string) =>
    Deno.readTextFile(new URL(`../../${path}`, import.meta.url));
  const lock = await reader("apps/server/src/platform/blob-key-lock.ts");
  assert(
    lock.includes("return `${organizationId}:${objectRef}`;"),
    "the key is the tenant and the object ref, so two tenants never collide",
  );

  for (
    const [label, path] of [
      [
        "the collector",
        "apps/server/src/modules/catalog/retention/collect-bundle.ts",
      ],
      [
        "the version writer",
        "apps/server/src/modules/catalog/plugin-postgres.ts",
      ],
      ["the blob recorder", "apps/server/src/modules/knowledge/blobs.ts"],
    ] as const
  ) {
    const source = await reader(path);
    const at = source.indexOf("pg_advisory_xact_lock");
    assert(at > 0, `${label} takes the object lock`);
    assert(
      source.slice(at, at + 200).includes("blobKeyLock("),
      `${label} names the key the one way`,
    );
  }

  // Each side takes the lock before the thing it protects.
  const collect = await reader(
    "apps/server/src/modules/catalog/retention/collect-bundle.ts",
  );
  assert(
    collect.indexOf("pg_advisory_xact_lock") < collect.indexOf("store.delete("),
    "the collector holds the lock while it deletes bytes",
  );
  const writer = await reader(
    "apps/server/src/modules/catalog/plugin-postgres.ts",
  );
  assert(
    writer.indexOf("pg_advisory_xact_lock") <
      writer.indexOf("insert into bakery.plugin_versions"),
    "the version writer holds the lock while it inserts",
  );
  const recorder = await reader("apps/server/src/modules/knowledge/blobs.ts");
  assert(
    recorder.indexOf("pg_advisory_xact_lock") <
      recorder.indexOf("insert into bakery.blobs"),
    "the blob recorder holds the lock while it records the claim",
  );
});
