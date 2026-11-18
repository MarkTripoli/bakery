import type { PgDatabase } from "../../platform/database.ts";
import type { SecretsKeyConfig } from "@bakery/config";
import {
  decryptInstallationSecret,
  loadSecretKey,
  SecretCipherSchema,
} from "../secrets/crypto.ts";

/**
 * Reads a destination's signing secret (#21).
 *
 * The destination stores a reference to a secret version, never the material, so
 * the worker opens it here at send time. A secret that cannot be opened answers
 * null rather than throwing: the dispatch path treats a missing secret as a
 * terminal signing failure, which is the honest outcome - the export cannot be
 * signed, so it must not be sent.
 */
export function createDestinationSecretReader(
  database: PgDatabase,
  secretsKey: SecretsKeyConfig | undefined,
): (secretVersionId: string) => Promise<string> {
  return async (secretVersionId) => {
    const result = await database.query<{
      secret_id: string;
      revision: number;
      key_id: string;
      ciphertext: string;
      nonce: string;
    }>(
      `select version.secret_id, version.revision, version.key_id,
              version.ciphertext, version.nonce
         from bakery.secret_versions as version
        where version.id = $1`,
      [secretVersionId],
    );
    const row = result.rows[0];
    if (row === undefined) return "";
    try {
      const opened = await decryptInstallationSecret(
        await loadSecretKey(secretsKey),
        {
          secretId: row.secret_id,
          revision: row.revision,
          keyId: row.key_id,
        },
        SecretCipherSchema.parse({
          ciphertext: row.ciphertext,
          nonce: row.nonce,
        }),
      );
      return new TextDecoder().decode(opened);
    } catch {
      return "";
    }
  };
}
