import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import {
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import { ProjectsImplementedAction } from "@bakery/contracts/implemented-actions";
import {
  type ScopeProfile,
  ScopeProfileSchema,
} from "@bakery/contracts/scope-profiles";
import type { PgTransactionClient } from "../../platform/database.ts";
import { canonicalJson, sha256Hex } from "../../platform/canonical-json.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { recordAudit } from "./postgres.ts";

type ProjectScopeProfile = z.output<typeof contractSchemas.ProjectScopeProfile>;
type ProjectScopeProfilePut = z.output<
  typeof contractSchemas.ProjectScopeProfilePut
>;

/** A published project scope profile as stored, owned by one project. */
export type StoredProjectScopeProfile = ScopeProfile & {
  applicationId: string;
  updatedAt: string;
};

type ScopeProfileRow = {
  application_id: string;
  revision: number;
  digest: string;
  check_commands: unknown;
  rules: unknown;
  updated_at: string;
};

const PROFILE_CONTENT = ScopeProfileSchema.pick({
  checkCommands: true,
  rules: true,
});

/**
 * Reads the published scope profile of one project in one organization, or
 * null when the project has published none (the empty baseline). The caller
 * names both identifiers, so a profile never crosses an organization.
 */
export async function readProjectScopeProfile(
  transaction: Pick<PgTransactionClient, "query">,
  organizationId: string,
  applicationId: string,
  options: { readonly lock?: boolean } = {},
): Promise<StoredProjectScopeProfile | null> {
  const result = await transaction.query<ScopeProfileRow>(
    `select application_id, revision, digest, check_commands, rules,
       to_char(updated_at at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
       from bakery.project_scope_profiles
      where organization_id = $1 and application_id = $2${
      options.lock ? " for update" : ""
    }`,
    [organizationId, applicationId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const profile = ScopeProfileSchema.parse({
    revision: row.revision,
    digest: row.digest,
    checkCommands: row.check_commands,
    rules: row.rules,
  });
  return {
    ...profile,
    applicationId: row.application_id,
    updatedAt: row.updated_at,
  };
}

function projection(
  applicationId: string,
  stored: StoredProjectScopeProfile | null,
): ProjectScopeProfile {
  return stored === null
    ? {
      applicationId,
      revision: 0,
      digest: null,
      checkCommands: [],
      rules: [],
      updatedAt: null,
    }
    : {
      applicationId,
      revision: stored.revision,
      digest: stored.digest,
      checkCommands: stored.checkCommands,
      rules: stored.rules as ProjectScopeProfile["rules"],
      updatedAt: stored.updatedAt,
    };
}

function requireApplicationId(context: ActionContext): string {
  const applicationId = context.params.applicationId;
  if (!applicationId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return applicationId;
}

/**
 * The project must exist in the caller's organization. A project of another
 * organization answers exactly like a missing one.
 */
async function assertProjectVisible(
  transaction: PgTransactionClient,
  organizationId: string,
  applicationId: string,
  options: { readonly lock?: boolean } = {},
): Promise<void> {
  const result = await transaction.query(
    `select 1 from bakery.applications
      where organization_id = $1 and id = $2${
      options.lock ? " for update" : ""
    }`,
    [organizationId, applicationId],
  );
  if (result.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

/** scopeProfiles.get */
export async function getProjectScopeProfile(
  context: ActionContext,
): Promise<ProjectScopeProfile> {
  const { transaction, organizationId } = requireWorkTransaction(context);
  const applicationId = requireApplicationId(context);
  await assertProjectVisible(transaction, organizationId, applicationId);
  return projection(
    applicationId,
    await readProjectScopeProfile(transaction, organizationId, applicationId),
  );
}

/**
 * scopeProfiles.put: publishes the next revision of a project's scope profile.
 * The first save carries no If-Match; every later save names the current
 * revision (428 when missing, 412 when stale), so two editors cannot both win.
 */
export async function putProjectScopeProfile(
  context: ActionContext,
  input: ProjectScopeProfilePut,
): Promise<ProjectScopeProfile> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const applicationId = requireApplicationId(context);
  const content = PROFILE_CONTENT.safeParse({
    checkCommands: input.checkCommands,
    rules: input.rules,
  });
  if (!content.success) {
    throw unprocessable(["checkCommands"], "scope_profile_invalid");
  }
  const ids = content.data.checkCommands.map((command) => command.id);
  if (new Set(ids).size !== ids.length) {
    throw unprocessable(["checkCommands"], "check_id_duplicate");
  }
  // Lock the project first: a concurrent first save then waits here instead
  // of racing the insert.
  await assertProjectVisible(transaction, organizationId, applicationId, {
    lock: true,
  });
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  const stored = await readProjectScopeProfile(
    transaction,
    organizationId,
    applicationId,
    { lock: true },
  );
  if (stored === null) {
    if (expectedVersion !== undefined) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
  } else {
    if (expectedVersion === undefined) {
      throw new StandardError({ code: "PRECONDITION_REQUIRED" });
    }
    if (expectedVersion !== stored.revision) {
      throw new StandardError({ code: "PRECONDITION_FAILED" });
    }
  }
  const revision = (stored?.revision ?? 0) + 1;
  const digest = await sha256Hex(canonicalJson(content.data));
  const written = stored === null
    ? await transaction.query(
      `insert into bakery.project_scope_profiles (organization_id,
         application_id, revision, digest, check_commands, rules, updated_by)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
       on conflict do nothing
       returning application_id`,
      [
        organizationId,
        applicationId,
        revision,
        digest,
        JSON.stringify(content.data.checkCommands),
        JSON.stringify(content.data.rules),
        principalId,
      ],
    )
    : await transaction.query(
      `update bakery.project_scope_profiles
          set revision = $3, digest = $4, check_commands = $5::jsonb,
              rules = $6::jsonb, updated_by = $7, updated_at = now()
        where organization_id = $1 and application_id = $2
          and revision = $8
        returning application_id`,
      [
        organizationId,
        applicationId,
        revision,
        digest,
        JSON.stringify(content.data.checkCommands),
        JSON.stringify(content.data.rules),
        principalId,
        stored.revision,
      ],
    );
  if (written.rows.length !== 1) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  await recordAudit(transaction, {
    organizationId,
    principalId,
    operation: ProjectsImplementedAction.ScopeProfilesPut,
    resourceType: "project_scope_profile",
    resourceId: applicationId,
    requestId: context.requestId,
    traceId: context.traceId,
    details: {
      revision,
      checkCommandCount: content.data.checkCommands.length,
      ruleCount: content.data.rules.length,
    },
  });
  return projection(
    applicationId,
    await readProjectScopeProfile(transaction, organizationId, applicationId),
  );
}
