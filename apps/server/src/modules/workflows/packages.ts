import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import {
  type BakeryPackage,
  BakeryPackageSchema,
  buildPackage,
  exportReferences,
  importReferences,
  type KnownReference,
  type OpenBinding,
  packageDefects,
  type PackageItemDraft,
  packageReference,
} from "@bakery/contracts/library-packages";
import { ArtifactKindDefinitionSchema } from "@bakery/contracts/artifact-kinds";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { publishArtifactKindVersion } from "../artifact-kinds/postgres.ts";
import {
  createAgentDefinition,
  createAgentVersion,
} from "../agents/postgres.ts";
import {
  importSkillFromPackage,
  readSkillForPackage,
  skillSlugTaken,
} from "../catalog/skill-package.ts";
import type { SkillFileStoreOperations } from "../catalog/storage.ts";
import { stripPersonalSkills } from "./skill-slots.ts";
import {
  insertWorkflowDefinition,
  requireDraftDefinition,
  writeFactsOf,
} from "./postgres.ts";

/**
 * T0 package export and import (chapter 25 section 6, O6, O7, #426).
 *
 * A package is validated data. Export reads what the caller names and writes
 * only what the package format allows. Import checks every item before it
 * writes anything, then creates skills, agents, kinds and workflows in one
 * transaction, so a package is imported whole or not at all, and records where
 * each item came from.
 *
 * Skills and agents get new ids on import, so a workflow that named one carries
 * a package reference that the importer swaps for the new id. A reference to
 * something the package does not carry is removed and listed, because an id
 * from another organization means nothing here.
 */

type Issue = { path: (string | number)[]; code: string; message: string };

function refuse(issues: readonly Issue[]): never {
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: { issues: issues.map((issue) => ({ ...issue })) },
  });
}

const UUID_IN_TEXT =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

type ExportInput = {
  name: string;
  workflowIds?: string[];
  artifactKindKeys?: string[];
  skillIds?: string[];
  agentIds?: string[];
};

export type PackageDependencies = Readonly<{
  skillFileStore?: SkillFileStoreOperations;
}>;

export function createPackageHandlers(dependencies: PackageDependencies) {
  return {
    exportPackage: (context: ActionContext, input: unknown) =>
      exportPackage(context, input, dependencies),
    importPackage: (context: ActionContext, input: unknown) =>
      importPackage(context, input, dependencies),
  };
}

