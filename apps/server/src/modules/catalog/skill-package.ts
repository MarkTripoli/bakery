import { Buffer } from "node:buffer";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { JsonValue } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { SkillPackageData } from "@bakery/contracts/library-packages";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  boundedMutation,
  SKILL_COLUMNS,
  type SkillRow,
} from "./persistence.ts";
import {
  finalizeLocalSkillVersionPublication,
  prepareLocalSkillVersionPublication,
  storeLocalSkillVersionPublication,
} from "./publication.ts";
import {
  insertLocalSkillIdentity,
  type LocalSkillIdentity,
} from "./skill-identity.ts";
import type { SkillFileStoreOperations } from "./storage.ts";
import {
  SkillUploadInvalid,
  skillUploadIssues,
  validateLocalSkillVersion,
} from "./validation.ts";

/**
 * Skills in a T0 package (#426). A package carries an organization-scope
 * skill's active version as data: its manifest and its files. It never carries
 * a personal skill (visible to its owner alone) or a global one (the host's).
 */

export type SkillForPackage = Readonly<{
  skillId: string;
  data: SkillPackageData;
  /** Every version id of the skill, so a workflow naming any of them can be rebound. */
  versionIds: readonly string[];
}>;

export async function readSkillForPackage(
  transaction: PgTransactionClient,
  organizationId: string,
  store: SkillFileStoreOperations,
  skillId: string,
): Promise<SkillForPackage | null> {
  const skill = (await transaction.query<{
    slug: string;
    name: string;
    active_version_id: string | null;
    scope: string;
  }>(
    `select slug, name, active_version_id, scope from bakery.skills
      where organization_id = $1 and id = $2`,
    [organizationId, skillId],
  )).rows[0];
  if (!skill || skill.scope !== "organization" || !skill.active_version_id) {
    return null;
  }
  const version = (await transaction.query<{
    entry_path: string;
    manifest: JsonValue;
  }>(
    `select entry_path, manifest from bakery.skill_versions
      where organization_id = $1 and id = $2 and status = 'published'`,
    [organizationId, skill.active_version_id],
  )).rows[0];
  if (!version) return null;
  const files = (await transaction.query<{
    path: string;
    media_type: string;
    object_key: string;
    size_bytes: number;
    sha256: string;
    is_executable: boolean;
  }>(
    `select path, media_type, object_key, size_bytes, sha256, is_executable
       from bakery.skill_files
      where organization_id = $1 and skill_version_id = $2
      order by path`,
    [organizationId, skill.active_version_id],
  )).rows;
  const carried = [];
  for (const file of files) {
    const content = await store.read(
      file.object_key,
      file.sha256,
      file.size_bytes,
    );
    carried.push({
      path: file.path,
      mediaType: file.media_type,
      isExecutable: file.is_executable,
      contentBase64: Buffer.from(content).toString("base64"),
    });
  }
  const versions = (await transaction.query<{ id: string }>(
    `select id from bakery.skill_versions
      where organization_id = $1 and skill_id = $2`,
    [organizationId, skillId],
  )).rows;
  return {
    skillId,
    data: {
      slug: skill.slug,
      name: skill.name,
      entryPath: version.entry_path,
      manifest: version.manifest as Record<string, never>,
      files: carried,
    },
    versionIds: versions.map((row) => row.id),
  };
}

/** Whether an organization skill already uses a slug, for the importer's pre-check. */
export async function skillSlugTaken(
  transaction: PgTransactionClient,
  organizationId: string,
  slug: string,
): Promise<boolean> {
  const found = await transaction.query(
    `select 1 from bakery.skills
      where organization_id = $1 and slug = $2 and scope = 'organization'`,
    [organizationId, slug],
  );
  return found.rows.length > 0;
}

/**
 * Creates one organization skill and publishes its files as version 1, inside
 * the caller's transaction. The files are revalidated like any upload: the
 * digest and every file hash are recomputed from the bytes, so a damaged or
 * altered package cannot create a skill.
 */
export async function importSkillFromPackage(options: {
  transaction: PgTransactionClient;
  context: ActionContext;
  organizationId: string;
  principalId: string;
  store: SkillFileStoreOperations | undefined;
  data: SkillPackageData;
}): Promise<{ skillId: string; versionId: string }> {
  const { transaction, organizationId, principalId, data } = options;
  if (!options.store) {
    throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  }
  const skillId = crypto.randomUUID();
  const input = {
    id: skillId,
    revision: 1,
    digest: "0".repeat(64),
    entryPath: data.entryPath,
    manifest: data.manifest as JsonValue,
    files: data.files,
  };
  // A hand-built package can hold a skill the upload rules refuse. That is the
  // author's mistake, not a server fault: it is an unprocessable request, as it
  // is when the same files are published directly.
  let validated: Awaited<ReturnType<typeof validateLocalSkillVersion>>;
  try {
    validated = await validateLocalSkillVersion(input, {
      computeDigest: true,
    });
  } catch (error) {
    if (error instanceof SkillUploadInvalid) {
      throw new StandardError({
        code: "UNPROCESSABLE",
        cause: error,
        params: { issues: skillUploadIssues(error) },
      });
    }
    throw new StandardError({ code: "UNPROCESSABLE", cause: error });
  }
  const identity: LocalSkillIdentity = Object.freeze({
    skillId,
    sourceId: crypto.randomUUID(),
    slug: data.slug,
    name: data.name,
    scope: "organization",
    ownerPrincipalId: null,
    copiedFrom: null,
  });
  await boundedMutation(() =>
    insertLocalSkillIdentity<SkillRow>(
      transaction,
      organizationId,
      identity,
      SKILL_COLUMNS,
    )
  );
  const preparation = await prepareLocalSkillVersionPublication({
    transaction,
    organizationId,
    principalId,
    input: { ...input, digest: validated.digest },
  });
  const proof = await storeLocalSkillVersionPublication(
    preparation,
    options.store,
  );
  await finalizeLocalSkillVersionPublication({
    transaction,
    context: options.context,
    preparation,
    proof,
  });
  return { skillId, versionId: preparation.identity.versionId };
}
