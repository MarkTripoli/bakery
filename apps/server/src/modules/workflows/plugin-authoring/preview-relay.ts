import {
  assertPluginNamespace,
  assertPluginStateKey,
  PluginManifestError,
} from "@bakery/contracts/plugin-sdk";
import type { PgTransactionClient } from "../../../platform/database.ts";
import { issueStateCasVersion } from "../../catalog/plugin-install-upgrade.ts";

/**
 * The host side of a preview job's two operations (#45, B14.04).
 *
 * A previewed job asks for state.read and state.write exactly as a scheduled
 * one asks the broker, and gets the same answers: the install's grants are read
 * fresh on every call, the namespace must be one the version declares, and a
 * write is compare-and-set on the key's cas version. It runs in the authoring
 * request's transaction, so what a failed preview wrote is rolled back with it.
 */

export type PreviewCall = Readonly<{
  operation: string;
  args: Readonly<Record<string, unknown>>;
}>;

export type PreviewCallAnswer =
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{ ok: false; denial: string }>;

export type PreviewRelay = (call: PreviewCall) => Promise<PreviewCallAnswer>;

const deny = (denial: string): PreviewCallAnswer => ({ ok: false, denial });

export function createPreviewRelay(
  transaction: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    installId: string;
    stateNamespaces: readonly string[];
  }>,
): PreviewRelay {
  return async ({ operation, args }) => {
    const install = await transaction.query<{
      status: string;
      scope: string;
      owner_principal_id: string | null;
      state_schema_version: number;
    }>(
      `select status, scope, owner_principal_id, state_schema_version
         from bakery.plugin_installs
        where organization_id = $1 and id = $2`,
      [input.organizationId, input.installId],
    );
    const row = install.rows[0];
    if (row === undefined || row.status === "uninstalled") {
      return deny("install_gone");
    }
    if (row.status !== "enabled") return deny("install_off");
    const grants = await transaction.query<{ capability: string }>(
      `select capability from bakery.plugin_install_grants
        where organization_id = $1 and plugin_install_id = $2`,
      [input.organizationId, input.installId],
    );
    if (!grants.rows.some((grant) => grant.capability === operation)) {
      return deny("not_granted");
    }
    const { namespace, key } = args;
    if (typeof namespace !== "string" || typeof key !== "string") {
      return deny("request_malformed");
    }
    try {
      assertPluginNamespace(namespace);
      assertPluginStateKey(key);
    } catch (error) {
      if (error instanceof PluginManifestError) {
        return deny("request_malformed");
      }
      throw error;
    }
    if (!input.stateNamespaces.includes(namespace)) {
      return deny("namespace_not_declared");
    }
    const owner = row.scope === "personal" ? row.owner_principal_id : null;
    const current = await transaction.query<
      { cas_version: number; value: unknown }
    >(
      `select cas_version, value from bakery.plugin_state
        where organization_id = $1 and plugin_install_id = $2
          and owner_principal_id is not distinct from $3
          and namespace = $4 and key = $5
        for update`,
      [input.organizationId, input.installId, owner, namespace, key],
    );
    const found = current.rows[0];
    if (operation === "state.read") {
      return {
        ok: true,
        result: found === undefined
          ? { found: false, value: null, casVersion: 0 }
          : { found: true, value: found.value, casVersion: found.cas_version },
      };
    }
    if (operation !== "state.write") return deny("unknown_operation");
    const expected = args.expectedCasVersion;
    if (
      typeof expected !== "number" || !Number.isSafeInteger(expected) ||
      expected < 0 || !("value" in args)
    ) return deny("request_malformed");
    const value = JSON.stringify(args.value ?? null);
    if (new TextEncoder().encode(value).byteLength > 64 * 1024) {
      return deny("request_too_large");
    }
    if ((found?.cas_version ?? 0) !== expected) return deny("cas_conflict");
    // The new number comes from the install's high-water mark (#34), as a
    // state PUT's does, so it is above every number the install has issued
    // for any key, including keys a restore deleted.
    const casVersion = await issueStateCasVersion(
      transaction,
      input.organizationId,
      input.installId,
    );
    if (found === undefined) {
      await transaction.query(
        `insert into bakery.plugin_state
           (organization_id, plugin_install_id, owner_principal_id, namespace,
            key, schema_version, cas_version, value)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          input.organizationId,
          input.installId,
          owner,
          namespace,
          key,
          row.state_schema_version,
          casVersion,
          value,
        ],
      );
      return { ok: true, result: { casVersion } };
    }
    await transaction.query(
      `update bakery.plugin_state
          set value = $6::jsonb, schema_version = $7,
              cas_version = $8, updated_at = now(),
              version = version + 1
        where organization_id = $1 and plugin_install_id = $2
          and owner_principal_id is not distinct from $3
          and namespace = $4 and key = $5`,
      [
        input.organizationId,
        input.installId,
        owner,
        namespace,
        key,
        value,
        row.state_schema_version,
        casVersion,
      ],
    );
    return { ok: true, result: { casVersion } };
  };
}
