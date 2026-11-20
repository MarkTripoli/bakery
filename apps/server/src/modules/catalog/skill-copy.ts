import { Buffer } from "node:buffer";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas, JsonValue } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import type { z } from "zod";
import type { PgTransactionClient } from "../../platform/database.ts";
import { attributeAction } from "../auth/application/action-attribution.ts";
import {
  boundedMutation,
  recordMutation,
  SKILL_COLUMNS,
  SkillCreatePersistenceSchema,
  type SkillRow,
  toSkill,
} from "./persistence.ts";
import {
  finalizeLocalSkillVersionPublication,
  type LocalSkillVersionPublicationPreparation,
  type LocalSkillVersionPublicationProof,
  prepareLocalSkillVersionPublication,
} from "./publication.ts";
import {
  insertLocalSkillIdentity,
  type LocalSkillIdentity,
} from "./skill-identity.ts";
import { assertMayAuthorSkill, SKILL_VISIBLE_TO } from "./skill-scope-guard.ts";
import type { SkillFileStoreOperations } from "./storage.ts";

type SkillCopyInput = z.output<typeof contractSchemas.SkillCopy>;

/** A skill copy ready to commit: the new skill and the version-1 publication. */
export type SkillCopyPreparation = Readonly<{
  identity: LocalSkillIdentity;
  publication: LocalSkillVersionPublicationPreparation;
}>;

type SourceVersionRow = {
  id: string;
  revision: number;
  digest: string;
  entry_path: string;
  manifest: Record<string, unknown>;
};

type SourceFileRow = {
  path: string;
  media_type: string;
  object_key: string;
  size_bytes: number;
  sha256: string;
  is_executable: boolean;
};

/** A slug made from a name when the caller names none. */
export function slugFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "")
    .slice(0, 100).replace(/-+$/, "");
}

/**
 * Works out the copy inside the preflight transaction: the source the caller can
 * see, the destination they may author, and the source's active version read
 * back from the file store. It inserts the new skill so the version-1
 * publication can be validated against it, and the caller rolls it back before
 * any object is written; the final transaction inserts the same ids again.
 *
 * The source's bytes are read here, while the transaction is open. They are
 * capped at 10 MiB and 256 files, and nothing is written until it is over.
 */
