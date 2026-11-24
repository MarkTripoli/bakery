import { assert, assertEquals, assertThrows } from "@std/assert";
import { ActionKind } from "../../packages/contracts/src/action-registry.ts";
import { implementedActions } from "../../packages/contracts/src/implemented-actions.ts";
import {
  assertSessionToolAllowed,
  listSessionTools,
  PEOPLE_ONLY_OPERATIONS,
  POWER_SESSION_SCOPES,
  powerForSessionScope,
  sessionOperationScopes,
  type SessionTool,
  SessionToolError,
} from "../../apps/server/src/modules/execution/session-tools.ts";

const code = (error: unknown): string | undefined =>
  error instanceof SessionToolError ? error.code : undefined;

function action(
  name: string,
  type: typeof ActionKind.Query | typeof ActionKind.Command = ActionKind.Query,
) {
  return {
    name,
    method: "GET",
    path: `/v1/${name}`,
    input: undefined,
    output: undefined,
    policy: { type, access: "RequiredAuthenticatedContext" },
  } as never;
}

const names = (tools: readonly SessionTool[]) => tools.map((t) => t.name);

Deno.test("every scope key names an implemented operation", () => {
  // A key naming an operation that was never implemented is unreachable: the
  // gateway can only offer what the registry runs, so the entry is dead weight
  // that reads like a granted capability. Three such keys shipped once.
  const implemented = new Set<string>(implementedActions);
  const dead = sessionOperationScopes().filter((name) =>
    !implemented.has(name)
  );
  assertEquals(dead, []);
});

Deno.test("a session is offered exactly the tools its scopes cover", () => {
  const registry = [
    action("tasks.list"),
    action("runs.get"),
    action("tasks.update", ActionKind.Command),
  ];
  assertEquals(names(listSessionTools(["work.read"], registry)), [
    "tasks.list",
  ]);
  assertEquals(names(listSessionTools(["work.read", "runs.read"], registry)), [
    "runs.get",
    "tasks.list",
  ]);
  // Holding one scope does not imply another: an unrelated scope buys nothing.
  assertEquals(
    names(listSessionTools(["artifacts.read"], registry)),
    [],
  );
});

Deno.test("a session holding nothing is offered nothing", () => {
  // The empty case matters: refusing to list is the default a definition gets,
  // so a bug that offered everything would be invisible everywhere else.
  assertEquals(listSessionTools([], [action("tasks.list")]), []);
});

Deno.test("an operation with no session scope is never offered", () => {
  // Classifying an operation for sessions is a deliberate act. Without it the
  // operation stays unreachable from a session, whatever scope is held.
  const tools = listSessionTools(
    ["work.read", "runs.read", "artifacts.read", "search.read", "library.read"],
    [action("accessBindings.delete", ActionKind.Command)],
  );
  assertEquals(tools, []);
});

Deno.test("a registry action the contracts package does not know is a bug, not a tool", () => {
  const error = assertThrows(() =>
    listSessionTools(["work.read"], [action("made.up")])
  );
  assertEquals(code(error), "SESSION_TOOL_UNKNOWN");
});

Deno.test("the list is stable across calls, whatever order the registry is in", () => {
  const a = action("tasks.list");
  const b = action("runs.get");
  const first = names(listSessionTools(["work.read", "runs.read"], [a, b]));
  const second = names(listSessionTools(["work.read", "runs.read"], [b, a]));
  // An agent that decides from the list should see the same list twice, and a
  // snapshot digest is only meaningful if the order is not incidental.
  assertEquals(first, second);
  assertEquals(first, [...first].sort());
});

Deno.test("a read is marked read-only so a definition need not classify it", () => {
  const tools = listSessionTools(
    ["work.read", "runs.read"],
    [action("tasks.list"), action("runs.get")],
  );
  assertEquals(tools.length, 2);
  // Both are reads; the point is the flag is derived from the registry's own
  // policy rather than taken from a second hand-maintained list.
  for (const tool of tools) assertEquals(tool.readOnly, true);
});

Deno.test("calling a tool that was never offered is refused, naming the scope", () => {
  const error = assertThrows(() =>
    assertSessionToolAllowed(["work.read"], "tasks.create")
  );
  assertEquals(code(error), "SESSION_TOOL_DENIED");
  // Naming the scope is what makes the refusal fixable rather than mysterious.
  // Creating a task is the first half of a spawn (#413), so it needs the
  // run_start power's scope, not a general write scope nobody is granted.
  assertEquals((error as SessionToolError).scope, "runs.start");
});

