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
export const PACKAGE_ITEM_KINDS = [
  "workflow",
  "artifactKind",
  "skill",
  "agent",
] as const;
export type PackageItemKind = (typeof PACKAGE_ITEM_KINDS)[number];

/**
 * A workflow as it travels: the canonical JSON of its definition plus the words
 * that name it. The definition is a string so its digest is the digest of
 * exactly these bytes, whatever reads it.
 */
/**
 * How one item of a package names another. A workflow step that used a skill or
 * an agent from the package carries this string where the exporting
 * organization had an id, and the importer swaps in the id it just made. An id
 * the package does not carry is removed and listed as an open binding, because
 * an id from another organization means nothing here.
 */
export const PACKAGE_REFERENCE_PATTERN =
  /^package:(skill|agent)\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export function packageReference(
  kind: "skill" | "agent",
  key: string,
): string {
  return `package:${kind}/${key}`;
}

export const OpenBindingSchema = z.object({
  path: z.string().max(500).describe(
    "JSON Pointer to the step or definition member that named something the package does not carry.",
  ),
  kind: z.enum(["skill", "agent"]).describe(
    "Whether the removed reference named a skill or an agent.",
  ),
  name: z.string().max(200).describe(
    "The name of the skill or agent in the exporting organization, so someone can rebind it by hand.",
  ),
}).strict().describe(
  "A reference the exporter removed because its target does not travel with the package.",
);
export type OpenBinding = z.output<typeof OpenBindingSchema>;

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
    "Canonical JSON of the workflow definition, personal skills already replaced by open slots, with references to skills and agents in the package written as package references.",
  ),
  openBindings: z.array(OpenBindingSchema).max(256).default([]).describe(
    "References removed because the skill or agent they named does not travel with the package.",
  ),
}).strict().describe(
  "One workflow in a package: its name and its canonical definition. Starts travel inside the definition as authored data and are never switched on by an import.",
);
export type WorkflowPackageData = z.output<typeof WorkflowPackageDataSchema>;

export const SkillPackageDataSchema = z.object({
  slug: z.string().min(1).max(120).describe(
    "Slug of the skill in the exporting organization, which the importer keeps when it is free.",
  ),
  name: z.string().min(1).max(200).describe("Display name of the skill."),
  entryPath: z.string().min(1).max(500).describe(
    "Path of the file the skill starts from.",
  ),
  manifest: z.record(
    z.string().describe("A manifest member name."),
    z.json().describe("A manifest member value."),
  ).describe(
    "The skill version's manifest exactly as it was published: schema version, license and per-file digests.",
  ),
  files: z.array(
    z.object({
      path: z.string().min(1).max(500).describe(
        "Path of the file in the skill.",
      ),
      mediaType: z.string().min(1).max(255).describe("Media type of the file."),
      isExecutable: z.boolean().describe("Whether the file is executable."),
      contentBase64: z.string().describe("The file's bytes, base64 encoded."),
    }).strict().describe("One file of the skill."),
  ).min(1).max(256).describe(
    "The files of the skill's active version.",
  ),
}).strict().describe(
  "One organization-scope skill: its active version's manifest and files. A skill is data and never runs from a package. Personal skills never travel.",
);
export type SkillPackageData = z.output<typeof SkillPackageDataSchema>;

export const AgentPackageDataSchema = z.object({
  slug: z.string().min(1).max(64).describe(
    "Slug of the agent in the exporting organization.",
  ),
  name: z.string().min(1).max(120).describe("Display name of the agent."),
  description: z.string().max(1000).describe("What the agent is for."),
  harness: z.enum(["pi", "claude_code", "codex", "mastra"]).describe(
    "The harness the agent runs under.",
  ),
  allowedCapabilities: z.array(
    z.string().min(1).max(100).describe("One capability name."),
  ).max(100).default([])
    .describe("Capabilities the agent may use."),
  skillBindings: z.record(
    z.string().min(1).max(100).describe(
      "The name the agent uses the skill by.",
    ),
    z.string().regex(PACKAGE_REFERENCE_PATTERN).describe(
      "A package reference to a skill the package carries.",
    ),
  ).default({}).describe(
    "Named skills the agent uses, each a package reference to a skill the package carries.",
  ),
}).strict().describe(
  "One agent's definition. Billing never travels: the billing account, provider route and pricing snapshot belong to the exporting organization, so an imported agent has none until someone gives it one.",
);
export type AgentPackageData = z.output<typeof AgentPackageDataSchema>;

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
  z.object({
    kind: z.literal("skill").describe("An organization-scope skill."),
    key: z.string().min(1).max(120).describe("The skill's slug."),
    digest: z.string().regex(/^[0-9a-f]{64}$/).describe(
      "SHA-256 of the canonical JSON of kind, key and data.",
    ),
    data: SkillPackageDataSchema,
  }).strict().describe("A skill item."),
  z.object({
    kind: z.literal("agent").describe("An agent definition."),
    key: z.string().min(1).max(64).describe("The agent's slug."),
    digest: z.string().regex(/^[0-9a-f]{64}$/).describe(
      "SHA-256 of the canonical JSON of kind, key and data.",
    ),
    data: AgentPackageDataSchema,
  }).strict().describe("An agent item."),
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
  }
  | { kind: "skill"; key: string; data: SkillPackageData }
  | { kind: "agent"; key: string; data: AgentPackageData };

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
    | "workflow_definition_not_canonical"
    | "unresolved_package_reference"
    | "package_path_unsafe"
    | "package_raw_binding";
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
 * Whether a path inside a package could leave the directory it is written
 * under. A package is hand-built data, so every path field is checked the same
 * way: relative, no empty, `.` or `..` segment, no backslash or drive letter,
 * no control character, and a bounded length. Nothing here resolves a path
 * against a disk; it only refuses the shapes that could escape one.
 */
