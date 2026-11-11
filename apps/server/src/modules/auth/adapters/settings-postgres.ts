import { StandardError } from "@bakery/contracts/http";
import { directionForLocale, resolvePreferredLocale } from "@bakery/i18n";
import type { PgTransactionClient } from "../../../platform/database.ts";
import { recordAuthAudit } from "../application/audit.ts";
import { nextOrganizationSequence } from "../../../platform/event-clock.ts";
import {
  prepareProfileUpdate,
  type ProfileUpdateInput,
  type ProfileUpdateValues,
} from "../application/profile.ts";
import {
  isThemePreference,
  normalizeLocaleTag,
  normalizeTimeZone,
  PREFERENCES_SCHEMA_VERSION,
  type ThemePreference,
} from "../application/preferences.ts";

type Timestamp = Date | string;

function iso(value: Timestamp): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

type ProfileRow = {
  name: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  image: string | null;
  email: string;
  emailVerified: boolean;
  profileVersion: number;
  updatedAt: Timestamp;
};

function profile(principalId: string, row: ProfileRow) {
  return {
    principalId,
    name: row.name,
    firstName: row.firstName,
    lastName: row.lastName,
    title: row.title,
    image: row.image,
    email: row.email,
    emailVerified: row.emailVerified,
    version: row.profileVersion,
    updatedAt: iso(row.updatedAt),
  };
}

const PROFILE_COLUMNS = `name, first_name as "firstName",
  last_name as "lastName", title, image, email, "emailVerified",
  profile_version as "profileVersion", "updatedAt"`;