Deno.test("a tool that does not exist is distinguished from one not held", () => {
  // Different facts about the world: one is a typo or a stale client, the other
  // is a permission decision. Collapsing them hides the first forever.
  assertEquals(
    code(
      assertThrows(() =>
        assertSessionToolAllowed(["work.read"], "does.not.exist")
      ),
    ),
    "SESSION_TOOL_UNKNOWN",
  );
  assertEquals(
    code(assertThrows(() => assertSessionToolAllowed([], "tasks.list"))),
    "SESSION_TOOL_DENIED",
  );
});

Deno.test("a held scope admits the tool it covers", () => {
  // The positive control: without it every refusal above could pass for the
  // wrong reason.
  assertEquals(
    assertSessionToolAllowed(["work.read"], "tasks.list"),
    "work.read",
  );
});

Deno.test("runs.retry is never a session tool, whatever the session holds", () => {
  // Retry is engine work that is not built for anyone (#414 ruling), so an agent
  // must not be offered it even when its workflow holds every power. A tool is
  // offered only if the scope map names it; this pins that it does not.
  assertEquals(
    (sessionOperationScopes() as readonly string[]).includes("runs.retry"),
    false,
  );
  const everyScope = [
    "runs.read",
    "library.read",
    "work.read",
    "artifacts.read",
    "approvals.decide",
    "runs.control",
    "runs.write",
    "runs.retry",
  ];
  let offered: readonly SessionTool[] = [];
  try {
    offered = listSessionTools(everyScope, [
      action("runs.retry", ActionKind.Command),
    ]);
  } catch (error) {
    // Until retry is implemented the registry cannot even name it.
    assertEquals(code(error), "SESSION_TOOL_UNKNOWN");
  }
  assertEquals((names(offered) as string[]).includes("runs.retry"), false);
});

Deno.test("exactly the 15 people-only operations are refused as a person's; another unscoped operation stays unknown", () => {
  assertEquals(PEOPLE_ONLY_OPERATIONS.size, 15);
  for (const name of PEOPLE_ONLY_OPERATIONS) {
    assert(
      (implementedActions as readonly string[]).includes(name),
      name + " is registered",
    );
    assert(!sessionOperationScopes().includes(name), name + " has no scope");
    assertEquals(
      code(assertThrows(() => assertSessionToolAllowed(["work.read"], name))),
      "SESSION_TOOL_PEOPLE_ONLY",
      name,
    );
  }
  // Registered and unscoped, but not one of O51's: not called a person's.
  for (const name of ["identity.get", "organizations.list"]) {
    assert((implementedActions as readonly string[]).includes(name), name);
    assert(!sessionOperationScopes().includes(name), name);
    assertEquals(
      code(assertThrows(() => assertSessionToolAllowed(["work.read"], name))),
      "SESSION_TOOL_UNKNOWN",
      name,
    );
  }
});

Deno.test("a registered operation no scope names is a person's, refused by name", () => {
  // secrets.list is registered and never classified for sessions (O51): the
  // refusal says so rather than claiming no such operation exists.
  assertEquals(
    code(
      assertThrows(() =>
        assertSessionToolAllowed(["work.read"], "secrets.list")
      ),
    ),
    "SESSION_TOOL_PEOPLE_ONLY",
  );
});

Deno.test("the comment and edit_work powers offer exactly their own tools", () => {
  const registry = [
    action("artifactComments.create", ActionKind.Command),
    action("artifactComments.update", ActionKind.Command),
    action("tasks.update", ActionKind.Command),
    action("tasks.list"),
  ];
  assertEquals(
    names(listSessionTools(POWER_SESSION_SCOPES.comment, registry)),
    [
      "artifactComments.create",
      "artifactComments.update",
    ],
  );
  assertEquals(
    names(listSessionTools(POWER_SESSION_SCOPES.edit_work, registry)),
    ["tasks.update"],
  );
  // Reading work does not offer editing it, and neither power offers the other.
  assertEquals(names(listSessionTools(["work.read"], registry)), [
    "tasks.list",
  ]);
});

Deno.test("only a granted power's scope is rechecked as a power", () => {
  assertEquals(powerForSessionScope("comments.write"), "comment");
  assertEquals(powerForSessionScope("work.write"), "edit_work");
  assertEquals(powerForSessionScope("runs.start"), "run_start");
  // Reads and the files scopes have no power behind them.
  assertEquals(powerForSessionScope("work.read"), null);
  assertEquals(powerForSessionScope("files.write"), null);
});
