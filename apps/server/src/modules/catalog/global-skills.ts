import type {
  ActionAuthorityRunner,
  ActionContext,
} from "@bakery/contracts/action-registry";
import { CatalogImplementedAction } from "@bakery/contracts/implemented-actions";
import type { PgTransactionClient } from "../../platform/database.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import type { CatalogActionHandlers } from "./actions.ts";
import {
  BAKERY_PRINCIPAL_ID,
  ensureBakeryPrincipal,
} from "./bakery-principal.ts";
import {
  type BundledSkill,
  bundledSkills,
  bundledSkillUpload,
} from "./bundled-skills/index.ts";
import {
  finalizeSkillVersionPublication,
  type LocalSkillVersionPublicationPreparation,
  type LocalSkillVersionPublicationProof,
  prepareLocalSkillVersionPublication,
  reactivatePublishedSkillVersion,
  storeLocalSkillVersionPublication,
} from "./publication.ts";
import {
  type GlobalSkillIdentity,
  insertGlobalSkillIdentity,
} from "./skill-identity.ts";
import { SKILL_COLUMNS } from "./persistence.ts";
import type { SkillFileStoreOperations } from "./storage.ts";
import { validateLocalSkillVersion } from "./validation.ts";

/**
 * Bakery's own skills are installed into each organization as that
 * organization's rows (scope global), never read across organizations: every
 * row, version and file keeps its organization, so tenant isolation holds. An
 * installed skill records Bakery as its publisher and the digest of the bundled
 * package it came from, and no request can change it.
 *
 * Installing is idempotent. It runs the first time an organization lists its
 * skills (see routes.ts), so an organization created tomorrow and one that has
 * existed for a year are both covered by the same path, once each.
 */

/** One package to put in one organization: a new skill, or a new revision of it. */
export type GlobalSkillInstall = Readonly<{
  identity: GlobalSkillIdentity;
  /** True when the skill row does not exist yet in this organization. */
  isNew: boolean;
  publication: LocalSkillVersionPublicationPreparation;
}>;

export type GlobalSkillReactivation = Readonly<{
  skillId: string;
  versionId: string;
}>;

export type GlobalSkillInstallPreparation = Readonly<{
  organizationId: string;
  installs: readonly GlobalSkillInstall[];
  reactivations: readonly GlobalSkillReactivation[];
}>;

async function derivedId(...parts: string[]): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(parts.join("\0")),
    ),
  );
  hash[6] = (hash[6] & 0x0f) | 0x80;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = Array.from(
    hash.slice(0, 16),
    (b) => b.toString(16).padStart(2, "0"),
  );
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

/** The skill id a package has in an organization: the same on every retry. */
export function globalSkillId(
  organizationId: string,
  packageSlug: string,
): Promise<string> {
  return derivedId("bakery.global-skill", organizationId, packageSlug);
}

function globalSkillSourceId(
  organizationId: string,
  packageSlug: string,
): Promise<string> {
  return derivedId("bakery.global-skill-source", organizationId, packageSlug);
}

/**
 * Works out what this organization is missing, inside the preflight
 * transaction, which the caller rolls back before any object is written. It
 * returns nothing to install for an organization that is up to date, which is
 * one short read.
 */
