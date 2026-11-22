import type { ActionContext } from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import {
  type BakeryPackage,
  BakeryPackageSchema,
  buildPackage,
  packageDefects,
  type PackageItemDraft,
} from "@bakery/contracts/library-packages";
import { ArtifactKindDefinitionSchema } from "@bakery/contracts/artifact-kinds";
import { sha256Hex } from "../../platform/canonical-json.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { publishArtifactKindVersion } from "../artifact-kinds/postgres.ts";
import { stripPersonalSkills } from "./skill-slots.ts";
import {
  insertWorkflowDefinition,
  requireDraftDefinition,
  writeFactsOf,
} from "./postgres.ts";

/**
 * T0 package export and import (chapter 25 section 6, O6, O7, #426).
 *
 * A package is validated data. Export reads published workflows and the latest
 * version of each named kind and writes only what the package format allows.
 * Import checks every item before it writes anything, then creates each as an
 * ordinary draft or kind version in one transaction, so a package is imported
 * whole or not at all, and records where each item came from.
 */

type Issue = { path: (string | number)[]; code: string; message: string };

function refuse(issues: readonly Issue[]): never {
  throw new StandardError({
    code: "UNPROCESSABLE",
    params: { issues: issues.map((issue) => ({ ...issue })) },
  });
}

type ExportInput = {
  name: string;
  workflowIds?: string[];
  artifactKindKeys?: string[];
};

export async function exportPackage(
  context: ActionContext,
  input: unknown,
): Promise<BakeryPackage> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const value = input as ExportInput;
  const drafts: PackageItemDraft[] = [];
  const issues: Issue[] = [];

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
    drafts.push({
      kind: "workflow",
      key: row.slug,
      data: {
        slug: row.slug,
        name: row.name,
        description: row.description,
        definition: requireDraftDefinition(stripped.definition),
      },
    });
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

  if (issues.length > 0) refuse(issues);
  if (drafts.length === 0) {
    refuse([{
      path: [],
      code: "package_empty",
      message: "Name at least one workflow or kind to export.",
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
    kind: "workflow" | "artifactKind";
    key: string;
    itemDigest: string;
    resultingId: string;
  }[];
};

export async function importPackage(
  context: ActionContext,
  input: unknown,
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
    if (item.kind !== "workflow") continue;
    const clash = await transaction.query(
      `select 1 from bakery.workflow_definitions
        where organization_id = $1 and slug = $2`,
      [organizationId, item.data.slug],
    );
    if (clash.rows.length > 0) {
      taken.push({
        path: ["package", "items", index, "data", "slug"],
        code: "workflow_slug_taken",
        message:
          `A workflow with the slug ${item.data.slug} already exists here.`,
      });
    }
  }
  if (taken.length > 0) refuse(taken);

  const facts = writeFactsOf(context);
  const imported: PackageImportResult["imported"] = [];
  for (const item of pkg.items) {
    let resultingId: string;
    if (item.kind === "workflow") {
      const definition = JSON.parse(item.data.definition) as unknown;
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
      resultingId = row.id;
    } else {
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
      resultingId = version.id;
    }
    await transaction.query(
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
    imported.push({
      kind: item.kind,
      key: item.key,
      itemDigest: item.digest,
      resultingId,
    });
  }
  return { packageDigest: pkg.packageDigest, imported };
}
