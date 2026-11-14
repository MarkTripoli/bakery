import { assertEquals } from "@std/assert";
import {
  StandardError,
  unprocessable,
} from "../../packages/contracts/src/http.ts";
import { failureCodeOf } from "../../apps/server/src/modules/workflows/automations/start.ts";

// #36 slice 4a: why a firing could not start is one short stable code.

Deno.test("the code is the reason of an unprocessable input, else a conflict's reason, else the fault's own code", () => {
  assertEquals(
    failureCodeOf(unprocessable(["inputs", "brief"], "input_required")),
    "input_required",
  );
  assertEquals(
    failureCodeOf(
      new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "budget_below_reservation" },
      }),
    ),
    "budget_below_reservation",
  );
  assertEquals(
    failureCodeOf(new StandardError({ code: "RESOURCE_NOT_FOUND" })),
    "resource_not_found",
  );
  assertEquals(
    failureCodeOf(new StandardError({ code: "AUTH_FORBIDDEN" })),
    "auth_forbidden",
  );
  // An issue with no usable code, or a blank reason, falls through.
  assertEquals(
    failureCodeOf(
      new StandardError({
        code: "UNPROCESSABLE",
        params: { issues: [{ path: [], code: "" }], reason: "" },
      }),
    ),
    "unprocessable",
  );
  // Never longer than the column's vocabulary allows.
  assertEquals(
    failureCodeOf(unprocessable([], "x".repeat(200))).length,
    64,
  );
  assertEquals(
    failureCodeOf(
      new StandardError({
        code: "STATE_CONFLICT",
        params: { reason: "y".repeat(200) },
      }),
    ).length,
    64,
  );
});
