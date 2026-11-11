import { assert, assertEquals, assertThrows } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import {
  assertCompilerPinTogether,
  compilerPinOf,
} from "../../apps/server/src/modules/workflows/validation.ts";

// The pin columns on workflow_versions are set together or not at all. A CHECK
// would enforce that in the database, but the PostgreSQL responsibility
// boundary rail forbids CHECK constraints, so the write path enforces it.

const VERSION = "1";
const DIGEST = "a".repeat(64);

function refusal(
  compilerVersion: string | null,
  semanticDigest: string | null,
) {
  return assertThrows(
    () => assertCompilerPinTogether(compilerVersion, semanticDigest),
    StandardError,
  );
}

Deno.test("a pin with both columns set is accepted", () => {
  assertCompilerPinTogether(VERSION, DIGEST);
});

Deno.test("an unpinned version with both columns null is accepted", () => {
  assertCompilerPinTogether(null, null);
});

Deno.test("only the compiler version set is a typed internal refusal", () => {
  assertEquals(refusal(VERSION, null).code, "INTERNAL");
});

Deno.test("only the semantic digest set is a typed internal refusal", () => {
  assertEquals(refusal(null, DIGEST).code, "INTERNAL");
});

Deno.test("the refusal never carries the values it rejected", () => {
  const secret = "SECRET-DIGEST-VALUE-0123456789";
  for (const error of [refusal(VERSION, null), refusal(null, secret)]) {
    assertEquals(error.params, undefined);
    assert(!error.message.includes(secret), error.message);
    assert(!JSON.stringify(error).includes(secret));
  }
});

Deno.test("an empty string is a value, not null, so a half pin cannot hide behind it", () => {
  assertEquals(refusal("", null).code, "INTERNAL");
  assertEquals(refusal(null, "").code, "INTERNAL");
  assertCompilerPinTogether("", "");
});

Deno.test("every pin the compiler produces passes the guard", () => {
  const pin = compilerPinOf({
    compilerVersion: VERSION,
    semanticDigest: DIGEST,
  });
  assert(pin !== null);
  assertCompilerPinTogether(pin.compilerVersion, pin.semanticDigest);
  const none = compilerPinOf({
    compilerVersion: VERSION,
    semanticDigest: null,
  });
  assertEquals(none, null);
  assertCompilerPinTogether(
    none?.compilerVersion ?? null,
    none?.semanticDigest ?? null,
  );
});
