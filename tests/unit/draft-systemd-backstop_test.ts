import { assertEquals, assertThrows } from "@std/assert";
import {
  createDraftIsolation,
  DraftIsolationError,
} from "../../apps/server/src/modules/knowledge/draft-isolation.ts";

// #271: systemd's RuntimeMaxSec is the backstop if the parent dies, and the
// launcher (infra/server-exec/draft-systemd.sh) accepts only 1 to 30 seconds.
// Without a check, budgets past that make the launcher exit 64 and every draft
// fail `unavailable` with no reason; the configuration is refused instead.

const outOfRange = (options: {
  startupDeadlineMs?: number;
  totalDeadlineMs?: number;
}) =>
  assertThrows(
    () => createDraftIsolation(options),
    DraftIsolationError,
  );

Deno.test("a backstop above the launcher's range is a named config error (#271)", () => {
  // Both budgets plus a second of slack: 20 s + 20 s + 1 s = 41 s.
  const error = outOfRange({
    startupDeadlineMs: 20_000,
    totalDeadlineMs: 20_000,
  });
  assertEquals(error.kind, "precondition");
  assertEquals(error.message, "SYSTEMD_BACKSTOP_OUT_OF_RANGE");
});

Deno.test("the largest backstop the launcher accepts is allowed (#271)", () => {
  // ceil((14 + 15) / 1) + 1 = 30 exactly, which systemd accepts.
  const isolation = createDraftIsolation({
    startupDeadlineMs: 14_000,
    totalDeadlineMs: 15_000,
  });
  assertEquals(typeof isolation.initialize, "function");
});

Deno.test("one second past the range is refused (#271)", () => {
  // ceil((14 + 16) / 1) + 1 = 31.
  const error = outOfRange({
    startupDeadlineMs: 14_000,
    totalDeadlineMs: 16_000,
  });
  assertEquals(error.message, "SYSTEMD_BACKSTOP_OUT_OF_RANGE");
});

Deno.test("the defaults stay inside the range (#271)", () => {
  // The built-in budgets make a small backstop; what matters is that the check
  // does not fire for them, so an ordinary isolation still builds.
  const isolation = createDraftIsolation({});
  assertEquals(typeof isolation.initialize, "function");
});
