import { StandardError } from "@bakery/contracts/http";

/** Reject echoes before storage; never replace a verified identity or log input. */
export function rejectCredentialMetadata(
  value: string,
  credential?: string,
): void {
  if (/bearer|authorization|gh[pousr]_|github_pat_|token[=:]/i.test(value)) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
  if (!credential) return;
  const bytes = new TextEncoder().encode(credential);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const variants = [
    credential,
    encodeURIComponent(credential),
    btoa(binary),
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  ];
  if (
    variants.some((candidate) =>
      candidate && value.toLowerCase().includes(candidate.toLowerCase())
    )
  ) {
    throw new StandardError({ code: "UNPROCESSABLE" });
  }
}

/** Checks only the enumerated metadata object's string values, never plaintext itself. */
export function rejectCredentialMetadataFields(
  fields: Record<string, unknown>,
  credential: string,
): void {
  for (const value of Object.values(fields)) {
    if (typeof value === "string") rejectCredentialMetadata(value, credential);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          rejectCredentialMetadata(item, credential);
        }
      }
    }
  }
}
