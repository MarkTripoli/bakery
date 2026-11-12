import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type { JsonValue } from "../../packages/contracts/src/contracts.ts";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import {
  deriveSkillPublicationIdentity,
  deriveSkillVersionId,
  skillObjectKey,
} from "../../apps/server/src/modules/catalog/identity.ts";
import {
  SkillFileStore,
  SkillFileStoreError,
} from "../../apps/server/src/modules/catalog/storage.ts";
import {
  type LocalSkillVersionInput,
  MAX_DECODED_FILE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_PATH_LENGTH,
  MAX_UPLOAD_FILES,
  validateLocalSkillVersion,
} from "../../apps/server/src/modules/catalog/validation.ts";
import {
  checksumSql,
  loadMigrations,
  MigrationOwner,
  validateMigrations,
} from "../../apps/server/src/platform/migration-definition.ts";
import {
  assertMigrationAppendOrder,
  bakeryPlatformMigrationSource,
} from "../../apps/server/src/platform/migrate.ts";
import { agentsBakeryMigrationSource } from "../../apps/server/src/modules/agents/migrations.ts";
import { repositoryRulesBakeryMigrationSource } from "../../apps/server/src/modules/repository-rules/migrations.ts";
import { integrationsBakeryMigrationSource } from "../../apps/server/src/modules/integrations/migrations.ts";
import { deliveryBakeryMigrationSource } from "../../apps/server/src/modules/delivery/migrations.ts";
import { authBakeryMigrationSource } from "../../apps/server/src/modules/auth/migrations.ts";
import { projectsBakeryMigrationSource } from "../../apps/server/src/modules/projects/migrations.ts";
import { workBakeryMigrationSource } from "../../apps/server/src/modules/work/migrations.ts";

Deno.test("Bakery migrations follow the globally unique migration sequence", async () => {
  const current = [
    ...await loadMigrations(bakeryPlatformMigrationSource),
    ...await loadMigrations(authBakeryMigrationSource),
    ...await loadMigrations(workBakeryMigrationSource),
    ...await loadMigrations(projectsBakeryMigrationSource),
    ...await loadMigrations(agentsBakeryMigrationSource),
    ...await loadMigrations(repositoryRulesBakeryMigrationSource),
    ...await loadMigrations(integrationsBakeryMigrationSource),
    ...await loadMigrations(deliveryBakeryMigrationSource),
  ];
  for (
    const [version, error] of [
      ["0055_skill_catalog", "SKILL_CATALOG_MIGRATION_MISSING"],
      ["0056_agent_definitions", "AGENT_DEFINITIONS_MIGRATION_MISSING"],
      [
        "0057_issue286_prepared_operations",
        "PREPARED_OPERATIONS_MIGRATION_MISSING",
      ],
      ["0058_pinned_skill_import", "PINNED_SKILL_IMPORT_MIGRATION_MISSING"],
      [
        "0059_job_agent_assignment_insert_privileges",
        "JOB_AGENT_ASSIGNMENT_INSERT_PRIVILEGES_MIGRATION_MISSING",
      ],
      ["0060_exact_budget_accounting", "EXACT_BUDGET_MIGRATION_MISSING"],
      [
        "0067_exact_budget_accounting_provenance",
        "EXACT_BUDGET_PROVENANCE_MIGRATION_MISSING",
      ],
      ["0068_collaborative_drafts", "COLLABORATIVE_DRAFTS_MIGRATION_MISSING"],
      [
        "0069_harness_session_admission",
        "HARNESS_SESSION_ADMISSION_MIGRATION_MISSING",
      ],
      ["0070_user_preferences", "USER_PREFERENCES_MIGRATION_MISSING"],
      [
        "0071_organization_default_locale_optional",
        "ORGANIZATION_DEFAULT_LOCALE_MIGRATION_MISSING",
      ],
    ] as const
  ) {
    if (!current.some((migration) => migration.version === version)) {
      throw new Error(error);
    }
  }
  const migrationNumbers = current.map(({ version }) => version.slice(0, 4));
  assertEquals(new Set(migrationNumbers).size, migrationNumbers.length);

  const currentTail = await validateMigrations(
    current.filter(({ version }) => version >= "0051"),
    MigrationOwner.Bakery,
  );
  assertEquals(
    currentTail.map(({ version }) => version),
    [
      "0051_project_secret_revoke",
      "0052_project_secret_rotation_policy",
      "0053_output_reader",
      "0054_shared_conversation_turns",
      "0055_skill_catalog",
      "0056_agent_definitions",
      "0057_issue286_prepared_operations",
      "0058_pinned_skill_import",
      "0059_job_agent_assignment_insert_privileges",
      "0060_exact_budget_accounting",
      "0061_exact_budget_accounting_reconciliation",
      "0062_exact_budget_accounting_privileges",
      "0063_exact_budget_accounting_historical_readback",
      "0064_exact_budget_accounting_provider_authority",
      "0065_exact_budget_accounting_release_evidence",
      "0066_exact_budget_accounting_release_evidence_attempt",
      "0067_exact_budget_accounting_provenance",
      "0068_collaborative_drafts",
      "0069_harness_session_admission",
      "0070_user_preferences",
      "0071_organization_default_locale_optional",
      "0072_oauth_grant_revocations",
      "0073_oauth_grant_activity",
      "0074_artifact_retention",
      "0075_artifact_comments",
      "0076_output_transcript_archive",
      "0077_installation_settings",
      "0078_permission_roles",
      "0079_audit_events_installation_scope",
      "0080_set_installation_license_function",
      "0081_access_tokens",
      "0085_access_bindings",
      "0090_audit_retention",
      "0095_scim_connections",
      "0100_organization_roles",
      "0105_organization_sso_settings",
      "0106_conversation_turn_runtime",
      "0110_questions",
      "0111_worker_adapter_capabilities",
      "0115_plan_revisions_approvals",
      "0120_coordination_plans",
      "0121_task_repositories_update_grant",
      "0122_output_transcript_finalization",
      "0123_provider_call_attempt_attribution",
      "0124_issue59_machine_readiness",
      "0125_coordinator_turn_jobs",
      "0126_workflow_drafts",
      "0127_external_effects",
      "0128_organization_repository_rule_versions",
      "0129_integration_app_registrations",
      "0130_integration_auth_attempts",
      "0131_integration_installations",
      "0132_integration_connections",
      "0133_integration_auth_attempt_callbacks",
      "0134_integration_resources",
      "0135_integration_reconnect_and_effect_keys",
      "0136_integration_app_registration_updates",
      "0137_integration_resources_selected_unique",
      "0138_integration_discoveries",
      "0139_skill_storage_settings",
      "0140_artifact_preview_grants",
      "0141_coordination_plan_origin",
      "0142_check_runs",
      "0143_github_intake",
      "0145_ticket_admission",
      "0146_drop_installation_license",
      "0147_review_cycles",
      "0148_workflow_version_compiler_pin",
      "0149_external_identity_links",
      "0151_domain_event_traceparent",
      "0153_slack_identity_attempts",
    ],
  );
});