export async function exportPackage(
  context: ActionContext,
  input: unknown,
  dependencies: PackageDependencies = {},
): Promise<BakeryPackage> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const value = input as ExportInput;
  const drafts: PackageItemDraft[] = [];
  const issues: Issue[] = [];
  const skills = new Map<string, KnownReference>();
  const agents = new Map<string, KnownReference>();
  /** Every skill version id of an exported skill, to the key of its item. */
  const skillKeyByVersion = new Map<string, string>();

  for (const [index, id] of (value.skillIds ?? []).entries()) {
    if (!dependencies.skillFileStore) {
      throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
    }
    const skill = await readSkillForPackage(
      transaction,
      organizationId,
      dependencies.skillFileStore,
      id,
    );
    if (!skill) {
      issues.push({
        path: ["skillIds", index],
        code: "skill_package_source_unavailable",
        message:
          "The skill does not exist, is not an organization skill, or has no published active version.",
      });
      continue;
    }
    drafts.push({ kind: "skill", key: skill.data.slug, data: skill.data });
    for (const versionId of skill.versionIds) {
      skills.set(versionId, { key: skill.data.slug, name: skill.data.name });
      skillKeyByVersion.set(versionId, skill.data.slug);
    }
  }

  for (const [index, id] of (value.agentIds ?? []).entries()) {
    const found = await transaction.query<{
      slug: string;
      name: string;
      description: string;
      config: {
        harness: "pi" | "claude_code" | "codex" | "mastra";
        allowedCapabilities?: string[];
        skillBindings?: Record<string, string>;
      } | null;
    }>(
      `select agent.slug, agent.name, agent.description, version.config
         from bakery.agent_definitions agent
         left join bakery.agent_versions version
           on version.organization_id = agent.organization_id
          and version.agent_id = agent.id
          and version.id = agent.active_version_id
        where agent.organization_id = $1 and agent.id = $2`,
      [organizationId, id],
    );
    const row = found.rows[0];
    if (!row || !row.config) {
      issues.push({
        path: ["agentIds", index],
        code: "agent_package_source_unavailable",
        message: "The agent does not exist or has no active version.",
      });
      continue;
    }
    const bindings: Record<string, string> = {};
    for (
      const [name, versionId] of Object.entries(row.config.skillBindings ?? {})
    ) {
      const key = skillKeyByVersion.get(versionId.toLowerCase());
      if (!key) {
        issues.push({
          path: ["agentIds", index],
          code: "agent_skill_not_in_package",
          message:
            `The agent binds ${name} to a skill the package does not carry; add that skill to the export.`,
        });
        continue;
      }
      bindings[name] = packageReference("skill", key);
    }
    drafts.push({
      kind: "agent",
      key: row.slug,
      data: {
        slug: row.slug,
        name: row.name,
        description: row.description,
        harness: row.config.harness,
        allowedCapabilities: row.config.allowedCapabilities ?? [],
        skillBindings: bindings,
      },
    });
    const versions = await transaction.query<{ id: string }>(
      `select id from bakery.agent_versions
        where organization_id = $1 and agent_id = $2`,
      [organizationId, id],
    );
    for (const version of versions.rows) {
      agents.set(version.id.toLowerCase(), { key: row.slug, name: row.name });
    }
  }

  for (const [index, key] of (value.artifactKindKeys ?? []).entries()) {
    const found = await transaction.query<{ definition: unknown }>(
      `select version.definition
         from bakery.artifact_kinds kind
         join bakery.artifact_kind_versions version
           on version.organization_id = kind.organization_id
          and version.kind_id = kind.id
        where kind.organization_id = $1 and kind.key = $2
        order by version.revision desc
        limit 1`,
      [organizationId, key],
    );
    const row = found.rows[0];
    if (!row) {
      issues.push({
        path: ["artifactKindKeys", index],
        code: "artifact_kind_package_source_unavailable",
        message: "The kind does not exist or has no published version.",
      });
      continue;
    }
    drafts.push({
      kind: "artifactKind",
      key,
      data: ArtifactKindDefinitionSchema.parse(row.definition),
    });
  }

  for (const [index, id] of (value.workflowIds ?? []).entries()) {
    const found = await transaction.query<{
      slug: string;
      name: string;
      description: string;
      definition: unknown;
    }>(
      `select definition.slug, definition.name, definition.description,
              version.normalized_spec as definition
         from bakery.workflow_definitions definition
         join bakery.workflow_versions version
           on version.organization_id = definition.organization_id
          and version.id = definition.active_version_id
        where definition.organization_id = $1 and definition.id = $2`,
      [organizationId, id],
    );
    const row = found.rows[0];
    if (!row) {
      issues.push({
        path: ["workflowIds", index],
        code: "workflow_package_source_unavailable",
        message:
          "The workflow does not exist or has no active published version to export.",
      });
      continue;
    }
    // A personal skill is visible to its owner alone, so it never leaves in a
    // package; the step keeps an open slot, exactly as in a copy.
    const stripped = await stripPersonalSkills(
      transaction,
      organizationId,
      row.definition,
    );
    // Name what the workflow uses that the package does not carry, so the
    // open binding says what to rebind and no id leaves.
    const referenced = [
      ...new Set(
        (canonicalJson(stripped.definition).match(UUID_IN_TEXT) ?? []).map((
          id,
        ) => id.toLowerCase()),
      ),
    ];
    const named = new Map(skills);
    const namedAgents = new Map(agents);
    if (referenced.length > 0) {
      const skillNames = await transaction.query<
        { id: string; name: string }
      >(
        `select version.id, skill.name
           from bakery.skill_versions version
           join bakery.skills skill
             on skill.organization_id = version.organization_id
            and skill.id = version.skill_id
          where version.organization_id = $1 and version.id = any($2::uuid[])
            and skill.scope <> 'personal'`,
        [organizationId, referenced],
      );
      for (const skill of skillNames.rows) {
        const id = skill.id.toLowerCase();
        if (!named.has(id)) named.set(id, { key: null, name: skill.name });
      }
      const agentNames = await transaction.query<
        { id: string; name: string }
      >(
        `select version.id, agent.name
           from bakery.agent_versions version
           join bakery.agent_definitions agent
             on agent.organization_id = version.organization_id
            and agent.id = version.agent_id
          where version.organization_id = $1 and version.id = any($2::uuid[])`,
        [organizationId, referenced],
      );
      for (const agent of agentNames.rows) {
        const id = agent.id.toLowerCase();
        if (!namedAgents.has(id)) {
          namedAgents.set(id, { key: null, name: agent.name });
        }
      }
    }
    const rewritten = exportReferences(stripped.definition, {
      skills: named,
      agents: namedAgents,
    });
    drafts.push({
      kind: "workflow",
      key: row.slug,
      data: {
        slug: row.slug,
        name: row.name,
        description: row.description,
        definition: requireDraftDefinition(rewritten.definition),
        openBindings: rewritten.openBindings,
      },
    });
  }

  if (issues.length > 0) refuse(issues);
  if (drafts.length === 0) {
    refuse([{
      path: [],
      code: "package_empty",
      message: "Name at least one item to export.",
    }]);
  }
  const pkg = await buildPackage(value.name, drafts);
  // The package must pass the very check an importer runs, so an export that
  // an import would refuse is caught here, where the author can still fix it.
  const defects = await packageDefects(pkg);
  if (defects.length > 0) {
    refuse(defects.map((defect) => ({
      path: [...defect.path],
      code: defect.code,
      message: defect.message,
    })));
  }
  return pkg;
}

