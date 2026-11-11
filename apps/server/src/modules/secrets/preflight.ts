import { z } from "zod";
import {
  type ActionAuthorityRunner,
  type ActionContext,
  validateEncodedSuccessResponse,
} from "@bakery/contracts/action-registry";
import { contractSchemas } from "@bakery/contracts/contracts";
import { SecretsImplementedAction } from "@bakery/contracts/implemented-actions";
import {
  createNormalizedCommandMetadata,
  requireCommandMetadata,
  StandardError,
} from "@bakery/contracts/http";
import { type SecretsKeyConfig } from "@bakery/config";
import {
  commandFingerprint,
  readCompletedCommandReplay,
} from "../../platform/command-replay.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  VerifiedGitHubIdentitySchema,
  verifyGitHubCredential,
} from "./broker.ts";
import {
  encryptSecret,
  loadSecretKey,
  SecretCipherBindingSchema,
  SecretCipherSchema,
} from "./crypto.ts";
import { assertSecretApplication } from "./postgres.ts";
import { rejectCredentialMetadataFields } from "./redaction.ts";

const preparationSlot = Symbol("private secret preparation");
const SecretPreparationSchema = SecretCipherBindingSchema.extend({
  principalId: z.string().uuid().describe(
    "Live principal whose normalized request produced this preparation.",
  ),
  operation: z.union([
    z.literal(SecretsImplementedAction.Create).describe(
      "Initial encrypted project credential creation operation.",
    ),
    z.literal(SecretsImplementedAction.Rotate).describe(
      "Encrypted project credential rotation operation.",
    ),
  ]).describe("Admitted secret mutation operation."),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).describe(
    "Original normalized command digest; never transported or logged.",
  ),
  versionId: z.string().uuid().describe(
    "Prospective first encrypted version identifier.",
  ),
  expires: z.number().int().positive().describe(
    "Request-private preparation expiry in Unix milliseconds; 30-second TTL.",
  ),
  identity: VerifiedGitHubIdentitySchema.describe(
    "Selected fixed-provider verification identity, no raw provider data.",
  ),
  cipher: SecretCipherSchema.describe(
    "Private storage-only authenticated encryption result.",
  ),
}).strict().describe(
  "Request-local immutable first-version preparation; never an input, authority grant or replay payload.",
);
type SecretPreparation = z.infer<typeof SecretPreparationSchema>;
type PreparedContext = ActionContext & {
  [preparationSlot]?: SecretPreparation;
};

