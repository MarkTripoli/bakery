import { assertEquals } from "@std/assert";
import english from "../../packages/i18n/locales/en.json" with { type: "json" };
import {
  DISPATCH_BLOCK_REASONS,
  dispatchBlockedKey,
  READINESS_REASONS,
  readinessReasonKey,
} from "../../apps/web/src/pages/machine-dispatch-reason.ts";

Deno.test("every dispatch block reason maps to an English catalog row", () => {
  const catalog = english as Record<string, string>;
  for (const reason of DISPATCH_BLOCK_REASONS) {
    const key = dispatchBlockedKey(reason);
    assertEquals(key, `machines.dispatch.blocked.${reason}`);
    assertEquals(typeof catalog[key as string], "string");
  }
});

Deno.test("every readiness reason maps to an English catalog row", () => {
  const catalog = english as Record<string, string>;
  for (const reason of READINESS_REASONS) {
    const key = readinessReasonKey(reason);
    assertEquals(key, `machines.readiness.reason.${reason}`);
    assertEquals(typeof catalog[key as string], "string");
  }
});

Deno.test("null and unknown reasons have no key", () => {
  assertEquals(dispatchBlockedKey(null), null);
  assertEquals(dispatchBlockedKey(undefined), null);
  assertEquals(readinessReasonKey(null), null);
  assertEquals(readinessReasonKey("raw_server_code"), null);
});
