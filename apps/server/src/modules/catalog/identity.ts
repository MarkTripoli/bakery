const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function requireCanonicalUuid(value: string, field: string): string {
  if (value !== value.toLowerCase() || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a canonical lowercase UUID`);
  }
  return value;
}

function requireDigest(value: string): string {
  if (!SHA256_PATTERN.test(value)) throw new TypeError("digest is not SHA-256");
  return value;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

/** Derives the immutable UUIDv8 identity for a local skill revision. */
export async function deriveSkillVersionId(options: {
  organizationId: string;
  skillId: string;
  revision: number;
  digest: string;
}): Promise<string> {
  const organizationId = requireCanonicalUuid(
    options.organizationId,
    "organizationId",
  );
  const skillId = requireCanonicalUuid(options.skillId, "skillId");
  if (!Number.isSafeInteger(options.revision) || options.revision < 1) {
    throw new TypeError("revision must be a positive safe integer");
  }
  const digest = requireDigest(options.digest);
  const framed = new TextEncoder().encode(
    `bakery.skill-version\0${organizationId}\0${skillId}\0${options.revision}\0${digest}`,
  );
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", framed));
  hash[6] = (hash[6] & 0x0f) | 0x80;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return bytesToUuid(hash.slice(0, 16));
}

/** Returns the only object name accepted by the skill file store. */
export function skillObjectKey(
  organizationId: string,
  versionId: string,
  fileSha256: string,
): string {
  return `organizations/${
    requireCanonicalUuid(organizationId, "organizationId")
  }/skill-versions/${requireCanonicalUuid(versionId, "versionId")}/sha256/${
    requireDigest(fileSha256)
  }`;
}

/** Derives all retry-stable identities before touching the filesystem. */
export async function deriveSkillPublicationIdentity(options: {
  organizationId: string;
  skillId: string;
  revision: number;
  digest: string;
  fileDigests: readonly string[];
}): Promise<{ versionId: string; objectKeys: readonly string[] }> {
  const versionId = await deriveSkillVersionId(options);
  return {
    versionId,
    objectKeys: options.fileDigests.map((digest) =>
      skillObjectKey(options.organizationId, versionId, digest)
    ),
  };
}