Deno.test("a ledger at migration 0055 rejects a newly introduced 0052", () => {
  assertThrows(
    () =>
      assertMigrationAppendOrder(
        "0052_agent_definitions",
        "0055_skill_catalog",
      ),
    Error,
    "MIGRATION_ORDER_VIOLATION:0052_agent_definitions",
  );
  assertMigrationAppendOrder(
    "0055_skill_catalog",
    "0054_shared_conversation_turns",
  );
});

Deno.test("duplicate catalog migration names remain invalid", async () => {
  const sql = "select 1;\n";
  const migration = {
    owner: MigrationOwner.Bakery,
    version: "0055_skill_catalog",
    sql,
    checksum: await checksumSql(sql),
  };
  await assertRejects(
    () => validateMigrations([migration, migration], MigrationOwner.Bakery),
    Error,
    "MIGRATION_NAME_INVALID",
  );
});

async function digest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  const result = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(result),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

Deno.test("local skill validation canonicalizes the complete manifest and file inventory", async () => {
  const content = new TextEncoder().encode("hello\\n");
  const fileSha256 = await digest(content);
  const manifest = {
    files: [{
      isExecutable: false,
      mediaType: "text/plain",
      path: "SKILL.md",
      sha256: fileSha256,
      sizeBytes: content.byteLength,
    }],
    license: "MIT",
    schemaVersion: 1,
    entryPath: "SKILL.md",
  };
  const canonical = canonicalJson(manifest);
  const input: LocalSkillVersionInput = {
    id: "22222222-2222-4222-8222-222222222222",
    revision: 1,
    digest: await digest(canonical),
    entryPath: "SKILL.md",
    manifest,
    files: [{
      path: "SKILL.md",
      mediaType: "text/plain",
      isExecutable: false,
      contentBase64: btoa(String.fromCharCode(...content)),
    }],
  };
  const validated = await validateLocalSkillVersion(input);
  assertEquals(validated.digest, input.digest);
  assertEquals(validated.files[0].sha256, fileSha256);
  assertEquals(validated.files[0].sizeBytes, content.byteLength);
  await assertRejects(
    () =>
      validateLocalSkillVersion({
        ...input,
        files: [{ ...input.files[0], contentBase64: "aA== " }],
      }),
    Error,
    "SKILL_UPLOAD_INVALID:BASE64",
  );
  await assertRejects(
    () =>
      validateLocalSkillVersion({
        ...input,
        files: [{ ...input.files[0], path: "scripts/../SKILL.md" }],
      }),
    Error,
    "SKILL_UPLOAD_INVALID:PATH_UNSAFE",
  );
});

