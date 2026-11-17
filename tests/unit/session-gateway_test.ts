/**
 * The gateway's own decisions, tested without a database.
 *
 * What is worth testing here is the classification and the mapping, because
 * those are the parts a reviewer cannot check by reading a diff: a wrong outcome
 * still produces an audit row, so it looks like evidence. The transaction and
 * liveness behaviour is proved against a real database in the integration lane.
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  classifySessionFailure,
  sessionPolicyRefusalCodes,
} from "../../apps/server/src/modules/execution/session-gateway.ts";
import { SessionOperationError } from "../../apps/server/src/modules/execution/session-credential.ts";
import { SessionToolError } from "../../apps/server/src/modules/execution/session-tools.ts";

Deno.test("every typed refusal is recorded as a denial, not a shrug", () => {
  // The list is asserted as data rather than described, because "the typed
  // refusals" is how one gets missed - and one was: SESSION_CREDENTIAL_INVALID
  // is raised by resolution rather than by an explicit check, so it is the
  // easiest to overlook and the most security-relevant of the six.
  assertEquals(sessionPolicyRefusalCodes(), [
    "SESSION_CREDENTIAL_EXPIRED",
    "SESSION_CREDENTIAL_FENCE_STALE",
    "SESSION_CREDENTIAL_INVALID",
    "SESSION_SCOPE_DENIED",
    "SESSION_TOOL_DENIED",
    "SESSION_TOOL_UNKNOWN",
  ]);
});

Deno.test("SESSION_TOOL_UNKNOWN is a denial despite its name", () => {
  // The name says unknown and the semantics are the opposite: the operation
  // decided that no such tool exists. An implementer matching on the word would
  // write "unknown" and every reviewer skimming the mapping would nod, so this
  // case exists to make that specific mistake fail loudly.
  assertEquals(
    classifySessionFailure(new SessionToolError("SESSION_TOOL_UNKNOWN", "x")),
    "denied",
  );
});

Deno.test("a credential that does not resolve is a denial", () => {
  assertEquals(
    classifySessionFailure(
      new SessionOperationError("SESSION_CREDENTIAL_INVALID"),
    ),
    "denied",
  );
});

Deno.test("every policy refusal code classifies as denied", () => {
  for (const code of sessionPolicyRefusalCodes()) {
    const error = code.startsWith("SESSION_TOOL_")
      ? new SessionToolError(code as "SESSION_TOOL_UNKNOWN", "x")
      : new SessionOperationError(
        code as "SESSION_CREDENTIAL_INVALID",
      );
    assertEquals(classifySessionFailure(error), "denied", code);
  }
});

Deno.test("an ordinary failure is unknown, never denied", () => {
  // The audit must not claim policy when it was a crash: if "denied" can also
  // mean "the database was down", a reviewer can no longer tell an agent
  // probing its scope from a broken platform, and the record stops being
  // evidence.
  assertEquals(
    classifySessionFailure(new Error("connection reset")),
    "unknown",
  );
  assertEquals(
    classifySessionFailure(new TypeError("x is not a function")),
    "unknown",
  );
  assertEquals(classifySessionFailure("a string"), "unknown");
  assertEquals(classifySessionFailure(undefined), "unknown");
});

Deno.test("classification reads the code, not the message", () => {
  // A message rewrite must not reclassify a denial. This constructs a refusal
  // whose text says nothing about policy and asserts it still lands as denied.
  const error = new SessionOperationError("SESSION_SCOPE_DENIED");
  error.message = "something went wrong";
  assertEquals(classifySessionFailure(error), "denied");
});

Deno.test("a refusal is not swallowed by the classifier", () => {
  // The classifier must never be used to decide whether to rethrow: a denial
  // that becomes a 200 because the audit table was unwritable is the worst
  // failure mode on this surface.
  const error = new SessionToolError(
    "SESSION_TOOL_DENIED",
    "tasks.create",
    "work.write",
  );
  assertThrows(() => {
    if (classifySessionFailure(error) === "denied") throw error;
  }, SessionToolError);
});
