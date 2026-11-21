import { assert, assertEquals } from "@std/assert";
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { catalogActions } from "../../packages/contracts/src/contracts.ts";
import { BackupImplementedAction } from "../../packages/contracts/src/implemented-actions.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { PgDatabase } from "../../packages/persistence/src/postgres.ts";
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import { createBackupActionRegistry } from "../../apps/server/src/modules/backups/actions.ts";

// QA on #782: removing `sessionOnly` from either action passed every test.
// `sessionOnly` is what makes the authority refuse an access token and an MCP
// call (SESSION_REQUIRED) and keeps the action out of the MCP tool list, and
// the browser-session middleware on the routes covers plain HTTP only. These
// tests run the REAL actions through the REAL authority, so dropping the flag
// from either one fails here.

const ORGANIZATION_ID = "00000000-0000-4000-8000-0000000000bb";
const SESSION_ID = "00000000-0000-4000-8000-0000000000ee";
const PRINCIPAL_ID = "00000000-0000-4000-8000-0000000000cc";

/** The backup actions that change state for an administrator. */
const SESSION_ONLY_ACTIONS = [
  BackupImplementedAction.BackupsStart,
  BackupImplementedAction.BackupRunnerCredentialIssue,
  BackupImplementedAction.BackupSchedulePut,
  BackupImplementedAction.BackupOffsitePut,
  BackupImplementedAction.BackupOffsiteVerify,
  BackupImplementedAction.InstallationRestoreStep,
] as const;

/** The reads: an administrator may use them with a token. */
const READ_ACTIONS = [
  BackupImplementedAction.BackupsList,
  BackupImplementedAction.BackupsStatus,
  BackupImplementedAction.BackupScheduleGet,
  BackupImplementedAction.BackupOffsiteGet,
  BackupImplementedAction.InstallationRestoreGet,
  BackupImplementedAction.InstallationUncertainActionsGet,
] as const;

function registry() {
  return createBackupActionRegistry({} as PgDatabase, "unit-test-secret", {
    allowLoopbackEndpoint: false,
  });
}

function context(over: Partial<ActionContext> = {}): ActionContext {
  return {
    request: new Request("http://localhost/v1/installation/backups", {
      method: "POST",
      headers: { "Bakery-Organization-Id": ORGANIZATION_ID },
    }),
    params: {},
    requestId: "request-1",
    traceId: "trace-1",
    signal: new AbortController().signal,
    principal: {
      principalId: PRINCIPAL_ID,
      principalType: "human",
      displayName: "Ada Lovelace",
    },
    ...over,
  };
}

/** A database that fails loudly: the refusal must happen before any query. */
function untouchedDatabase(): PgDatabase {
  return new Proxy({}, {
    get: () => () => {
      throw new Error("the authority touched the database before refusing");
    },
  }) as unknown as PgDatabase;
}

async function refusal(
  name: (typeof SESSION_ONLY_ACTIONS)[number],
  call: ActionContext,
): Promise<string> {
  const action = registry().get(name);
  const runner = new PostgresAuthorityRunner(untouchedDatabase());
  try {
    await runner.run(action, call, {}, () => Promise.resolve("ran"));
  } catch (error) {
    if (error instanceof StandardError) return `${error.code}`;
    // Anything else means the authority went past the session rule.
    throw error;
  }
  return "not-refused";
}

Deno.test("the backup actions that change state are session-only", () => {
  for (const name of SESSION_ONLY_ACTIONS) {
    assertEquals(registry().get(name).policy.sessionOnly, true, name);
  }
  // The reads are not: a token with the right scope may read the list.
  for (const name of READ_ACTIONS) {
    assert(registry().get(name).policy.sessionOnly !== true, name);
  }
});

Deno.test("an MCP caller is refused every such action, before any work", async () => {
  for (const name of SESSION_ONLY_ACTIONS) {
    assertEquals(
      await refusal(name, context({ transport: "mcp" })),
      "SESSION_REQUIRED",
      name,
    );
  }
});

Deno.test("an access token is refused every such action, before any work", async () => {
  const accessToken = {
    id: "00000000-0000-4000-8000-0000000000dd",
    organizationId: ORGANIZATION_ID,
    scopes: [],
  };
  for (const name of SESSION_ONLY_ACTIONS) {
    assertEquals(
      await refusal(name, context({ transport: "http", accessToken })),
      "SESSION_REQUIRED",
      name,
    );
    // A token that arrives with no transport is refused the same way.
    assertEquals(
      await refusal(name, context({ accessToken })),
      "SESSION_REQUIRED",
      name,
    );
  }
});

Deno.test("a call with no session at all is refused every such action", async () => {
  for (const name of SESSION_ONLY_ACTIONS) {
    assertEquals(
      await refusal(name, context({ transport: "http" })),
      "SESSION_REQUIRED",
      name,
    );
    assertEquals(await refusal(name, context()), "SESSION_REQUIRED", name);
  }
});

Deno.test("a real browser session passes the session rule and reaches the database", async () => {
  // It gets as far as the database this test refuses to provide, which is the
  // proof it was not stopped by the session rule (so the refusals above are
  // about the missing session and not a blanket refusal).
  for (const name of SESSION_ONLY_ACTIONS) {
    const runner = new PostgresAuthorityRunner(untouchedDatabase());
    const error = await runner.run(
      registry().get(name),
      context({ transport: "http", sessionId: SESSION_ID }),
      {},
      () => Promise.resolve("ran"),
    ).then(() => undefined, (caught: unknown) => caught);
    assert(
      error instanceof Error && error.message.includes("touched the database"),
      `${name}: a browser session was refused`,
    );
  }
});

Deno.test("neither action is offered as an MCP tool", () => {
  const entries = new Map(catalogActions.map((entry) => [entry.action, entry]));
  for (const name of [...SESSION_ONLY_ACTIONS, ...READ_ACTIONS]) {
    assertEquals(entries.get(name)?.mcp ?? null, null, name);
  }
});