export function createSecretsAuthorityRunner(
  authority: ActionAuthorityRunner,
  config?: SecretsKeyConfig,
  fetcher: typeof fetch = fetch,
): ActionAuthorityRunner {
  return {
    async run(action, context, input, next) {
      if (action.name === SecretsImplementedAction.Revoke) {
        const parsed = contractSchemas.SecretRevoke.parse(input);
        return await authority.run(
          action,
          context,
          parsed,
          async (authorized) => {
            await assertSecretApplication(authorized, parsed.applicationId);
            const metadata = createNormalizedCommandMetadata(
              action,
              context.request,
              context.params,
              parsed,
            );
            if (metadata.expectedVersion === undefined) {
              throw new StandardError({ code: "PRECONDITION_REQUIRED" });
            }
            return await next(authorized);
          },
        );
      }
      if (action.name === SecretsImplementedAction.UpdatePolicy) {
        const parsed = contractSchemas.SecretPolicyUpdate.parse(input);
        return await authority.run(
          action,
          context,
          parsed,
          async (authorized) => {
            await assertSecretApplication(authorized, parsed.applicationId);
            const metadata = createNormalizedCommandMetadata(
              action,
              context.request,
              context.params,
              parsed,
            );
            if (metadata.expectedVersion === undefined) {
              throw new StandardError({ code: "PRECONDITION_REQUIRED" });
            }
            return next(authorized);
          },
        );
      }
      if (action.name === SecretsImplementedAction.Rotate) {
        const parsed = contractSchemas.SecretRotation.parse(input);
        const metadata = createNormalizedCommandMetadata(
          action,
          context.request,
          context.params,
          parsed,
        );
        const probe = await authority.run(
          action,
          context,
          parsed,
          async (authorized) => {
            const { transaction, organizationId, principalId } =
              requireWorkTransaction(authorized);
            await assertSecretApplication(authorized, parsed.applicationId);
            const replay = await readCompletedCommandReplay({
              context: authorized,
              metadata,
              input: parsed,
            });
            if (replay) {
              const envelope = validateEncodedSuccessResponse(action, replay);
              const output = contractSchemas.SecretMetadata.parse(
                JSON.parse(new TextDecoder().decode(envelope.body)),
              );
              if (output.applicationId !== parsed.applicationId) {
                throw new StandardError({ code: "INTERNAL" });
              }
              try {
                rejectCredentialMetadataFields(output, parsed.value);
              } catch {
                throw new StandardError({ code: "INTERNAL" });
              }
              return { replay: envelope };
            }
            const current = await transaction.query<{
              active_version_revision: number;
              revoked_at: string | null;
              provider: string;
              name: string;
              verified_login: string | null;
            }>(
              `select active_version_revision,revoked_at,provider,name,verified_login from bakery.secrets where organization_id=$1 and application_id=$2 and id=$3`,
              [organizationId, parsed.applicationId, context.params.id],
            );
            const row = current.rows[0];
            if (!row || row.revoked_at !== null || row.provider !== "github") {
              throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
            }
            rejectCredentialMetadataFields(
              { name: row.name, verifiedLogin: row.verified_login },
              parsed.value,
            );
            return {
              organizationId,
              principalId,
              secretId: context.params.id!,
              revision: row.active_version_revision + 1,
            };
          },
        ) as {
          replay?: ReturnType<typeof validateEncodedSuccessResponse>;
          organizationId: string;
          principalId: string;
          secretId: string;
          revision: number;
        };
        if (probe.replay) return probe.replay;
        rejectCredentialMetadataFields(
          { expiresAt: parsed.expiresAt },
          parsed.value,
        );
        context.signal.throwIfAborted();
        const key = await loadSecretKey(config);
        const identity = await verifyGitHubCredential(
          parsed.value,
          context.signal,
          fetcher,
        );
        const binding = {
          organizationId: probe.organizationId,
          applicationId: parsed.applicationId,
          secretId: probe.secretId,
          revision: probe.revision,
          keyId: config!.keyId,
        };
        const cipher = await encryptSecret(key, binding, parsed.value);
        context.signal.throwIfAborted();
        const preparation = SecretPreparationSchema.parse({
          ...binding,
          principalId: probe.principalId,
          operation: SecretsImplementedAction.Rotate,
          fingerprint: await commandFingerprint({ metadata, input: parsed }),
          versionId: crypto.randomUUID(),
          expires: Date.now() + 30000,
          identity,
          cipher,
        });
        try {
          return await authority.run(
            action,
            context,
            parsed,
            async (authorized) => {
              await assertSecretApplication(authorized, parsed.applicationId);
              return next(
                Object.assign({}, authorized, {
                  [preparationSlot]: preparation,
                }),
              );
            },
          );
        } finally {
          cipher.ciphertext.fill(0);
          cipher.nonce.fill(0);
        }
      }
      if (action.name !== SecretsImplementedAction.Create) {
        return authority.run(action, context, input, next);
      }
      const parsed = contractSchemas.SecretCreate.parse(input);
      const metadata = createNormalizedCommandMetadata(
        action,
        context.request,
        context.params,
        parsed,
      );
      const probe = await authority.run(
        action,
        context,
        parsed,
        async (authorized) => {
          await assertSecretApplication(authorized, parsed.applicationId);
          const replay = await readCompletedCommandReplay({
            context: authorized,
            metadata,
            input: parsed,
          });
          if (replay) {
            const envelope = validateEncodedSuccessResponse(action, replay);
            const output = contractSchemas.SecretMetadata.parse(
              JSON.parse(new TextDecoder().decode(envelope.body)),
            );
            if (output.applicationId !== parsed.applicationId) {
              throw new StandardError({ code: "INTERNAL" });
            }
            try {
              rejectCredentialMetadataFields(output, parsed.value);
            } catch {
              throw new StandardError({ code: "INTERNAL" });
            }
            return { replay: envelope };
          }
          const { organizationId, principalId } = requireWorkTransaction(
            authorized,
          );
          return { organizationId, principalId };
        },
      ) as {
        replay?: ReturnType<typeof validateEncodedSuccessResponse>;
        organizationId: string;
        principalId: string;
      };
      if (probe.replay) return probe.replay;
      const { value, ...safeInput } = parsed;
      rejectCredentialMetadataFields(safeInput, value);
      context.signal.throwIfAborted();
      const key = await loadSecretKey(config);
      const identity = await verifyGitHubCredential(
        parsed.value,
        context.signal,
        fetcher,
      );
      const binding = {
        organizationId: probe.organizationId,
        applicationId: parsed.applicationId,
        secretId: crypto.randomUUID(),
        revision: 1,
        keyId: config!.keyId,
      };
      const cipher = await encryptSecret(key, binding, parsed.value);
      context.signal.throwIfAborted();
      const preparation = SecretPreparationSchema.parse({
        ...binding,
        principalId: probe.principalId,
        operation: SecretsImplementedAction.Create,
        fingerprint: await commandFingerprint({ metadata, input: parsed }),
        versionId: crypto.randomUUID(),
        expires: Date.now() + 30000,
        identity,
        cipher,
      });
      try {
        return await authority.run(
          action,
          context,
          parsed,
          async (authorized) => {
            await assertSecretApplication(authorized, parsed.applicationId);
            return await next(
              Object.assign({}, authorized, { [preparationSlot]: preparation }),
            );
          },
        );
      } finally {
        cipher.ciphertext.fill(0);
        cipher.nonce.fill(0);
      }
    },
  };
}

