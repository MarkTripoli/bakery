import type { Context } from "hono";
import { StandardError } from "@bakery/contracts/http";
import { bundleFiles } from "../catalog/plugin-pages.ts";
import { blobObjectKey, SkillFileStoreError } from "../catalog/storage-port.ts";
import { TarArchiveError } from "../catalog/tar-archive.ts";
import { jsonResponse } from "./http.ts";
import { authorizePluginAttempt } from "./plugin-attempt.ts";
import type { ExecutionRouteOptions } from "./shared.ts";

/**
 * `GET /v1/worker/attempts/{id}/plugin-job-files` (#29, B14.02).
 *
 * Hands a contained job its code: the files of the bundle of the version the
 * job was admitted with, for the install the job names. That version must be a
 * published version of the install's own package. The worker proves the lease and fence as for
 * the broker relay. The bundle is read from the store by its recorded digest
 * and parsed by the server's own archive reader, so the worker writes plain
 * files and never unpacks an archive. A disabled install, or one without the
 * `jobs.schedule` grant, is refused: a job never starts on authority that is
 * already gone.
 */

/** Most files and bytes one job's code may be. */
export const PLUGIN_JOB_MAX_FILES = 256;
export const PLUGIN_JOB_MAX_BYTES = 8 * 1024 * 1024;
const JOBS_GRANT = "jobs.schedule";

type InstallRow = {
  status: string;
  /** Null when the named version is not a published version of the install's package. */
  bundle_object_ref: string | null;
  bundle_digest: string | null;
  granted: boolean;
};

function toBase64(bytes: Uint8Array): string {
  let text = "";
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) {
    text += String.fromCharCode(...bytes.subarray(at, at + chunk));
  }
  return btoa(text);
}

export async function pluginJobFilesRoute(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const bundles = options.pluginBundles;
  if (bundles === undefined) {
    throw new StandardError({
      code: "DEPENDENCY_UNAVAILABLE",
      params: { reason: "plugin_bundle_storage_unavailable" },
    });
  }
  const attempt = await authorizePluginAttempt(context, options);
  const refusal = (reason: string) =>
    new StandardError({ code: "STATE_CONFLICT", params: { reason } });

  const found = await options.database.query<InstallRow>(
    `select i.status, v.bundle_object_ref, v.bundle_digest,
            exists (
              select 1 from bakery.plugin_install_grants g
               where g.organization_id = i.organization_id
                 and g.plugin_install_id = i.id
                 and g.capability = $3
            ) as granted
       from bakery.plugin_installs i
       left join bakery.plugin_versions v
         on v.organization_id = i.organization_id
        and v.id = $4::uuid
        and v.plugin_package_id = i.plugin_package_id
        and v.published_at is not null
      where i.organization_id = $1 and i.id = $2`,
    [attempt.organizationId, attempt.installId, JOBS_GRANT, attempt.versionId],
  );
  const row = found.rows[0];
  if (row === undefined || row.status === "uninstalled") {
    throw refusal("plugin_install_gone");
  }
  if (row.status !== "enabled") throw refusal("plugin_install_off");
  if (!row.granted) throw refusal("plugin_job_not_granted");
  if (attempt.entry === null) throw refusal("plugin_job_entry_missing");
  if (row.bundle_object_ref === null || row.bundle_digest === null) {
    throw refusal("plugin_job_version_not_in_package");
  }
  const bundleDigest = row.bundle_digest;
  // The stored ref is recomputed rather than trusted, as at publication.
  if (
    row.bundle_object_ref !==
      blobObjectKey(attempt.organizationId, bundleDigest)
  ) throw refusal("plugin_bundle_missing");

  let files: Map<string, Uint8Array>;
  try {
    const stat = await bundles.stat(attempt.organizationId, bundleDigest);
    if (stat === null) throw refusal("plugin_bundle_missing");
    files = await bundleFiles(
      await bundles.read(
        attempt.organizationId,
        bundleDigest,
        stat.sizeBytes,
      ),
    );
  } catch (error) {
    if (error instanceof SkillFileStoreError) {
      throw refusal("plugin_bundle_missing");
    }
    // An archive the server's own reader refuses, for example one past its
    // file or size limits, is a bundle no job can run from.
    if (error instanceof TarArchiveError) {
      throw refusal("plugin_bundle_unreadable");
    }
    throw error;
  }
  if (!files.has(attempt.entry)) throw refusal("plugin_job_entry_missing");
  let total = 0;
  for (const content of files.values()) total += content.byteLength;
  if (files.size > PLUGIN_JOB_MAX_FILES || total > PLUGIN_JOB_MAX_BYTES) {
    throw refusal("plugin_bundle_too_large");
  }
  return jsonResponse({
    bundleDigest,
    entry: attempt.entry,
    files: [...files].map(([path, content]) => ({
      path,
      contentBase64: toBase64(content),
    })),
  }, 200);
}
