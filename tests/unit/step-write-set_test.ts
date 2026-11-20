/**
 * #448 slice S3: the step write set records one row per agent write (section
 * 17.6), with the attempt and session the write came from and the entry's
 * version before and after it. A person's own write is in no step's set.
 */

import { assertEquals } from "@std/assert";
import {
  StepWriteOp,
  stepWriteSetRow,
} from "../../apps/server/src/modules/knowledge/agent-file-scope.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const entryId = "00000000-0000-4000-8000-000000000002";

Deno.test("an agent's write builds one row naming its attempt, session and versions", () => {
  assertEquals(
    stepWriteSetRow(
      { attemptId: "attempt", agentSessionId: "session", fileGrantId: "g" },
      {
        organizationId,
        entryId,
        op: StepWriteOp.Put,
        previousVersionId: "v1",
        newVersionId: "v2",
      },
    ),
    {
      organizationId,
      attemptId: "attempt",
      agentSessionId: "session",
      entryId,
      op: "put",
      previousVersionId: "v1",
      newVersionId: "v2",
      previousParentId: null,
      previousName: null,
      entryVersionBefore: null,
    },
  );
});

Deno.test("a write in a default area with no session still records its attempt", () => {
  const row = stepWriteSetRow(
    { attemptId: "attempt", agentSessionId: null, fileGrantId: null },
    {
      organizationId,
      entryId,
      op: StepWriteOp.Mkdir,
      previousVersionId: null,
      newVersionId: null,
    },
  );
  assertEquals(row?.attemptId, "attempt");
  assertEquals(row?.agentSessionId, null);
  assertEquals(row?.op, "mkdir");
});

Deno.test("a person's own write is in no step's write set", () => {
  assertEquals(
    stepWriteSetRow(null, {
      organizationId,
      entryId,
      op: StepWriteOp.Put,
      previousVersionId: null,
      newVersionId: "v1",
    }),
    null,
  );
});

Deno.test("the write set names exactly the five storage operations", () => {
  assertEquals(Object.values(StepWriteOp).sort(), [
    "copy",
    "mkdir",
    "move",
    "put",
    "trash",
  ]);
});