export async function requireSecretRotationPreparation(
  context: ActionContext,
  input: z.output<typeof contractSchemas.SecretRotation>,
): Promise<SecretPreparation> {
  const result = SecretPreparationSchema.safeParse(
    (context as PreparedContext)[preparationSlot],
  );
  if (!result.success) throw new StandardError({ code: "AUTH_FORBIDDEN" });
  const prepared = result.data;
  const { organizationId, principalId } = requireWorkTransaction(context);
  const metadata = requireCommandMetadata(context);
  if (
    prepared.expires <= Date.now() ||
    prepared.operation !== SecretsImplementedAction.Rotate ||
    prepared.organizationId !== organizationId ||
    prepared.principalId !== principalId ||
    prepared.applicationId !== input.applicationId ||
    prepared.secretId !== context.params.id ||
    prepared.revision < 2 ||
    prepared.identity.provider !== "github" ||
    prepared.fingerprint !== await commandFingerprint({ metadata, input })
  ) throw new StandardError({ code: "AUTH_FORBIDDEN" });
  return prepared;
}

export async function requireSecretPreparation(
  context: ActionContext,
  input: z.output<typeof contractSchemas.SecretCreate>,
): Promise<SecretPreparation> {
  const result = SecretPreparationSchema.safeParse(
    (context as PreparedContext)[preparationSlot],
  );
  if (!result.success) throw new StandardError({ code: "AUTH_FORBIDDEN" });
  const prepared = result.data;
  const { organizationId, principalId } = requireWorkTransaction(context);
  const metadata = requireCommandMetadata(context);
  if (
    prepared.expires <= Date.now() ||
    prepared.organizationId !== organizationId ||
    prepared.principalId !== principalId ||
    prepared.applicationId !== input.applicationId ||
    prepared.operation !== metadata.operation || prepared.revision !== 1 ||
    prepared.identity.provider !== input.provider ||
    prepared.fingerprint !== await commandFingerprint({ metadata, input })
  ) {
    throw new StandardError({ code: "AUTH_FORBIDDEN" });
  }
  return prepared;
}
