import { z } from "zod";
import {
  MembershipStatus,
  type MembershipStatus as MembershipStatusValue,
  OrganizationRole,
  type OrganizationRole as OrganizationRoleValue,
} from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import { normalizeEmail } from "../domain/registration.ts";

const INVITATION_LIFETIME_MS = 48 * 60 * 60 * 1_000;

export type OrganizationCreateInput = { name: string; slug: string };
export type OrganizationUpdateInput = {
  name?: string;
  logo?: string;
  metadata?: unknown;
  defaultLocale?: string | null;
};
export type OrganizationUpdateValues = {
  name?: string;
  logo?: string;
  metadata?: string;
  defaultLocale?: string | null;
};
export type OrganizationMembershipCreateInput = {
  principalId: string;
  role: OrganizationRoleValue | null;
};
export type OrganizationMembershipUpdateInput = {
  role?: OrganizationRoleValue | null;
  status?: MembershipStatusValue;
};
export type OrganizationInvitationCreateInput = {
  email: string;
  role: OrganizationRoleValue;
};
export type OrganizationInvitationRecipientGetInput = { id: string };
export type OrganizationInvitationRecipientActionInput = {
  invitationId: string;
};
export type OrganizationInvitationPreviewGetInput = { invitationId: string };
export type OrganizationInvitationCreateValues = {
  email: string;
  role: OrganizationRoleValue;
  expiresAt: Date;
};

/**
 * Domain rules layered on top of the transport contract, which has already
 * enforced shape, required fields, and size bounds. These schemas normalize
 * (trim, lowercase, serialize) and apply the cross-field rules the wire
 * contract cannot express.
 */
const trimmedNonEmpty = z.string().trim().min(1).describe(
  "Trimmed non-empty text.",
);
const role = z.enum(OrganizationRole).describe("Declared organization role.");
const membershipStatus = z.enum(MembershipStatus).describe(
  "Declared membership status.",
);
const serializedJson = z.unknown().transform((value, context) => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) {
    context.addIssue({ code: "custom", message: "metadata must serialize" });
    return z.NEVER;
  }
  return serialized;
}).describe("Metadata serialized to a JSON string.");
const email = z.string().transform(normalizeEmail).pipe(
  z.string().min(3).max(320).regex(/^[^\s@]+@[^\s@]+$/).describe(
    "Normalized email address.",
  ),
).describe("Trimmed, lowercased email address.");

const organizationCreate = z.object({
  name: trimmedNonEmpty,
  slug: trimmedNonEmpty,
}).describe("Normalized organization creation values.");
const organizationUpdate = z.object({
  name: trimmedNonEmpty.optional(),
  logo: z.string().optional().describe("Optional logo reference."),
  metadata: serializedJson.optional(),
  defaultLocale: z.string().trim().min(2).max(35).nullable().optional()
    .describe(
      "Optional default language tag for the organization; null clears it.",
    ),
}).transform((values) =>
  Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as OrganizationUpdateValues
).refine((values) => Object.keys(values).length > 0).describe(
  "Normalized organization update with at least one field.",
);
const membershipCreate = z.object({
  principalId: z.string().describe("Principal to add."),
  role: role.nullable().describe(
    "Optional role bundle; null gives a service or worker grant-only access.",
  ),
}).describe("Validated membership creation values.");
const membershipUpdate = z.object({
  role: role.nullable().optional().describe(
    "Optional role bundle; null explicitly removes a non-human role.",
  ),
  status: membershipStatus.optional(),
}).refine((values) => values.role !== undefined || values.status !== undefined)
  .describe("Membership update with at least one of role or status.");
const invitationCreate = z.object({ email, role }).describe(
  "Validated invitation creation values.",
);

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new StandardError({ code: "UNPROCESSABLE" });
  return result.data;
}

export function prepareOrganizationCreate(
  input: OrganizationCreateInput,
): OrganizationCreateInput {
  return parse(organizationCreate, input);
}

export function prepareOrganizationUpdate(
  input: OrganizationUpdateInput,
): OrganizationUpdateValues {
  return parse(organizationUpdate, input);
}

export function prepareMembershipCreate(
  input: OrganizationMembershipCreateInput,
): OrganizationMembershipCreateInput {
  return parse(membershipCreate, input);
}

export function prepareMembershipUpdate(
  input: OrganizationMembershipUpdateInput,
): OrganizationMembershipUpdateInput {
  return parse(membershipUpdate, input);
}

export function prepareInvitationCreate(
  input: OrganizationInvitationCreateInput,
  now: Date,
): OrganizationInvitationCreateValues {
  if (!Number.isFinite(now.getTime())) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  const values = parse(invitationCreate, input);
  return {
    ...values,
    expiresAt: new Date(now.getTime() + INVITATION_LIFETIME_MS),
  };
}