function encodeBase64(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(result);
}

type UploadFile = Readonly<{
  path: string;
  content: Uint8Array;
  mediaType?: string;
  isExecutable?: boolean;
}>;

type TestManifestFile = {
  [key: string]: string | number | boolean;
  path: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  isExecutable: boolean;
};

type TestUpload = Omit<LocalSkillVersionInput, "manifest"> & {
  manifest: {
    schemaVersion: number;
    license: string;
    entryPath: string;
    files: TestManifestFile[];
    [key: string]: JsonValue;
  };
};

async function validUpload(
  files: readonly UploadFile[],
  manifestExtra: Record<string, JsonValue> = {},
): Promise<TestUpload> {
  const manifestFiles = await Promise.all(files.map(async (file) => ({
    path: file.path,
    mediaType: file.mediaType ?? "text/plain",
    sizeBytes: file.content.byteLength,
    sha256: await digest(file.content),
    isExecutable: file.isExecutable ?? false,
  })));
  const entryPath = files[0]?.path ?? "SKILL.md";
  const manifest: TestUpload["manifest"] = {
    schemaVersion: 1,
    license: "MIT",
    entryPath,
    files: manifestFiles,
    ...manifestExtra,
  };
  return {
    id: "22222222-2222-4222-8222-222222222222",
    revision: 1,
    digest: await digest(canonicalJson(manifest)),
    entryPath,
    manifest,
    files: files.map((file) => ({
      path: file.path,
      mediaType: file.mediaType ?? "text/plain",
      isExecutable: file.isExecutable ?? false,
      contentBase64: encodeBase64(file.content),
    })),
  };
}

async function assertUploadInvalid(
  input: LocalSkillVersionInput,
  code: string,
): Promise<void> {
  await assertRejects(
    () => validateLocalSkillVersion(input),
    Error,
    `SKILL_UPLOAD_INVALID:${code}`,
  );
}

Deno.test("local skill validation rejects path, inventory, digest, media, and executable counterexamples", async () => {
  const content = new TextEncoder().encode("same bytes");
  const baseline = await validUpload([
    { path: "SKILL.md", content },
    { path: "references/guide.md", content },
  ]);
  const accepted = await validateLocalSkillVersion(baseline);
  assertEquals(accepted.files.length, 2);
  assertEquals(accepted.files[0].sha256, accepted.files[1].sha256);

  for (
    const path of [
      "/SKILL.md",
      "folder\\SKILL.md",
      "folder\0SKILL.md",
      "folder//SKILL.md",
      "folder/./SKILL.md",
      "folder/../SKILL.md",
      `${"a".repeat(MAX_PATH_LENGTH + 1)}.md`,
    ]
  ) {
    const candidate = structuredClone(baseline);
    candidate.files[0].path = path;
    await assertUploadInvalid(
      candidate,
      path.length > MAX_PATH_LENGTH ? "PATH_BOUNDS" : "PATH_UNSAFE",
    );
  }

  for (
    const paths of [
      ["A.md", "a.md"],
      ["\u00e9.md", "e\u0301.md"],
      ["ς.md", "σ.md"],
      ["ß.md", "ss.md"],
      ["ﬃ.md", "ffi.md"],
    ]
  ) {
    const candidate = await validUpload(paths.map((path) => ({
      path,
      content,
    })));
    await assertUploadInvalid(candidate, "PATH_COLLISION");
  }

  const nonColliding = await validUpload([
    { path: "ssy.md", content },
    { path: "ßx.md", content },
    { path: "ς.md", content },
    { path: "σx.md", content },
  ]);
  assertEquals((await validateLocalSkillVersion(nonColliding)).files.length, 4);

  const missingEntry = structuredClone(baseline);
  missingEntry.entryPath = "missing.md";
  await assertUploadInvalid(missingEntry, "ENTRY_PATH");

  const inventoryMismatch = structuredClone(baseline);
  inventoryMismatch.files[1].path = "references/other.md";
  await assertUploadInvalid(inventoryMismatch, "MANIFEST_FILES");

  const mediaMismatch = structuredClone(baseline);
  mediaMismatch.files[0].mediaType = "text/markdown";
  await assertUploadInvalid(mediaMismatch, "MEDIA_TYPE");

  const executableMismatch = structuredClone(baseline);
  executableMismatch.files[0].isExecutable = true;
  await assertUploadInvalid(executableMismatch, "EXECUTABLE_POLICY");

  const executableMedia = await validUpload([{
    path: "image.png",
    content,
    mediaType: "image/png",
    isExecutable: true,
  }]);
  await assertUploadInvalid(executableMedia, "EXECUTABLE_MEDIA");

  const sizeMismatch = structuredClone(baseline);
  (sizeMismatch.manifest.files as Array<{ sizeBytes: number }>)[0].sizeBytes++;
  await assertUploadInvalid(sizeMismatch, "FILE_SIZE");

  const hashMismatch = structuredClone(baseline);
  (hashMismatch.manifest.files as Array<{ sha256: string }>)[0].sha256 = "f"
    .repeat(64);
  await assertUploadInvalid(hashMismatch, "FILE_HASH");

  const digestMismatch = structuredClone(baseline);
  digestMismatch.digest = "f".repeat(64);
  await assertUploadInvalid(digestMismatch, "MANIFEST_DIGEST");

  const invalidSchema = structuredClone(baseline);
  invalidSchema.manifest.schemaVersion = 2;
  await assertUploadInvalid(invalidSchema, "MANIFEST_SCHEMA");

  const invalidLicense = structuredClone(baseline);
  invalidLicense.manifest.license = "MIT\n";
  await assertUploadInvalid(invalidLicense, "LICENSE");
});

