import { z } from "zod";
import { StandardError } from "@bakery/contracts/http";

export type ProfileUpdateInput = {
  name?: string;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  image?: string | null;
};

export type ProfileUpdateValues = {
  name?: string;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  image?: string | null;
};

const MAX_IMAGE_LENGTH = 2048;

function codePoints(value: string): number {
  return Array.from(value).length;
}

function optionalText(max: number, label: string) {
  return z.string().nullable().optional().transform((value) => {
    if (value === undefined) return undefined;
    const trimmed = value?.trim() ?? "";
    return trimmed.length === 0 ? null : trimmed;
  }).refine(
    (value) =>
      value === undefined || value === null ||
      codePoints(value) <= max,
    `${label} is too long`,
  ).describe(
    `Optional ${label}; blank or null clears it and omission leaves it unchanged.`,
  );
}

/** True for a bounded absolute HTTPS URL without whitespace or credentials. */
export function isAcceptableProfileImage(value: string): boolean {
  if (value.length > MAX_IMAGE_LENGTH || /\s/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.username === "" &&
    url.password === "" && url.hostname.length > 0;
}

const profileUpdate = z.object({
  name: z.string().optional().transform((value) => value?.trim()).refine(
    (value) =>
      value === undefined || (value.length > 0 && codePoints(value) <= 200),
    "name must be 1 to 200 characters",
  ).describe("Display name; trimmed, 1 to 200 characters."),
  firstName: optionalText(100, "first name"),
  lastName: optionalText(100, "last name"),
  title: optionalText(120, "job title"),
  image: z.string().nullable().optional().transform((value) => {
    if (value === undefined) return undefined;
    const trimmed = value?.trim() ?? "";
    return trimmed.length === 0 ? null : trimmed;
  }).refine(
    (value) =>
      value === undefined || value === null || isAcceptableProfileImage(value),
    "image must be an absolute HTTPS URL without credentials",
  ).describe("Profile image URL; absolute HTTPS without credentials."),
}).describe("Normalized profile update values.");

/**
 * Domain rules over the already shape-checked transport input: trimming,
 * blank-to-null, name and URL bounds, and the requirement that at least one
 * field changes. Omitted fields stay omitted so they are left untouched.
 */
export function prepareProfileUpdate(
  input: ProfileUpdateInput,
): ProfileUpdateValues {
  const parsed = profileUpdate.safeParse(input);
  if (!parsed.success) throw new StandardError({ code: "UNPROCESSABLE" });
  const values = Object.fromEntries(
    Object.entries(parsed.data).filter(([, value]) => value !== undefined),
  ) as ProfileUpdateValues;
  if (Object.keys(values).length === 0) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  return values;
}
