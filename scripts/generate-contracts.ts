import {
  assertCompatible,
  assertDescribedJsonSchema,
  assertDescribedOpenApi,
  buildImplementedClientSchemas,
  generateContracts,
  type GeneratedContracts,
  type InventoryAction,
  toJsonSchema,
} from "../packages/contracts/src/contracts.ts";

type CompatibleDocument = Pick<GeneratedContracts, "actions" | "openapi">;

function normalizePrevious(value: unknown): CompatibleDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("base contract document must be an object");
  }
  const document = value as Record<string, unknown>;
  if (!document.openapi || typeof document.openapi !== "object") {
    throw new Error("base contract document must include OpenAPI metadata");
  }
  let actions = document.actions;
  if (document.schemaVersion === 1 && Array.isArray(document.operations)) {
    actions = document.operations.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("base contract operation must be an object");
      }
      const { operation, ...metadata } = entry as Record<string, unknown>;
      if (typeof operation !== "string" || !operation) {
        throw new Error("base contract operation must have a name");
      }
      return { ...metadata, action: operation };
    });
  }
  if (!Array.isArray(actions)) {
    throw new Error("base contract document must include actions");
  }
  return {
    actions: actions as InventoryAction[],
    openapi: document.openapi as Record<string, unknown>,
  };
}

const approvedMigrationPath =
  "docs/technical-design/contract-migrations/v1-unreleased-principal-organization-contracts.json";
export function isApprovedCompatibilityMigration(
  migration: unknown,
  options: {
    baseRef: string;
    resolvedBaseRef: string;
    compatibilityDigest: string;
  },
): boolean {
  if (!migration || typeof migration !== "object" || Array.isArray(migration)) {
    return false;
  }
  const document = migration as Record<string, unknown>;
  const fromBaseRefs = Array.isArray(document.fromBaseRefs)
    ? document.fromBaseRefs
    : [];
  return typeof document.id === "string" && document.id.trim().length > 0 &&
    fromBaseRefs.some((ref) =>
      ref === options.baseRef || ref === options.resolvedBaseRef
    ) &&
    document.status === "approved" &&
    document.allowBreaking === true &&
    typeof document.reason === "string" &&
    document.reason.trim().length > 0 &&
    document.targetCompatibilityDigest === options.compatibilityDigest;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}

async function assertFresh(path: string, expected: string): Promise<void> {
  let actual: Uint8Array;
  try {
    actual = await Deno.readFile(path);
  } catch {
    throw new Error(`generated file is missing or stale: ${path}`);
  }
  if (!bytesEqual(actual, new TextEncoder().encode(expected))) {
    throw new Error(`generated file is stale: ${path}`);
  }
}

if (import.meta.main) {
  const baseRefIndex = Deno.args.indexOf("--base-ref");
  const baseRef = baseRefIndex >= 0 ? Deno.args[baseRefIndex + 1] : undefined;
  if (baseRefIndex >= 0 && !baseRef) {
    throw new Error("--base-ref requires a value");
  }
  const migrationIndex = Deno.args.indexOf("--compatibility-migration");
  const migrationPath = migrationIndex >= 0
    ? Deno.args[migrationIndex + 1]
    : undefined;
  if (migrationIndex >= 0 && !migrationPath) {
    throw new Error("--compatibility-migration requires a value");
  }
  let previous: CompatibleDocument | undefined;
  if (baseRef) {
    const output = await new Deno.Command("git", {
      args: [
        "show",
        `${baseRef}:packages/contracts/generated/contracts.json`,
      ],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (output.success) {
      previous = normalizePrevious(
        JSON.parse(new TextDecoder().decode(output.stdout)),
      );
    } else {
      const commit = await new Deno.Command("git", {
        args: ["cat-file", "-e", `${baseRef}^{commit}`],
        stderr: "null",
      }).output();
      if (!commit.success) {
        throw new Error(`base ref is unavailable: ${baseRef}`);
      }
    }
  }
  const generated = generateContracts();
  if (previous) {
    let approvedBreakingMigration = false;
    if (migrationPath) {
      if (!baseRef) {
        throw new Error(
          "--compatibility-migration requires --base-ref",
        );
      }
      if (migrationPath !== approvedMigrationPath) {
        throw new Error(
          `unsupported compatibility migration path: ${migrationPath}`,
        );
      }
      const migration = JSON.parse(
        await Deno.readTextFile(migrationPath),
      ) as Record<string, unknown>;
      const resolvedBase = await new Deno.Command("git", {
        args: ["rev-parse", "--verify", `${baseRef}^{commit}`],
        stdout: "piped",
        stderr: "null",
      }).output();
      const resolvedBaseRef = resolvedBase.success
        ? new TextDecoder().decode(resolvedBase.stdout).trim()
        : baseRef;
      const fromBaseRefs = Array.isArray(migration.fromBaseRefs)
        ? migration.fromBaseRefs
        : [];
      const migrationAppliesToBase = fromBaseRefs.some((ref) =>
        ref === baseRef || ref === resolvedBaseRef
      );
      if (
        migrationAppliesToBase &&
        !isApprovedCompatibilityMigration(migration, {
          baseRef,
          resolvedBaseRef,
          compatibilityDigest: generated.compatibilityDigest,
        })
      ) {
        throw new Error(
          `compatibility migration does not approve generated contract for base ref ${baseRef}`,
        );
      }
      approvedBreakingMigration = migrationAppliesToBase;
    }
    if (!approvedBreakingMigration) assertCompatible(previous, generated);
  }
  const schemas = Object.fromEntries(
    Object.entries(generated.schemas).map((
      [name, schema],
    ) => [name, toJsonSchema(schema)]),
  );
  const document = {
    schemaVersion: 2,
    actions: generated.actions,
    implementedActions: generated.implementedActions,
    openapi: generated.openapi,
    compatibilityDigest: generated.compatibilityDigest,
    schemas,
  };
  for (const [name, schema] of Object.entries(document.schemas)) {
    assertDescribedJsonSchema(schema, `schemas.${name}`);
  }
  assertDescribedOpenApi(document.openapi);
  const contractsSource = `${JSON.stringify(document, null, 2)}\n`;
  const clientActions = generated.actions.filter((action) =>
    action.implemented
  );
  const clientSchemas = Object.fromEntries(
    Object.entries(buildImplementedClientSchemas()).map(([name, schema]) => [
      name,
      toJsonSchema(schema),
    ]),
  );
  const manifestSource = [
    "// Generated by scripts/generate-contracts.ts. Do not edit by hand.",
    "",
    `export const clientManifest = ${
      JSON.stringify(
        { actions: clientActions, schemas: clientSchemas },
        null,
        2,
      )
    } as const;`,
    "",
    "export type ClientManifest = typeof clientManifest;",
    'export type ClientActionDescriptor = ClientManifest["actions"][number];',
    "",
  ].join("\n");
  if (Deno.args.includes("--check")) {
    await assertFresh(
      "packages/contracts/generated/contracts.json",
      contractsSource,
    );
    await assertFresh(
      "packages/contracts/generated/client-manifest.ts",
      manifestSource,
    );
  } else {
    await Deno.mkdir("packages/contracts/generated", { recursive: true });
    await Deno.writeTextFile(
      "packages/contracts/generated/contracts.json",
      contractsSource,
    );
    await Deno.writeTextFile(
      "packages/contracts/generated/client-manifest.ts",
      manifestSource,
    );
  }
}