export async function prepareGlobalSkillInstall(options: {
  transaction: PgTransactionClient;
  organizationId: string;
  packages?: readonly BundledSkill[];
}): Promise<GlobalSkillInstallPreparation> {
  const { transaction, organizationId } = options;
  const packages = options.packages ?? await bundledSkills();
  const installs: GlobalSkillInstall[] = [];
  const reactivations: GlobalSkillReactivation[] = [];
  let principalReady = false;
  for (const bundled of packages) {
    const skillId = await globalSkillId(organizationId, bundled.slug);
    const existing = await transaction.query<{
      id: string;
      scope: string;
      digest: string | null;
      revision: number | null;
    }>(
      `select skill.id, skill.scope, version.digest, version.revision
         from bakery.skills as skill
         left join bakery.skill_versions as version
           on version.organization_id = skill.organization_id
          and version.id = skill.active_version_id
        where skill.organization_id = $1 and skill.scope <> 'personal'
          and (skill.id = $2 or skill.slug = $3)`,
      [organizationId, skillId, bundled.slug],
    );
    const own = existing.rows.find((row) => row.id === skillId);
    // An organization skill that already holds the slug is the organization's
    // own; Bakery's skill is not installed over it.
    if (!own && existing.rows.length > 0) continue;
    const latest = own === undefined ? undefined : (await transaction.query<{
      revision: number;
    }>(
      `select max(revision) as revision from bakery.skill_versions
        where organization_id = $1 and skill_id = $2`,
      [organizationId, skillId],
    )).rows[0];
    const revision = (latest?.revision ?? 0) + 1;
    const upload = await bundledSkillUpload(bundled, skillId, revision);
    const digest = (await validateLocalSkillVersion(upload, {
      computeDigest: true,
    })).digest;
    if (own?.digest === digest) continue;
    const earlier = own === undefined
      ? undefined
      : (await transaction.query<{ id: string }>(
        `select id from bakery.skill_versions
          where organization_id = $1 and skill_id = $2 and digest = $3
            and status = 'published'`,
        [organizationId, skillId, digest],
      )).rows[0];
    if (earlier) {
      reactivations.push(Object.freeze({ skillId, versionId: earlier.id }));
      continue;
    }
    if (!principalReady) {
      await ensureBakeryPrincipal(transaction);
      principalReady = true;
    }
    const identity: GlobalSkillIdentity = Object.freeze({
      skillId,
      sourceId: await globalSkillSourceId(organizationId, bundled.slug),
      slug: bundled.slug,
      name: bundled.name,
      packageSlug: bundled.slug,
    });
    if (own === undefined) {
      await insertGlobalSkillIdentity(
        transaction,
        organizationId,
        identity,
        SKILL_COLUMNS,
      );
    }
    installs.push(Object.freeze({
      identity,
      isNew: own === undefined,
      publication: await prepareLocalSkillVersionPublication({
        transaction,
        organizationId,
        principalId: BAKERY_PRINCIPAL_ID,
        input: { ...upload, digest },
        hostInstall: true,
      }),
    }));
  }
  return Object.freeze({
    organizationId,
    installs: Object.freeze(installs),
    reactivations: Object.freeze(reactivations),
  });
}

export async function reactivateGlobalSkillVersions(options: {
  transaction: PgTransactionClient;
  preparation: GlobalSkillInstallPreparation;
  requestId: string;
  traceId: string;
}): Promise<void> {
  const { transaction, preparation } = options;
  for (const reactivation of preparation.reactivations) {
    await reactivatePublishedSkillVersion(transaction, {
      organizationId: preparation.organizationId,
      principalId: BAKERY_PRINCIPAL_ID,
      skillId: reactivation.skillId,
      versionId: reactivation.versionId,
      operation: "skillVersions.install",
      requestId: options.requestId,
      traceId: options.traceId,
    });
  }
}

/** Stores every package's files, after the preflight has rolled back. */
export async function storeGlobalSkillInstall(
  preparation: GlobalSkillInstallPreparation,
  store: SkillFileStoreOperations,
): Promise<readonly LocalSkillVersionPublicationProof[]> {
  const proofs: LocalSkillVersionPublicationProof[] = [];
  for (const install of preparation.installs) {
    proofs.push(
      await storeLocalSkillVersionPublication(install.publication, store),
    );
  }
  return proofs;
}

/**
 * Writes the installs in the final transaction. An organization is installed by
 * one request at a time: a second one waits on the lock, finds the work done and
 * writes nothing.
 */
