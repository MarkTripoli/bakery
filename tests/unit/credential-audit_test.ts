import { assertEquals } from "@std/assert";
import {
  CREDENTIAL_AUDIT_OPERATIONS,
  PASSWORD_CHANGE_OPERATION,
} from "../../apps/server/src/modules/auth/adapters/credential-audit.ts";
import { AUDIT_MATRIX_CREDENTIAL_OPERATIONS } from "../helpers/audit-matrix-actions.ts";

Deno.test("credential audit operations match the audit matrix, passkeys included", () => {
  assertEquals(
    [...Object.values(CREDENTIAL_AUDIT_OPERATIONS), PASSWORD_CHANGE_OPERATION]
      .sort(),
    [...AUDIT_MATRIX_CREDENTIAL_OPERATIONS].sort(),
  );
  assertEquals(
    Object.keys(CREDENTIAL_AUDIT_OPERATIONS).filter((path) =>
      path.startsWith("/passkey/")
    ).sort(),
    [
      "/passkey/delete-passkey",
      "/passkey/update-passkey",
      "/passkey/verify-registration",
    ],
  );
});
