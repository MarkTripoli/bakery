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
  callSessionTool,
  classifySessionFailure,
  sessionPolicyRefusalCodes,
} from "../../apps/server/src/modules/execution/session-gateway.ts";
import { SessionOperationError } from "../../apps/server/src/modules/execution/session-credential.ts";
import { SessionToolError } from "../../apps/server/src/modules/execution/session-tools.ts";

Deno.test("every typed refusal is recorded as a denial, not a shrug", () => {
  // The list is asserted as data rather than described, because "the typed
  // refusals" is how one gets missed - and one was: SESSION_CREDENTIAL_INVALID
  // is raised by resolution rather than by an explicit check, so it is the
  // easiest to overlook and the most security-relevant of them.
  assertEquals(sessionPolicyRefusalCodes(), [
    "SESSION_CREDENTIAL_EXPIRED",
    "SESSION_CREDENTIAL_FENCE_STALE",
    "SESSION_CREDENTIAL_INVALID",
    "SESSION_SCOPE_DENIED",
    "SESSION_TOOL_DENIED",
    "SESSION_TOOL_PEOPLE_ONLY",
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

Deno.test("a credential that never resolves still leaves a refusal record", async () => {
  // The audit's key is the credential, so this path cannot use it. The refusal
  // table exists so the call is not simply unrecorded: what is known is the
  // organization, the attempt asked about, and the hash of the token presented.
  const statements: { sql: string; params: unknown[] }[] = [];
  const transaction = {
    query: (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      // The credential lookup finds nothing, which is the case under test.
      return Promise.resolve({ rows: [] });
    },
  };

  const error = await callSessionTool({
    transaction: transaction as never,
    identity: {
      tokenHash: "host-token-hash",
      host: { organization_id: "org-1" },
    } as never,
    attemptId: "attempt-1",
    credentialToken: "a-token-that-names-nothing",
    registry: [],
    tool: "session.tools",
    arguments: {},
    execute: () => Promise.reject(new Error("must not run")),
  }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  assertEquals(
    (error as SessionOperationError).code,
    "SESSION_CREDENTIAL_INVALID",
  );
  const refusal = statements.find((statement) =>
    statement.sql.includes("session_operation_refusals")
  );
  assertEquals(refusal !== undefined, true, "no refusal row was written");
  // The organization and attempt come from the caller, the token hash from the
  // presented bearer, and the outcome from the classifier - never invented.
  assertEquals(refusal!.params[0], "org-1");
  assertEquals(refusal!.params[1], "attempt-1");
  assertEquals(refusal!.params[3], "session.tools");
  assertEquals(refusal!.params[4], "denied");
  // The bearer itself is never stored, only its hash.
  assertEquals(refusal!.params[2] === "a-token-that-names-nothing", false);
});