export function unsafePackagePath(path: string): boolean {
  if (path.length === 0 || path.length > 500) return true;
  if (path.startsWith("/") || path.includes("\\")) return true;
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return true;
  if (/^[A-Za-z]:/.test(path)) return true;
  return path.split("/").some((segment) =>
    segment === "" || segment === "." || segment === ".."
  );
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
  const allKeys = new Set(
    value.items.map((item) => `${item.kind}:${item.key}`),
  );
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
      for (const at of rawBindingsIn(parsed)) {
        defects.push({
          code: "package_raw_binding",
          path: ["items", index, "data", "definition", at],
          message:
            `${identity} binds a skill or agent by an id instead of a package reference.`,
        });
      }
      for (const reference of packageReferencesIn(parsed)) {
        const [, kind, key] = /^package:(skill|agent)\/(.+)$/.exec(reference)!;
        if (!seen.has(`${kind}:${key}`) && !allKeys.has(`${kind}:${key}`)) {
          defects.push({
            code: "unresolved_package_reference",
            path: ["items", index, "data", "definition"],
            message:
              `${identity} names ${reference}, which the package does not carry.`,
          });
        }
      }
    } else if (item.kind === "skill") {
      const paths: { at: (string | number)[]; path: string }[] = [
        {
          at: ["items", index, "data", "entryPath"],
          path: item.data.entryPath,
        },
        ...item.data.files.map((file, fileIndex) => ({
          at: ["items", index, "data", "files", fileIndex, "path"],
          path: file.path,
        })),
      ];
      const listed = item.data.manifest["files"];
      if (Array.isArray(listed)) {
        listed.forEach((entry, entryIndex) => {
          const path = (entry as { path?: unknown } | null)?.path;
          if (typeof path === "string") {
            paths.push({
              at: ["items", index, "data", "manifest", "files", entryIndex],
              path,
            });
          }
        });
      }
      const manifestEntry = item.data.manifest["entryPath"];
      if (typeof manifestEntry === "string") {
        paths.push({
          at: ["items", index, "data", "manifest", "entryPath"],
          path: manifestEntry,
        });
      }
      for (const { at, path } of paths) {
        if (unsafePackagePath(path)) {
          defects.push({
            code: "package_path_unsafe",
            path: at,
            message: `${identity} names a path that could leave its directory.`,
          });
        }
      }
    } else if (item.kind === "agent") {
      for (const [name, reference] of Object.entries(item.data.skillBindings)) {
        const key = reference.slice("package:skill/".length);
        if (
          !reference.startsWith("package:skill/") ||
          !allKeys.has(`skill:${key}`)
        ) {
          defects.push({
            code: "unresolved_package_reference",
            path: ["items", index, "data", "skillBindings", name],
            message:
              `${identity} binds ${name} to ${reference}, which the package does not carry.`,
          });
        }
      }
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

/** What the exporter knows about a skill or agent version a workflow names. */
export type KnownReference = Readonly<{
  /** The item's key when the package carries it, otherwise null. */
  key: string | null;
  /** The name in the exporting organization, written into an open binding. */
  name: string;
}>;

export type ReferenceMap = {
  skills: ReadonlyMap<string, KnownReference>;
  agents: ReadonlyMap<string, KnownReference>;
};

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const isObject = (value: unknown): value is { [k: string]: Json } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const pointer = (segments: readonly (string | number)[]): string =>
  segments.map((s) =>
    `/${String(s).replaceAll("~", "~0").replaceAll("/", "~1")}`
  )
    .join("");

function isStep(value: { [k: string]: Json }): boolean {
  return typeof value.uses === "string" || typeof value.action === "string";
}

/**
 * Rewrites a workflow definition for export. Each skill or agent version the
 * package carries becomes a package reference; every other one is removed and
 * listed, so no id from the exporting organization leaves with the package.
 */
export function exportReferences(
  definition: unknown,
  known: ReferenceMap,
): { definition: unknown; openBindings: OpenBinding[] } {
  const openBindings: OpenBinding[] = [];
  const swap = (
    kind: "skill" | "agent",
    id: string,
    path: readonly (string | number)[],
  ): string | null => {
    const info = (kind === "skill" ? known.skills : known.agents).get(
      id.toLowerCase(),
    );
    if (info?.key) return packageReference(kind, info.key);
    openBindings.push({
      path: pointer(path),
      kind,
      name: info?.name ?? `unnamed ${kind}`,
    });
    return null;
  };
  const visit = (value: Json, path: (string | number)[]): Json => {
    if (Array.isArray(value)) {
      return value.map((entry, index) => visit(entry, [...path, index]));
    }
    if (!isObject(value)) return value;
    const out: { [k: string]: Json } = {};
    const step = isStep(value);
    for (const [name, entry] of Object.entries(value)) {
      const here = [...path, name];
      if (step && name === "skills" && Array.isArray(entry)) {
        const kept: Json[] = [];
        for (const [index, item] of entry.entries()) {
          if (typeof item !== "string") {
            kept.push(item);
            continue;
          }
          const swapped = swap("skill", item, [...here, index]);
          if (swapped !== null) kept.push(swapped);
        }
        if (kept.length > 0) out[name] = kept;
      } else if (
        step && name === "agentVersionId" && typeof entry === "string"
      ) {
        const swapped = swap("agent", entry, here);
        if (swapped !== null) out[name] = swapped;
      } else if (path.length === 0 && name === "agents" && isObject(entry)) {
        const agents: { [k: string]: Json } = {};
        for (const [action, id] of Object.entries(entry)) {
          if (typeof id !== "string") {
            agents[action] = id;
            continue;
          }
          const swapped = swap("agent", id, [...here, action]);
          if (swapped !== null) agents[action] = swapped;
        }
        if (Object.keys(agents).length > 0) out[name] = agents;
      } else {
        out[name] = visit(entry, here);
      }
    }
    return out;
  };
  return { definition: visit(definition as Json, []), openBindings };
}

/**
 * The places a workflow definition binds a skill or an agent by something that
 * is not a package reference. An export writes only references there, so a raw
 * id means a hand-built package carrying an id from another organization; it
 * means nothing here and must not be kept in a draft.
 */
export function rawBindingsIn(definition: unknown): string[] {
  const found: string[] = [];
  const isReference = (value: unknown): boolean =>
    typeof value === "string" && PACKAGE_REFERENCE_PATTERN.test(value);
  const visit = (value: Json, path: (string | number)[]): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    if (!isObject(value)) return;
    const step = isStep(value);
    for (const [name, entry] of Object.entries(value)) {
      const here = [...path, name];
      if (step && name === "skills" && Array.isArray(entry)) {
        entry.forEach((item, index) => {
          if (!isReference(item)) found.push(pointer([...here, index]));
        });
      } else if (step && name === "agentVersionId") {
        if (!isReference(entry)) found.push(pointer(here));
      } else if (path.length === 0 && name === "agents" && isObject(entry)) {
        for (const [action, id] of Object.entries(entry)) {
          if (!isReference(id)) found.push(pointer([...here, action]));
        }
      } else {
        visit(entry, here);
      }
    }
  };
  visit(definition as Json, []);
  return found;
}

/** The package references a definition names, for the importer to check. */
export function packageReferencesIn(definition: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (PACKAGE_REFERENCE_PATTERN.test(value)) found.push(value);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (isObject(value)) Object.values(value).forEach(visit);
  };
  visit(definition);
  return found;
}

/** Replaces each package reference with the id the importer just made. */
export function importReferences(
  definition: unknown,
  ids: {
    skill: ReadonlyMap<string, string>;
    agent: ReadonlyMap<string, string>;
  },
): unknown {
  const visit = (value: Json): Json => {
    if (typeof value === "string") {
      const match = /^package:(skill|agent)\/(.+)$/.exec(value);
      if (match && PACKAGE_REFERENCE_PATTERN.test(value)) {
        return (ids[match[1] as "skill" | "agent"].get(match[2]!)) ?? value;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (isObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, visit(v)]),
      );
    }
    return value;
  };
  return visit(definition as Json);
}