/** The caller's own profile row; the target is always the session's user. */
export async function readProfile(
  client: PgTransactionClient,
  principalId: string,
  providerUserId: string,
) {
  const result = await client.query<ProfileRow>(
    `select ${PROFILE_COLUMNS} from public."user" where id = $1`,
    [providerUserId],
  );
  if (result.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return profile(principalId, result.rows[0]);
}

/**
 * Applies a validated profile change to the caller's own provider user under
 * a version precondition, and refreshes the human principal's display-name
 * cache in the same transaction.
 */
export async function updateProfile(
  client: PgTransactionClient,
  principalId: string,
  providerUserId: string,
  input: ProfileUpdateInput,
  expectedVersion: number,
) {
  const values: ProfileUpdateValues = prepareProfileUpdate(input);
  const locked = await client.query<ProfileRow>(
    `select ${PROFILE_COLUMNS} from public."user" where id = $1 for update`,
    [providerUserId],
  );
  if (locked.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (locked.rows[0].profileVersion !== expectedVersion) {
    throw new StandardError({ code: "VERSION_CONFLICT" });
  }
  const updated = await client.query<ProfileRow>(
    `update public."user"
    set name = case when $2 then $3 else name end,
      first_name = case when $4 then $5 else first_name end,
      last_name = case when $6 then $7 else last_name end,
      title = case when $8 then $9 else title end,
      image = case when $10 then $11 else image end,
      profile_version = profile_version + 1,
      "updatedAt" = current_timestamp
    where id = $1
    returning ${PROFILE_COLUMNS}`,
    [
      providerUserId,
      values.name !== undefined,
      values.name ?? null,
      values.firstName !== undefined,
      values.firstName ?? null,
      values.lastName !== undefined,
      values.lastName ?? null,
      values.title !== undefined,
      values.title ?? null,
      values.image !== undefined,
      values.image ?? null,
    ],
  );
  if (updated.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  if (values.name !== undefined) {
    await client.query(
      `update bakery.principals
      set display_name = $2, updated_at = current_timestamp,
        version = version + 1
      where id = $1 and principal_type = 'human'`,
      [principalId, values.name],
    );
  }
  return profile(principalId, updated.rows[0]);
}

type PreferencesRow = {
  id: string | null;
  preferences: unknown;
  casVersion: number | null;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
  preferredLocale: string | null;
  defaultLocale: string | null;
};

type StoredPreferences = {
  theme: ThemePreference;
  timeZone: string | null;
};

function storedPreferences(value: unknown): StoredPreferences {
  const record = value !== null && typeof value === "object" &&
      !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const theme = isThemePreference(record.theme) ? record.theme : "system";
  const timeZone = typeof record.timeZone === "string" &&
      normalizeTimeZone(record.timeZone) !== undefined
    ? record.timeZone
    : null;
  return { theme, timeZone };
}

function preferencesView(
  organizationId: string,
  principalId: string,
  row: PreferencesRow,
  options: {
    availableLocales: readonly string[];
    acceptLanguage: string | null;
  },
) {
  const stored = storedPreferences(row.preferences);
  const effectiveLocale = resolvePreferredLocale({
    preferred: row.preferredLocale,
    organizationDefault: row.defaultLocale,
    acceptLanguage: options.acceptLanguage,
  });
  return {
    id: row.id,
    organizationId,
    principalId,
    theme: stored.theme,
    locale: row.preferredLocale,
    timeZone: stored.timeZone,
    effectiveLocale,
    direction: directionForLocale(effectiveLocale),
    availableLocales: [...options.availableLocales],
    casVersion: row.casVersion ?? 0,
    createdAt: row.createdAt === null ? null : iso(row.createdAt),
    updatedAt: row.updatedAt === null ? null : iso(row.updatedAt),
  };
}

const PREFERENCES_SELECT = `select preference.id, preference.preferences,
    preference.cas_version as "casVersion",
    preference.created_at as "createdAt",
    preference.updated_at as "updatedAt",
    principal.preferred_locale as "preferredLocale",
    organization.default_locale as "defaultLocale"
  from bakery.principals as principal
  join bakery.organizations as organization on organization.id = $2
  left join bakery.user_preferences as preference
    on preference.organization_id = organization.id
    and preference.principal_id = principal.id
  where principal.id = $1`;

export async function readUserPreferences(
  client: PgTransactionClient,
  organizationId: string,
  principalId: string,
  options: {
    availableLocales: readonly string[];
    acceptLanguage: string | null;
  },
) {
  const result = await client.query<PreferencesRow>(
    PREFERENCES_SELECT,
    [principalId, organizationId],
  );
  if (result.rows.length !== 1) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
  return preferencesView(
    organizationId,
    principalId,
    result.rows[0],
    options,
  );
}

export type UserPreferencesChange = {
  theme?: ThemePreference;
  locale?: string | null;
  timeZone?: string | null;
  expectedCasVersion: number;
};

/**
 * Compare-and-swap write of the member's appearance, language and time zone.
 * Theme and time zone live in the organization-scoped row; the language is
 * account-wide and is written to the principal in the same transaction.
 */
export async function updateUserPreferences(
  client: PgTransactionClient,
  organizationId: string,
  principalId: string,
  change: UserPreferencesChange,
  options: {
    availableLocales: readonly string[];
    acceptLanguage: string | null;
    requestId: string;
    traceId: string;
  },
) {
  if (
    change.theme === undefined && change.locale === undefined &&
    change.timeZone === undefined
  ) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  let locale: string | null | undefined;
  if (change.locale !== undefined) {
    locale = change.locale === null
      ? null
      : normalizeLocaleTag(change.locale, options.availableLocales);
    if (locale === undefined) {
      throw new StandardError({ code: "UNPROCESSABLE" });
    }
  }
  let timeZone: string | null | undefined;
  if (change.timeZone !== undefined) {
    timeZone = change.timeZone === null
      ? null
      : normalizeTimeZone(change.timeZone);
    if (timeZone === undefined) {
      throw new StandardError({ code: "UNPROCESSABLE" });
    }
  }
  await client.query(
    `select pg_advisory_xact_lock(
      hashtextextended('bakery:user-preferences:' || $1::text || ':' || $2::text, 0)
    )`,
    [organizationId, principalId],
  );
  const membership = await client.query(
    `select 1 from bakery.organization_memberships
    where organization_id = $1 and principal_id = $2 and status = 'active'
    for share`,
    [organizationId, principalId],
  );
  if (membership.rows.length !== 1) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  const existing = await client.query<
    { id: string; preferences: unknown; casVersion: number }
  >(
    `select id, preferences, cas_version as "casVersion"
    from bakery.user_preferences
    where organization_id = $1 and principal_id = $2
    for update`,
    [organizationId, principalId],
  );
  const current = existing.rows[0];
  const currentVersion = current?.casVersion ?? 0;
  if (currentVersion !== change.expectedCasVersion) {
    throw new StandardError({ code: "VERSION_CONFLICT" });
  }
  const previous = storedPreferences(current?.preferences);
  const next = {
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    theme: change.theme ?? previous.theme,
    timeZone: timeZone === undefined ? previous.timeZone : timeZone,
  };
  let rowId: string;
  const nextVersion = currentVersion + 1;
  if (current) {
    rowId = current.id;
    await client.query(
      `update bakery.user_preferences
      set preferences = $2::jsonb, cas_version = $3,
        updated_at = current_timestamp
      where id = $1`,
      [rowId, JSON.stringify(next), nextVersion],
    );
  } else {
    const inserted = await client.query<{ id: string }>(
      `insert into bakery.user_preferences (
        organization_id, principal_id, preferences, cas_version
      ) values ($1, $2, $3::jsonb, $4)
      returning id`,
      [organizationId, principalId, JSON.stringify(next), nextVersion],
    );
    rowId = inserted.rows[0].id;
  }
  if (locale !== undefined) {
    await client.query(
      `update bakery.principals
      set preferred_locale = $2, updated_at = current_timestamp,
        version = version + 1
      where id = $1`,
      [principalId, locale],
    );
  }
  const sequence = await nextOrganizationSequence(client, organizationId);
  await client.query(
    `insert into bakery.domain_events (
       organization_id, organization_sequence, event_type, schema_version,
       aggregate_id, aggregate_version, payload, trace_id
     ) values ($1, $2, 'user.preferences_changed', 1, $3, $4, $5::jsonb, $6)`,
    [
      organizationId,
      sequence,
      rowId,
      nextVersion,
      JSON.stringify({ resourceId: rowId, resourceVersion: nextVersion }),
      options.traceId,
    ],
  );
  await recordAuthAudit(
    client,
    options,
    {
      organizationId,
      principalId,
      operation: "userPreferences.update",
      resourceType: "user_preferences",
      resourceId: rowId,
    },
  );
  return await readUserPreferences(
    client,
    organizationId,
    principalId,
    options,
  );
}

/**
 * Organization default language and the caller's saved time zone for the
 * organization that scopes identity presentation: the one named by the
 * `Bakery-Organization-Id` header when the caller is an active member, else
 * the caller's only active organization. Ambiguity resolves to no
 * organization, never a guess.
 */
export async function loadIdentityPresentation(
  client: Pick<PgTransactionClient, "query">,
  principalId: string,
  requestedOrganizationId: string | null,
): Promise<{ defaultLocale: string | null; timeZone: string | null }> {
  const result = await client.query<
    { defaultLocale: string | null; preferences: unknown }
  >(
    `select organization.default_locale as "defaultLocale",
      preference.preferences
    from bakery.organization_memberships as membership
    join bakery.organizations as organization
      on organization.id = membership.organization_id
    left join bakery.user_preferences as preference
      on preference.organization_id = membership.organization_id
      and preference.principal_id = membership.principal_id
    where membership.principal_id = $1
      and membership.status = 'active'
      and ($2::uuid is null or membership.organization_id = $2::uuid)
    order by organization.created_at asc, organization.id asc
    limit 2`,
    [principalId, requestedOrganizationId],
  );
  if (result.rows.length !== 1) return { defaultLocale: null, timeZone: null };
  const [row] = result.rows;
  return {
    defaultLocale: row.defaultLocale,
    timeZone: row.preferences === null || row.preferences === undefined
      ? null
      : storedPreferences(row.preferences).timeZone,
  };
}
