import type { PgDatabase } from "../../../platform/database.ts";

/** What the SCIM plugins need from the host: the pool and an optional clock. */
export type ScimHost = Readonly<{
  database: PgDatabase;
  clock?: () => Date;
}>;

/** A freshly issued SCIM bearer credential; `secret` is shown to the caller once. */
export type ScimCredentialIssue = Readonly<{
  connectionId: string;
  credentialId: string;
  secret: string;
  expiresAt: Date;
}>;

export type ScimCreateInput = Readonly<{
  organizationId: string;
  principalId: string;
  expiresInDays: number;
  now?: Date;
}>;

export type ScimRotateInput =
  & ScimCreateInput
  & Readonly<{
    /** Minutes earlier credentials keep working; 0 retires them at once. */
    previousExpireMinutes: number;
  }>;