Deno.test("local skill validation rejects direct count, decoded-byte, and manifest bounds", async () => {
  const content = new Uint8Array();
  const tooMany = await validUpload(
    Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, index) => ({
      path: `files/${index}.txt`,
      content,
    })),
  );
  await assertUploadInvalid(tooMany, "MANIFEST_FILES");

  const tooManyUploads = await validUpload([{
    path: "SKILL.md",
    content,
  }]);
  tooManyUploads.files = Array.from(
    { length: MAX_UPLOAD_FILES + 1 },
    () => ({ ...tooManyUploads.files[0] }),
  );
  await assertUploadInvalid(tooManyUploads, "FILE_COUNT");

  const tooLarge = await validUpload([{
    path: "SKILL.md",
    content,
  }]);
  tooLarge.files[0].contentBase64 = "A".repeat(
    4 * Math.ceil((MAX_DECODED_FILE_BYTES + 1) / 3),
  );
  tooLarge.manifest.files[0].sizeBytes = MAX_DECODED_FILE_BYTES + 1;
  await assertUploadInvalid(tooLarge, "FILE_BYTES");

  const oversizedManifest = await validUpload(
    [{ path: "SKILL.md", content }],
    { notes: "x".repeat(MAX_MANIFEST_BYTES) },
  );
  await assertUploadInvalid(oversizedManifest, "MANIFEST_BYTES");
});

Deno.test("local skill identity is deterministic UUIDv8 with exact retry keys", async () => {
  const options = {
    organizationId: "11111111-1111-4111-8111-111111111111",
    skillId: "22222222-2222-4222-8222-222222222222",
    revision: 1,
    digest: "a".repeat(64),
  };
  assertEquals(
    await deriveSkillVersionId(options),
    "2f90d00e-f21a-88fa-933c-2eaa22105692",
  );
  const identity = await deriveSkillPublicationIdentity({
    ...options,
    fileDigests: ["b".repeat(64)],
  });
  assertEquals(identity.objectKeys, [
    skillObjectKey(options.organizationId, identity.versionId, "b".repeat(64)),
  ]);
  assertEquals(identity.versionId, await deriveSkillVersionId(options));
  assertStringIncludes(identity.versionId, "-8");
});

function storeKey(sha256: string): string {
  return skillObjectKey(
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    sha256,
  );
}

