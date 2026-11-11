import { createTrustedRepositoryResolver } from "../src/modules/knowledge/import.ts";

async function trustedRepositoryReadPermissions(): Promise<string> {
  const encoded = Deno.env.get("BAKERY_TRUSTED_REPOSITORIES_JSON");
  if (encoded === undefined) return "";
  if (new TextEncoder().encode(encoded).byteLength > 64 * 1024) {
    throw new Error("TRUSTED_REPOSITORY_READ_PERMISSION_INVALID");
  }
  const config: unknown = JSON.parse(encoded);
  if (
    config === null || typeof config !== "object" || Array.isArray(config) ||
    !("schemaVersion" in config) || config.schemaVersion !== 1 ||
    !("entries" in config) || !Array.isArray(config.entries)
  ) throw new Error("TRUSTED_REPOSITORY_READ_PERMISSION_INVALID");

  // The existing resolver owns mapping validation and digest authority. This
  // helper only narrows its active paths to values safe in a Deno permission list.
  const resolver = createTrustedRepositoryResolver(config);
  const paths = new Set<string>();
  for (const entry of config.entries) {
    if (
      entry === null || typeof entry !== "object" || Array.isArray(entry) ||
      (entry.status !== "active" && entry.status !== "revoked")
    ) throw new Error("TRUSTED_REPOSITORY_READ_PERMISSION_INVALID");
    if (entry.status === "revoked") continue;
    const source = await resolver.resolve({
      organizationId: entry.organizationId,
      applicationId: entry.applicationId,
      repositoryUuid: entry.repositoryUuid,
    });
    const path = source.bareRepositoryPath;
    if (
      !path.startsWith("/") || path === "/" || path.includes(",") ||
      [...path].some((character) =>
        character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127
      )
    ) throw new Error("TRUSTED_REPOSITORY_READ_PERMISSION_INVALID");
    paths.add(path);
  }
  return [...paths].sort().join(",");
}

try {
  const permissions = await trustedRepositoryReadPermissions();
  if (permissions) console.log(permissions);
} catch {
  console.error("TRUSTED_REPOSITORY_READ_PERMISSION_INVALID");
  Deno.exit(1);
}
