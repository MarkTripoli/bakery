import { z } from "zod";

export const RegistrationMode = Object.freeze(
  {
    Closed: "closed",
    Invitation: "invitation",
  } as const,
);

export const OrganizationCreationPolicy = Object.freeze(
  {
    InstallationAdministrators: "installation_admins",
    AnyUser: "any_user",
  } as const,
);

export const RegistrationModeSchema = z.enum(RegistrationMode).describe(
  "Installation registration policy: closed refuses new accounts; invitation requires a live organization invitation.",
);

export const OrganizationCreationPolicySchema = z.enum(
  OrganizationCreationPolicy,
).describe(
  "Installation organization creation policy: installation administrators only, or any authenticated human.",
);

export type RegistrationMode = z.infer<typeof RegistrationModeSchema>;
export type OrganizationCreationPolicy = z.infer<
  typeof OrganizationCreationPolicySchema
>;

export const InstallationSettingsUpdateSchema = z.strictObject({
  registrationMode: RegistrationModeSchema,
  organizationCreationPolicy: OrganizationCreationPolicySchema,
}).describe(
  "Administrator's complete editable installation policy; optimistic concurrency uses the separate current version precondition.",
);

export const InstallationSettingsSchema = z.strictObject({
  ...InstallationSettingsUpdateSchema.shape,
  version: z.number().int().positive().describe(
    "Monotonic installation policy revision used to reject stale updates.",
  ),
  updatedByPrincipalId: z.uuid().nullable().describe(
    "Principal who last changed installation policy, or null for initial defaults.",
  ),
  updatedAt: z.iso.datetime({ offset: true }).describe(
    "Timestamp of the last installation policy update.",
  ),
}).describe(
  "Installation-wide policy snapshot; read live on each request that needs it.",
);

export type InstallationSettingsUpdate = z.infer<
  typeof InstallationSettingsUpdateSchema
>;
export type InstallationSettings = z.infer<typeof InstallationSettingsSchema>;

export const InstallationCapabilitiesSchema = z.strictObject({
  registration: RegistrationModeSchema,
  organizationCreation: OrganizationCreationPolicySchema,
  ssoAvailable: z.boolean().describe(
    "Whether SSO is available on this installation; it grants no caller authority.",
  ),
}).describe(
  "Public installation policy vocabulary; it never grants caller-specific authority.",
);

export type InstallationCapabilities = z.infer<
  typeof InstallationCapabilitiesSchema
>;