export async function prepareSkillCopy(options: {
  transaction: PgTransactionClient;
  context: ActionContext;
  organizationId: string;
  principalId: string;
  sourceSkillId: string;
  input: SkillCopyInput;
  store: SkillFileStoreOperations | undefined;
}): Promise<SkillCopyPreparation> {
  const { transaction, organizationId, principalId, input } = options;
  const source = await transaction.query<{
    id: string;
    active_version_id: string | null;
    enabled: boolean;
    source_enabled: boolean;
  }>(
    `select id, active_version_id, enabled,
            coalesce((select source.enabled from bakery.skill_sources as source
                       where source.organization_id = $1
                         and source.id = skills.source_id), false)
              as source_enabled
       from bakery.skills
      where organization_id = $1 and id = $2 and ${SKILL_VISIBLE_TO("$3")}`,
    [organizationId, options.sourceSkillId, principalId],
  );
  const sourceSkill = source.rows[0];
  if (!sourceSkill) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  // A skill that was switched off, or whose source was, is not one to start a
  // new, enabled skill from.
  if (!sourceSkill.enabled || !sourceSkill.source_enabled) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "skill_disabled" },
    });
  }
  const scope = input.scope;
  // A personal skill is a person's own; an agent or a token never owns one.
  if (
    scope === "personal" &&
    attributeAction(options.context, principalId).actorKind !== "person"
  ) {
    throw new StandardError({
      code: "AUTH_FORBIDDEN",
      params: { reason: "personal_skill_requires_person" },
    });
  }
  await assertMayAuthorSkill(transaction, organizationId, principalId, {
    scope,
    ownerPrincipalId: scope === "personal" ? principalId : null,
  });
  if (sourceSkill.active_version_id === null) {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "skill_has_no_published_version" },
    });
  }
  const persisted = SkillCreatePersistenceSchema.safeParse({
    slug: input.slug ?? slugFromName(input.name),
    name: input.name,
    scope,
  });
  if (!persisted.success) throw new StandardError({ code: "UNPROCESSABLE" });
  if (options.store === undefined) {
    throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
  }

  const version = (await transaction.query<SourceVersionRow>(
    `select id, revision, digest, entry_path, manifest
       from bakery.skill_versions
      where organization_id = $1 and skill_id = $2 and id = $3
        and status = 'published'`,
    [organizationId, sourceSkill.id, sourceSkill.active_version_id],
  )).rows[0];
  if (!version) throw new StandardError({ code: "STATE_CONFLICT" });
  const files = (await transaction.query<SourceFileRow>(
    `select path, media_type, object_key, size_bytes, sha256, is_executable
       from bakery.skill_files
      where organization_id = $1 and skill_version_id = $2
      order by path`,
    [organizationId, version.id],
  )).rows;
  const uploads = [];
  for (const file of files) {
    const content = await options.store.read(
      file.object_key,
      file.sha256,
      file.size_bytes,
    );
    uploads.push({
      path: file.path,
      mediaType: file.media_type,
      isExecutable: file.is_executable,
      contentBase64: Buffer.from(content).toString("base64"),
    });
  }

  const identity: LocalSkillIdentity = Object.freeze({
    skillId: crypto.randomUUID(),
    sourceId: crypto.randomUUID(),
    slug: persisted.data.slug,
    name: persisted.data.name,
    scope,
    ownerPrincipalId: scope === "personal" ? principalId : null,
    copiedFrom: Object.freeze({
      skillId: sourceSkill.id,
      versionId: version.id,
    }),
  });
  await boundedMutation(() =>
    insertLocalSkillIdentity<SkillRow>(
      transaction,
      organizationId,
      identity,
      SKILL_COLUMNS,
    )
  );
  // Revalidated like any upload: the manifest digest and every file hash are
  // recomputed from the bytes read back, so a damaged source cannot be copied.
  const publication = await prepareLocalSkillVersionPublication({
    transaction,
    organizationId,
    principalId,
    input: {
      id: identity.skillId,
      revision: 1,
      digest: version.digest,
      entryPath: version.entry_path,
      manifest: version.manifest as JsonValue,
      files: uploads,
    },
  });
  return Object.freeze({ identity, publication });
}

/**
 * Commits the copy in the final transaction: the skill and its source, then the
 * source's files as version 1 of it, each object already verified by the store
 * phase. Returns the new skill with its version active.
 */
export async function commitSkillCopy(options: {
  transaction: PgTransactionClient;
  context: ActionContext;
  organizationId: string;
  principalId: string;
  preparation: SkillCopyPreparation;
  proof: LocalSkillVersionPublicationProof;
}) {
  const { transaction, organizationId, principalId, preparation } = options;
  const { identity } = preparation;
  await boundedMutation(() =>
    insertLocalSkillIdentity<SkillRow>(
      transaction,
      organizationId,
      identity,
      SKILL_COLUMNS,
    )
  );
  await finalizeLocalSkillVersionPublication({
    transaction,
    context: options.context,
    preparation: preparation.publication,
    proof: options.proof,
  });
  const row = (await transaction.query<SkillRow>(
    `select ${SKILL_COLUMNS} from bakery.skills
      where organization_id = $1 and id = $2`,
    [organizationId, identity.skillId],
  )).rows[0];
  if (!row) throw new Error("CATALOG_SKILL_COPY_MISSING");
  await recordMutation(transaction, options.context, {
    organizationId,
    principalId,
    operation: "skills.copy",
    eventType: "skills.copied",
    resourceType: "skill",
    resourceId: identity.skillId,
    resourceVersion: row.version,
  });
  return toSkill(row);
}
