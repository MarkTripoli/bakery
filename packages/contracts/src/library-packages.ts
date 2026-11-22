import { z } from "zod";
import { ArtifactKindDefinitionSchema } from "./artifact-kinds.ts";
import { canonicalJson, sha256Hex } from "./workflow-compiler/canonical.ts";

/**
 * The T0 package (chapter 25 section 6, O6, O7): validated data and nothing
 * else. A package carries definitions that other organizations can import as
 * drafts. It never carries code, so the format has no field that accepts any,
 * and it never carries what belongs to one installation: grants, credentials,
 * connections, repository bindings, run history or active starts.
 *
 * Every item is addressed by a digest of its canonical content, and the package
 * by a digest of its item digests, so an import can prove it received exactly
 * what an export wrote.
 */

export const PACKAGE_FORMAT_VERSION = 1;
export const MAX_PACKAGE_ITEMS = 50;
/** One workflow definition, as the workflow compiler's own limit allows. */
export const MAX_PACKAGE_WORKFLOW_BYTES = 100_000;

/** The kinds of item a T0 package can carry today. */
export const PACKAGE_ITEM_KINDS = ["workflow", "artifactKind"] as const;
export type PackageItemKind = (typeof PACKAGE_ITEM_KINDS)[number];

/**
 * A workflow as it travels: the canonical JSON of its definition plus the words
 * that name it. The definition is a string so its digest is the digest of
 * exactly these bytes, whatever reads it.
 */
export const WorkflowPackageDataSchema = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
    .describe(
      "Lowercase kebab-case slug the importing organization may change when it collides with one of its own.",
    ),
  name: z.string().min(1).max(120).describe(
    "Human-readable workflow name of at most 120 characters.",
  ),
  description: z.string().max(1000).describe(
    "What the workflow does, in at most 1000 characters.",
  ),
  definition: z.string().min(2).max(MAX_PACKAGE_WORKFLOW_BYTES).describe(
    "Canonical JSON of the workflow definition, personal skills already replaced by open slots.",
  ),
}).strict().describe(
  "One workflow in a package: its name and its canonical definition. Starts travel inside the definition as authored data and are never switched on by an import.",
);
export type WorkflowPackageData = z.output<typeof WorkflowPackageDataSchema>;

export const PackageItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workflow").describe("A workflow definition."),
    key: z.string().min(1).max(64).describe(
      "The workflow's slug in the exporting organization.",
    ),
    digest: z.string().regex(/^[0-9a-f]{64}$/).describe(
      "SHA-256 of the canonical JSON of kind, key and data.",
    ),
    data: WorkflowPackageDataSchema,
  }).strict().describe("A workflow item."),
  z.object({
    kind: z.literal("artifactKind").describe("An artifact kind definition."),
    key: z.string().min(1).max(64).describe("The kind's key."),
    digest: z.string().regex(/^[0-9a-f]{64}$/).describe(
      "SHA-256 of the canonical JSON of kind, key and data.",
    ),
    data: ArtifactKindDefinitionSchema,
  }).strict().describe("An artifact kind item."),
]).describe("One validated item of data a package carries.");
export type PackageItem = z.output<typeof PackageItemSchema>;

export const BakeryPackageSchema = z.object({
  formatVersion: z.literal(PACKAGE_FORMAT_VERSION).describe(
    "The package format; an importer refuses a version it does not know.",
  ),
  name: z.string().min(1).max(120).describe(
    "Human-readable package name of at most 120 characters.",
  ),
  items: z.array(PackageItemSchema).min(1).max(MAX_PACKAGE_ITEMS).describe(
    `The items, between 1 and ${MAX_PACKAGE_ITEMS}, with unique kind and key pairs.`,
  ),
  packageDigest: z.string().regex(/^[0-9a-f]{64}$/).describe(
    "SHA-256 of the canonical JSON of the item digests in order.",
  ),
}).strict().describe(
  "A T0 package: validated data only, addressed by digest, free of grants, credentials, connections, repository bindings, run history and active starts.",
);
export type BakeryPackage = z.output<typeof BakeryPackageSchema>;

/** What an item is before it has a digest. */
export type PackageItemDraft =
  | { kind: "workflow"; key: string; data: WorkflowPackageData }
  | {
    kind: "artifactKind";
    key: string;
    data: z.output<typeof ArtifactKindDefinitionSchema>;
  };

