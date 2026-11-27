/**
 * The session CLI calls only operations a session may be offered (#404).
 *
 * A CLI is a second client of the same registry, which is exactly the shape that
 * grows a second truth. The fence here is narrow and mechanical: every operation
 * `packages/cli` names for a session must be one the server's operation map
 * offers, so a name that drifts - or an operation a person may call and a
 * session may not - fails in this rail rather than in a session at three in the
 * morning.
 */

import { assert, assertEquals } from "@std/assert";
import { SESSION_FILE_OPERATIONS } from "../../packages/cli/src/session-files.ts";
import {
  assertSessionToolAllowed,
  sessionOperationScopes,
} from "../../apps/server/src/modules/execution/session-tools.ts";

const OFFERED = new Set(sessionOperationScopes());

Deno.test("every operation the session CLI names is one a session may be offered", () => {
  for (const [method, operation] of Object.entries(SESSION_FILE_OPERATIONS)) {
    assert(
      OFFERED.has(operation),
      `the CLI's ${method} calls ${operation}, which no session is offered`,
    );
  }
});

Deno.test("the CLI names no operation a person keeps to themselves", () => {
  // Purge, restore and granting are people's operations (O51). Naming one here
  // would make the CLI advertise a command that can only ever be refused, which
  // reads to an agent as a permissions bug rather than a design decision.
  for (const operation of Object.values(SESSION_FILE_OPERATIONS)) {
    assert(
      !/(purge|restore|grant)/.test(operation),
      `${operation} is a person's operation`,
    );
  }
});

Deno.test("the session CLI's search stays the library search", () => {
  assertEquals(SESSION_FILE_OPERATIONS.search, "library.search");
  assert(OFFERED.has(SESSION_FILE_OPERATIONS.search));
  assert(OFFERED.has("files.search"));
});

Deno.test("a pin stays an administrator's action, not a session tool", () => {
  // The one files command the CLI keeps for people. Encode it here so a later
  // widening of the session map is a deliberate change with a failing rail.
  assert(
    !OFFERED.has("storageFiles.pin"),
    "storageFiles.pin became a session tool; the CLI's pin command must be revisited",
  );
});

Deno.test("each operation the CLI calls needs exactly one read scope", () => {
  // Proven against the gateway's own derivation rather than by reading it. The
  // expected scope is written out per command, so a scope moving on the server
  // side shows up here as the CLI's commands changing what they need.
  const expected: Record<string, string> = {
    roots: "files.read",
    entries: "files.read",
    versions: "files.read",
    uses: "files.read",
    byVersion: "files.read",
    content: "files.read",
    search: "library.read",
  };
  for (const [method, operation] of Object.entries(SESSION_FILE_OPERATIONS)) {
    assertEquals(
      assertSessionToolAllowed([expected[method]], operation),
      expected[method],
      `${method} does not need ${expected[method]}`,
    );
  }
  // A scope the CLI does not need buys nothing for it: no purge, no grants.
  for (const personOnly of ["storageEntries.purge", "storageFiles.pin"]) {
    assert(!OFFERED.has(personOnly), `${personOnly} became a session tool`);
  }
});