Deno.test("local skill file store handles same-key retries, mismatch, and concurrent writers", async () => {
  if (Deno.build.os !== "linux") return;
  const root = await Deno.makeTempDir({ prefix: "bakery-skill-store-" });
  const store = new SkillFileStore(root);
  const content = new TextEncoder().encode("immutable");
  const fileSha256 = await digest(content);
  const key = storeKey(fileSha256);
  try {
    await Promise.all(
      Array.from(
        { length: 8 },
        () => store.putIfAbsent(key, content, fileSha256),
      ),
    );
    await store.putIfAbsent(key, content, fileSha256);
    assertEquals(
      await store.read(key, fileSha256, content.byteLength),
      content,
    );
    const mismatch = new TextEncoder().encode("different");
    const mismatchSha256 = await digest(mismatch);
    await assertRejects(
      () => store.putIfAbsent(key, mismatch, mismatchSha256),
      SkillFileStoreError,
      "SKILL_CONTENT_INTEGRITY_FAILED",
    );
    await assertRejects(
      () => store.read(key, "f".repeat(64), content.byteLength),
      SkillFileStoreError,
      "SKILL_CONTENT_INTEGRITY_FAILED",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("local skill file store rejects symlinks, non-files, unsafe modes, owners, and hard links", async () => {
  if (Deno.build.os !== "linux") return;
  const root = await Deno.makeTempDir({ prefix: "bakery-skill-store-" });
  const store = new SkillFileStore(root);
  const content = new TextEncoder().encode("immutable");
  const fileSha256 = await digest(content);
  const key = storeKey(fileSha256);
  const path = `${root}/${key}`;
  try {
    await store.putIfAbsent(key, content, fileSha256);
    await Deno.chmod(path, 0o644);
    await assertRejects(
      () => store.read(key, fileSha256, content.byteLength),
      SkillFileStoreError,
      "SKILL_FILE_OBJECT_UNSAFE",
    );
    await Deno.remove(path);
    await Deno.mkdir(path, { mode: 0o700 });
    await assertRejects(
      () => store.read(key, fileSha256, content.byteLength),
      SkillFileStoreError,
      "SKILL_FILE_OBJECT_UNSAFE",
    );
    await Deno.remove(path);
    await Deno.symlink("/etc/passwd", path);
    await assertRejects(
      () => store.read(key, fileSha256, content.byteLength),
      SkillFileStoreError,
      "SKILL_FILE_SYMLINK",
    );
    await Deno.remove(path);
    await store.putIfAbsent(key, content, fileSha256);
    await Deno.link(path, `${path}.unknown-link`);
    await assertRejects(
      () => store.recover(key, fileSha256, content.byteLength),
      SkillFileStoreError,
      "SKILL_FILE_ORPHAN_UNSAFE",
    );
    const wrongOwner = new SkillFileStore(root, (Deno.uid() ?? 0) + 1);
    await assertRejects(
      () => wrongOwner.initialize(),
      SkillFileStoreError,
      "SKILL_FILE_DIRECTORY_UNSAFE",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("local skill file store rejects unsafe fan-out and sampled parent replacement", async () => {
  if (Deno.build.os !== "linux") return;
  const content = new TextEncoder().encode("immutable");
  const fileSha256 = await digest(content);
  const key = storeKey(fileSha256);

  const symlinkRoot = await Deno.makeTempDir({
    prefix: "bakery-skill-store-symlink-",
  });
  try {
    await Deno.symlink("/tmp", `${symlinkRoot}/organizations`);
    await assertRejects(
      () =>
        new SkillFileStore(symlinkRoot).putIfAbsent(
          key,
          content,
          fileSha256,
        ),
      SkillFileStoreError,
      "SKILL_FILE_SYMLINK",
    );
  } finally {
    await Deno.remove(symlinkRoot, { recursive: true });
  }

  const changedRoot = await Deno.makeTempDir({
    prefix: "bakery-skill-store-parent-",
  });
  let movedParent: string | undefined;
  try {
    const store = new SkillFileStore(changedRoot, Deno.uid() ?? 0, {
      hooks: {
        beforeLink: async ({ parent }) => {
          movedParent = `${parent}.moved`;
          await Deno.rename(parent, movedParent);
          await Deno.mkdir(parent, { mode: 0o700 });
        },
      },
    });
    await assertRejects(
      () => store.putIfAbsent(key, content, fileSha256),
      SkillFileStoreError,
      "SKILL_FILE_PARENT_CHANGED",
    );
    assertEquals(typeof movedParent, "string");
  } finally {
    await Deno.remove(changedRoot, { recursive: true });
  }
});

Deno.test("local skill file store fails closed on unsafe roots and unsupported platforms", async () => {
  if (Deno.build.os !== "linux") return;
  const root = await Deno.makeTempDir({ prefix: "bakery-skill-store-root-" });
  try {
    await Deno.chmod(root, 0o755);
    await assertRejects(
      () => new SkillFileStore(root).initialize(),
      SkillFileStoreError,
      "SKILL_FILE_DIRECTORY_UNSAFE",
    );
    assertThrows(
      () => new SkillFileStore(root, Deno.uid() ?? 0, { platform: "darwin" }),
      SkillFileStoreError,
      "SKILL_FILE_STORE_UNSUPPORTED",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