export function packageItemDigest(
  item: Pick<PackageItemDraft, "kind" | "key" | "data">,
): Promise<string> {
  return sha256Hex(
    canonicalJson({ kind: item.kind, key: item.key, data: item.data }),
  );
}

export function packageDigestOf(
  itemDigests: readonly string[],
): Promise<string> {
  return sha256Hex(canonicalJson(itemDigests));
}

/** Builds a package from items, computing every digest. */
export async function buildPackage(
  name: string,
  drafts: readonly PackageItemDraft[],
): Promise<BakeryPackage> {
  const items = await Promise.all(
    drafts.map(async (draft) => ({
      ...draft,
      digest: await packageItemDigest(draft),
    })),
  );
  return BakeryPackageSchema.parse({
    formatVersion: PACKAGE_FORMAT_VERSION,
    name,
    items,
    packageDigest: await packageDigestOf(items.map((item) => item.digest)),
  });
}

/**
 * Names that mark something belonging to one installation. A package refuses
 * any object member called one of these, at any depth of a workflow definition,
 * so an author cannot smuggle a grant or a credential through free-form data.
 * Matching is by exact member name after lowercasing and removing separators.
 */
export const INSTALLATION_ONLY_MEMBERS = Object.freeze(
  [
    "grant",
    "grants",
    "credential",
    "credentials",
    "secret",
    "secrets",
    "token",
    "tokens",
    "apikey",
    "password",
    "connection",
    "connections",
    "connectionid",
    "repositoryprofileid",
    "repositorybinding",
    "repositorybindings",
    "runs",
    "runhistory",
    "activation",
    "activations",
    "activestarts",
  ] as const,
);

const installationOnly = new Set<string>(INSTALLATION_ONLY_MEMBERS);

export type PackageDefect = Readonly<{
  code:
    | "digest_mismatch"
    | "package_digest_mismatch"
    | "duplicate_item"
    | "installation_only_member"
    | "workflow_definition_not_json"
    | "workflow_definition_not_canonical";
  path: readonly (string | number)[];
  message: string;
}>;

function memberDefects(
  value: unknown,
  path: readonly (string | number)[],
  out: PackageDefect[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      memberDefects(entry, [...path, index], out)
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [name, entry] of Object.entries(value)) {
    if (installationOnly.has(name.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
      out.push({
        code: "installation_only_member",
        path: [...path, name],
        message:
          `"${name}" belongs to one installation and never travels in a package.`,
      });
    }
    memberDefects(entry, [...path, name], out);
  }
}

/**
 * Every reason a package cannot be imported, found without touching a
 * database. Returns all defects at once. A package whose schema is wrong is not
 * reached here: parse it with `BakeryPackageSchema` first.
 */
export async function packageDefects(
  value: BakeryPackage,
): Promise<readonly PackageDefect[]> {
  const defects: PackageDefect[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    const identity = `${item.kind}:${item.key}`;
    if (seen.has(identity)) {
      defects.push({
        code: "duplicate_item",
        path: ["items", index],
        message: `${identity} appears more than once.`,
      });
    }
    seen.add(identity);
    if (await packageItemDigest(item) !== item.digest) {
      defects.push({
        code: "digest_mismatch",
        path: ["items", index, "digest"],
        message: `${identity} does not match its digest.`,
      });
    }
    if (item.kind === "workflow") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(item.data.definition);
      } catch {
        defects.push({
          code: "workflow_definition_not_json",
          path: ["items", index, "data", "definition"],
          message: `${identity} definition is not JSON.`,
        });
        continue;
      }
      if (canonicalJson(parsed) !== item.data.definition) {
        defects.push({
          code: "workflow_definition_not_canonical",
          path: ["items", index, "data", "definition"],
          message: `${identity} definition is not in canonical form.`,
        });
      }
      memberDefects(parsed, ["items", index, "data", "definition"], defects);
    }
  }
  if (
    await packageDigestOf(value.items.map((item) => item.digest)) !==
      value.packageDigest
  ) {
    defects.push({
      code: "package_digest_mismatch",
      path: ["packageDigest"],
      message: "The package digest does not match its items.",
    });
  }
  return defects;
}
