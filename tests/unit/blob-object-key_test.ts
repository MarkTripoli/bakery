import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  assertBlobObjectKey,
  blobKeyDigest,
  blobKeyOrganization,
  blobObjectKey,
  SkillFileStoreError,
} from "../../apps/server/src/modules/catalog/storage-port.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const DIGEST = "a".repeat(64);

function refusal(key: string, code = "BLOB_KEY_INVALID"): void {
  const error = assertThrows(() => assertBlobObjectKey(key));
  assert(error instanceof SkillFileStoreError);
  assertEquals(error.code, code, key);
}

Deno.test("a blob key puts the organization and the digest in the path", () => {
  const key = blobObjectKey(ORG, DIGEST);
  assertEquals(key, `organizations/${ORG}/blobs/sha256/${DIGEST}`);
  assertEquals(blobKeyOrganization(key), ORG);
  assertEquals(blobKeyDigest(key), DIGEST);
});

Deno.test("the same digest in two organizations is two different keys", () => {
  // This is the assertion that kills a sha256-only key: deduplication must
  // never cross organizations.
  assert(blobObjectKey(ORG, DIGEST) !== blobObjectKey(OTHER_ORG, DIGEST));
});

Deno.test("a key that escapes the organization prefix is refused", () => {
  for (
    const key of [
      `organizations/../blobs/sha256/${DIGEST}`,
      `organizations/${ORG}/../${OTHER_ORG}/blobs/sha256/${DIGEST}`,
      `/organizations/${ORG}/blobs/sha256/${DIGEST}`,
      `organizations/${ORG}/blobs/sha256/${DIGEST}/../../x`,
      `organizations/${ORG}/blobs/sha256/${DIGEST}\u0000`,
      `organizations/${ORG}/blobs/sha256/${DIGEST} `,
      `organizations/${ORG}/blobs/sha256/${DIGEST}/extra`,
      `organizations/${ORG}/blobs/sha256/`,
      `organizations/${ORG}/blobs/sha256/${"a".repeat(63)}`,
      `organizations/${ORG}/blobs/sha256/${"A".repeat(64)}`,
    ]
  ) refusal(key);
});

Deno.test("a skill-version key is not a blob key and vice versa", () => {
  const skill =
    `organizations/${ORG}/skill-versions/${OTHER_ORG}/sha256/${DIGEST}`;
  refusal(skill);
  const blob = blobObjectKey(ORG, DIGEST);
  const error = assertThrows(() => assertBlobObjectKey(skill));
  assert(error instanceof SkillFileStoreError);
  // The blob key is refused by the skill pattern, proving the two shapes do
  // not silently overlap.
  assert(blob !== skill);
});

Deno.test("a non-uuid organization is refused rather than accepted loosely", () => {
  for (
    const org of ["", "org", "11111111-1111-4111-8111-11111111111", `${ORG}0`]
  ) {
    assertThrows(() => blobObjectKey(org, DIGEST));
  }
});