export type PackageImportResult = {
  packageDigest: string;
  imported: {
    kind: "workflow" | "artifactKind" | "skill" | "agent";
    key: string;
    itemDigest: string;
    resultingId: string;
  }[];
  /** What a person still has to bind by hand, per workflow or agent. */
  openBindings: {
    key: string;
    kind: "skill" | "agent" | "billing";
    path: string;
    name: string;
  }[];
};

export async function importPackage(
  context: ActionContext,
  input: unknown,
  dependencies: PackageDependencies = {},
): Promise<PackageImportResult> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const parsed = BakeryPackageSchema.safeParse(
    (input as { package: unknown }).package,
  );
  if (!parsed.success) {
    refuse(parsed.error.issues.map((issue) => ({
      path: issue.path.map((segment) =>
        typeof segment === "symbol" ? String(segment) : segment as
          | string
          | number
      ),
      code: issue.code,
      message: issue.message,
    })));
  }
  const pkg = parsed.data;
  const defects = await packageDefects(pkg);
  if (defects.length > 0) {
    refuse(defects.map((defect) => ({
      path: [...defect.path],
      code: defect.code,
      message: defect.message,
    })));
  }

  // Everything that can be refused is refused before the first write, so the
  // author sees all of it at once and nothing is half-imported.
  const taken: Issue[] = [];
  for (const [index, item] of pkg.items.entries()) {
    let clash = false;
    if (item.kind === "workflow") {
      clash = (await transaction.query(
        `select 1 from bakery.workflow_definitions
          where organization_id = $1 and slug = $2`,
        [organizationId, item.data.slug],
      )).rows.length > 0;
    } else if (item.kind === "agent") {
      clash = (await transaction.query(
        `select 1 from bakery.agent_definitions
          where organization_id = $1 and slug = $2`,
        [organizationId, item.data.slug],
      )).rows.length > 0;
    } else if (item.kind === "skill") {
      clash = await skillSlugTaken(transaction, organizationId, item.data.slug);
    } else if (item.kind === "artifactKind") {
      // A kind is addressed by its key, so importing one that exists is the
      // same refusal as importing a workflow, agent or skill that exists: it is
      // not a quiet new revision of someone else's kind.
      clash = (await transaction.query(
        `select 1 from bakery.artifact_kinds
          where organization_id = $1 and key = $2`,
        [organizationId, item.key],
      )).rows.length > 0;
    }
    if (clash) {
      taken.push({
        path: ["package", "items", index, "key"],
        code: `${item.kind}_slug_taken`,
        message: `A ${item.kind} named ${item.key} already exists here.`,
      });
    }
  }
  if (taken.length > 0) refuse(taken);

  const facts = writeFactsOf(context);
  const imported: PackageImportResult["imported"] = [];
  const openBindings: PackageImportResult["openBindings"] = [];
  const skillIds = new Map<string, string>();
  const agentIds = new Map<string, string>();
  const note = (
    item: { kind: PackageImportResult["imported"][number]["kind"] },
    key: string,
    itemDigest: string,
    resultingId: string,
  ) => imported.push({ kind: item.kind, key, itemDigest, resultingId });
  const record = (
    item: { kind: string; key: string; digest: string },
    resultingId: string,
  ) =>
    transaction.query(
      `insert into bakery.package_imports (
         organization_id, package_digest, package_name, item_kind, item_key,
         item_digest, resulting_id, imported_by
       ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        organizationId,
        pkg.packageDigest,
        pkg.name,
        item.kind,
        item.key,
        item.digest,
        resultingId,
        principalId,
      ],
    );

  // Skills and agents first: a workflow names them, and an agent names skills.
  for (const item of pkg.items) {
    if (item.kind !== "skill") continue;
    const made = await importSkillFromPackage({
      transaction,
      context,
      organizationId,
      principalId,
      store: dependencies.skillFileStore,
      data: item.data,
    });
    skillIds.set(item.key, made.versionId);
    await record(item, made.skillId);
    note(item, item.key, item.digest, made.skillId);
  }
  for (const item of pkg.items) {
    if (item.kind !== "agent") continue;
    const agent = await createAgentDefinition(context, {
      slug: item.data.slug,
      name: item.data.name,
      description: item.data.description,
    }) as { id: string };
    const bindings: Record<string, string> = {};
    for (const [name, reference] of Object.entries(item.data.skillBindings)) {
      const versionId = skillIds.get(reference.slice("package:skill/".length));
      if (versionId) bindings[name] = versionId;
    }
    const config = {
      harness: item.data.harness,
      allowedCapabilities: item.data.allowedCapabilities,
      skillBindings: bindings,
    };
    const version = await createAgentVersion(
      { ...context, params: { ...context.params, id: agent.id } },
      { revision: 1, config, digest: await sha256Hex(canonicalJson(config)) },
    ) as { id: string };
    agentIds.set(item.key, version.id);
    await record(item, agent.id);
    note(item, item.key, item.digest, agent.id);
    // Billing belongs to the exporting organization and never travels.
    openBindings.push({
      key: item.key,
      kind: "billing",
      path: "/config/billing",
      name: item.data.name,
    });
  }
  for (const item of pkg.items) {
    if (item.kind !== "artifactKind") continue;
    const latest = await transaction.query<{ max: number }>(
      `select coalesce(max(version.revision), 0)::integer as max
         from bakery.artifact_kinds kind
         join bakery.artifact_kind_versions version
           on version.organization_id = kind.organization_id
          and version.kind_id = kind.id
        where kind.organization_id = $1 and kind.key = $2`,
      [organizationId, item.key],
    );
    const version = await publishArtifactKindVersion(
      {
        ...context,
        params: { ...context.params, id: organizationId, key: item.key },
      },
      {
        expectedRevision: latest.rows[0]?.max ?? 0,
        definition: item.data,
      },
    ) as { id: string };
    await record(item, version.id);
    note(item, item.key, item.digest, version.id);
  }
  for (const item of pkg.items) {
    if (item.kind !== "workflow") continue;
    const definition = importReferences(JSON.parse(item.data.definition), {
      skill: skillIds,
      agent: agentIds,
    });
    const canonical = requireDraftDefinition(definition);
    const row = await insertWorkflowDefinition(transaction, facts, {
      slug: item.data.slug,
      name: item.data.name,
      description: item.data.description,
    } as never, {
      visibility: "listed",
      originKind: "package",
    });
    await transaction.query(
      `insert into bakery.workflow_drafts (
         id, organization_id, workflow_id, revision, source_yaml, definition,
         digest, created_by, updated_by
       ) values ($1, $2, $3, 1, $4, $5::jsonb, $6, $7, $7)`,
      [
        crypto.randomUUID(),
        organizationId,
        row.id,
        canonical,
        canonical,
        await sha256Hex(canonical),
        principalId,
      ],
    );
    for (const open of item.data.openBindings as OpenBinding[]) {
      openBindings.push({ key: item.key, ...open });
    }
    await record(item, row.id);
    note(item, item.key, item.digest, row.id);
  }
  return { packageDigest: pkg.packageDigest, imported, openBindings };
}
