import { z } from "zod";

/** Provider permission levels a host profile can offer for one permission name. */
export type ProfilePermissionLevel = "read" | "write";

/** One resource kind a host profile can bind: a strict binding shape and the attributes an action may project. */
export type HostResourceKind = Readonly<{
  bindingSchema: z.ZodObject;
  projectable: readonly string[];
  /** Binding attributes whose decimal values identify the provider account and resource in the effect ledger. */
  externalIdentity: Readonly<{ account: string; resource: string }>;
}>;

/** Host-owned authentication profile. Server code only; manifests name the id and nothing else. */
export type HostAuthProfile = Readonly<{
  id: string;
  origin: string;
  credentialPlacement: "authorization-bearer";
  fixedHeaders: Readonly<Record<string, string>>;
  providerPermissions: Readonly<
    Record<string, readonly ProfilePermissionLevel[]>
  >;
  resourceKinds: Readonly<Record<string, HostResourceKind>>;
}>;

const segment = (description: string) =>
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/).refine(
    (value) => !/^\.+$/.test(value),
    "dot-only segments are not allowed",
  ).describe(description);

const githubRepositoryBinding = z.strictObject({
  owner: segment(
    "GitHub account login that owns the repository; a single safe path segment with no slash or dot traversal.",
  ),
  repo: segment(
    "GitHub repository name inside the owner account; a single safe path segment with no slash or dot traversal.",
  ),
  repositoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    .describe(
      "Numeric GitHub repository identifier recorded when the repository was selected.",
    ),
  installationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    .describe(
      "Numeric GitHub App installation identifier the host uses to mint credentials; never exposed to integrations.",
    ),
  botUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(
    "Numeric GitHub user identifier of the installation bot, used to prove authorship during recovery.",
  ),
}).describe(
  "Host-recorded binding of one selected GitHub repository: names, numeric identifiers and the installation bot.",
);

const githubApp: HostAuthProfile = Object.freeze({
  id: "github-app",
  origin: "https://api.github.com",
  credentialPlacement: "authorization-bearer",
  fixedHeaders: Object.freeze({
    "x-github-api-version": "2026-03-10",
    accept: "application/vnd.github+json",
  }),
  providerPermissions: Object.freeze({
    issues: Object.freeze(["read", "write"] as const),
    metadata: Object.freeze(["read"] as const),
  }),
  resourceKinds: Object.freeze({
    "github.repository": Object.freeze({
      bindingSchema: githubRepositoryBinding,
      projectable: Object.freeze(["botUserId"]),
      externalIdentity: Object.freeze({
        account: "installationId",
        resource: "repositoryId",
      }),
    }),
  }),
});

/** Frozen registry of host authentication profiles; the only source of origins and credential placement. */
export const HOST_AUTH_PROFILES: Readonly<Record<string, HostAuthProfile>> =
  Object.freeze({ "github-app": githubApp });

/** Returns the host profile for an id, or undefined. Own-property lookup only. */
export function getHostProfile(id: string): HostAuthProfile | undefined {
  return Object.hasOwn(HOST_AUTH_PROFILES, id)
    ? HOST_AUTH_PROFILES[id]
    : undefined;
}

/** Throws unless the profile origin is a bare https origin: no userinfo, root path, query or hash. */
export function assertHostProfile(profile: HostAuthProfile): void {
  let url: URL;
  try {
    url = new URL(profile.origin);
  } catch {
    throw new Error(`host profile ${profile.id}: origin is not a URL`);
  }
  const bad = url.protocol !== "https:" || url.username !== "" ||
    url.password !== "" || url.pathname !== "/" || url.search !== "" ||
    url.hash !== "" || profile.origin !== url.origin;
  if (bad) {
    throw new Error(
      `host profile ${profile.id}: origin must be a bare https origin`,
    );
  }
  if (profile.credentialPlacement !== "authorization-bearer") {
    throw new Error(
      `host profile ${profile.id}: unsupported credential placement`,
    );
  }
  for (const [kindName, kind] of Object.entries(profile.resourceKinds)) {
    const { account, resource } = kind.externalIdentity;
    if (account === resource) {
      throw new Error(
        `host profile ${profile.id}: resource kind ${kindName} external identity needs two distinct attributes`,
      );
    }
    for (const attribute of [account, resource]) {
      const field = Object.hasOwn(kind.bindingSchema.shape, attribute)
        ? kind.bindingSchema.shape[attribute]
        : undefined;
      if (!(field instanceof z.ZodNumber) && !(field instanceof z.ZodString)) {
        throw new Error(
          `host profile ${profile.id}: resource kind ${kindName} external identity ${attribute} must be a string or number binding attribute`,
        );
      }
    }
  }
  for (const name of Object.keys(profile.fixedHeaders)) {
    if (/^(authorization|cookie|host)$/i.test(name)) {
      throw new Error(
        `host profile ${profile.id}: fixed header ${name} is reserved`,
      );
    }
  }
}
