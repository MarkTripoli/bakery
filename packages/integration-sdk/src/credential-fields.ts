import { z } from "zod";

/**
 * A credential field the host renders (chapter 09 section 12.2).
 *
 * Declared by the provider's manifest as data, so the connect form is generated
 * and no provider ships UI code for it. The closed `format` is the point: a
 * free-form format string would push validation into each provider's own
 * component, and two providers would then validate the same thing two ways.
 */
export const CredentialFieldSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64).describe(
    "Stable field id, used as the form field name and the secret slot key.",
  ),
  labelKey: z.string().min(1).max(200).describe(
    "i18n key for the field label; never a raw English string.",
  ),
  secret: z.boolean().describe(
    "Whether the value is a secret the host stores encrypted and never echoes back.",
  ),
  format: z.enum(["text", "email", "https-origin"]).describe(
    "The only shapes a credential may take, so validation is shared rather than per provider.",
  ),
}).describe(
  "One field a person fills in to connect; declared as data so the form needs no provider code.",
);

export type CredentialField = z.infer<typeof CredentialFieldSchema>;

/**
 * Whether a value satisfies a field's format.
 *
 * Shared by the connect form and the server, because a check that exists on only
 * one side is a check a caller can skip. `https-origin` is the one that matters:
 * an origin is what the host later binds every request to, so a non-https or
 * path-bearing value would break the allowlist assumption.
 */
export function credentialFieldAccepts(
  field: CredentialField,
  value: string,
): boolean {
  switch (field.format) {
    case "text":
      return value.trim().length > 0;
    case "email":
      // Deliberately shallow: the authority on whether an address exists is the
      // provider, and a stricter pattern would reject valid addresses.
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
    case "https-origin": {
      let parsed: URL;
      try {
        parsed = new URL(value.trim());
      } catch {
        return false;
      }
      // An origin, not a URL: a path or query here would mean the caller controls
      // part of the request target, which is exactly what the host binds.
      return parsed.protocol === "https:" && parsed.pathname === "/" &&
        parsed.search === "" && parsed.hash === "" &&
        parsed.username === "" && parsed.password === "";
    }
  }
}

/** Field ids that appear more than once describe one slot twice. */
export function credentialFieldDefects(
  fields: readonly CredentialField[],
): string[] {
  const seen = new Set<string>();
  const defects: string[] = [];
  for (const field of fields) {
    if (seen.has(field.id)) {
      defects.push(`The credential field ${field.id} is declared twice.`);
    }
    seen.add(field.id);
  }
  return defects;
}