export async function commitGlobalSkillInstall(options: {
  transaction: PgTransactionClient;
  preparation: GlobalSkillInstallPreparation;
  proofs: readonly LocalSkillVersionPublicationProof[];
  requestId: string;
  traceId: string;
}): Promise<void> {
  const { transaction, preparation } = options;
  await transaction.query(
    "select pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`bakery.global-skills:${preparation.organizationId}`],
  );
  await ensureBakeryPrincipal(transaction);
  await reactivateGlobalSkillVersions(options);
  for (const [index, install] of preparation.installs.entries()) {
    const present = await transaction.query(
      "select 1 from bakery.skills where organization_id = $1 and id = $2",
      [preparation.organizationId, install.identity.skillId],
    );
    // The preflight's slug check ran before the files were stored. Someone may
    // have created an organization skill with this slug since, so it is asked
    // again here, under the lock: the organization's own skill is kept and
    // Bakery's is not installed over it.
    const slugTaken = await transaction.query(
      `select 1 from bakery.skills
        where organization_id = $1 and scope <> 'personal'
          and slug = $2 and id <> $3`,
      [
        preparation.organizationId,
        install.identity.slug,
        install.identity.skillId,
      ],
    );
    if (slugTaken.rows.length > 0) continue;
    if (install.isNew && present.rows.length === 0) {
      await insertGlobalSkillIdentity(
        transaction,
        preparation.organizationId,
        install.identity,
        SKILL_COLUMNS,
      );
    }
    await finalizeSkillVersionPublication({
      transaction,
      preparation: install.publication,
      proof: options.proofs[index],
      allowReservedDraft: false,
      operation: "skillVersions.install",
      requestId: options.requestId,
      traceId: options.traceId,
    });
  }
}

const globalInstallStage = Symbol("globalInstallStage");

/** skills.list in stages, when the organization is missing Bakery's own skills. */
type GlobalInstallStage = {
  preparation?: GlobalSkillInstallPreparation;
  proofs?: readonly LocalSkillVersionPublicationProof[];
};

type GlobalInstallContext = ActionContext & {
  [globalInstallStage]?: GlobalInstallStage;
};

class GlobalInstallPreflightRollbackError extends Error {
  constructor() {
    super("SKILL_GLOBAL_INSTALL_PREFLIGHT_ROLLBACK");
    this.name = "GlobalInstallPreflightRollbackError";
  }
}

/**
 * Listing skills first makes sure the organization has Bakery's own skills: one
 * short read when it does. When it does not, the handler stops after the
 * preflight (see `createGlobalSkillAuthority`) and, once the files are stored,
 * installs and lists in one transaction. A call that did not come through that
 * authority has no stage and lists as before.
 */
export function withGlobalSkillInstall(
  handlers: CatalogActionHandlers,
): CatalogActionHandlers {
  return {
    ...handlers,
    listSkills: async (context, input) => {
      const stage = (context as GlobalInstallContext)[globalInstallStage];
      if (stage) {
        const { transaction, organizationId } = requireWorkTransaction(context);
        if (stage.proofs && stage.preparation) {
          await commitGlobalSkillInstall({
            transaction,
            preparation: stage.preparation,
            proofs: stage.proofs,
            requestId: context.requestId,
            traceId: context.traceId,
          });
        } else {
          const preparation = await prepareGlobalSkillInstall({
            transaction,
            organizationId,
          });
          if (preparation.installs.length > 0) {
            stage.preparation = preparation;
            throw new GlobalInstallPreflightRollbackError();
          }
          await reactivateGlobalSkillVersions({
            transaction,
            preparation,
            requestId: context.requestId,
            traceId: context.traceId,
          });
        }
      }
      return await handlers.listSkills(context, input);
    },
  };
}

/**
 * The authority that runs `skills.list` in the two passes the install needs,
 * the way a version publication does: preflight (rolled back), store the files
 * with no connection held, then the real pass. Every other action, and every
 * call when no skill file store is configured, runs under `base` untouched.
 */
export function createGlobalSkillAuthority(
  base: ActionAuthorityRunner,
  store: SkillFileStoreOperations | undefined,
): ActionAuthorityRunner {
  return {
    async run(action, context, input, next) {
      if (action.name !== CatalogImplementedAction.SkillsList || !store) {
        return await base.run(action, context, input, next);
      }
      const stage: GlobalInstallStage = {};
      const staged = () =>
        Object.assign({}, context, { [globalInstallStage]: stage });
      try {
        return await base.run(action, staged(), input, next);
      } catch (error) {
        if (!(error instanceof GlobalInstallPreflightRollbackError)) {
          throw error;
        }
      }
      if (!stage.preparation) {
        throw new Error("SKILL_GLOBAL_INSTALL_PREPARATION_MISSING");
      }
      stage.proofs = await storeGlobalSkillInstall(stage.preparation, store);
      return await base.run(action, staged(), input, next);
    },
  };
}
