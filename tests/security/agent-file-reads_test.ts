/**
 * #448 [AUTH] slice S2: an agent's file reads through the self-connection,
 * against the section 17.6 read defaults (O44). Every case drives a real
 * session call (worker claim, session credential, /session-call), so the
 * refusal is the one an agent actually receives, and each is set beside the
 * same read by the person the agent acts for.
 *
 * Area x actor matrix, under the default files section:
 *
 * | area                     | person | agent                              |
 * | ------------------------ | ------ | ---------------------------------- |
 * | /shared                  | reads  | reads (O44)                        |
 * | /library                 | reads  | reads (O44)                        |
 * | /users/<starter>         | reads  | agent_file_personal_area           |
 * | /users/<starter>, owner grant | reads | reads (the owner opened it)   |
 * | /trash                   | reads  | agent_file_trash_area              |
 * | /system (Admin)          | reads  | agent_file_system_area             |
 * | another organization     | 404    | 404                                |
 */

import { assert, assertEquals } from "@std/assert";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  registeredWorker,
  seedEligibleJob,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
type Json = Record<string, unknown>;

/** A person's own request, as the web app sends it. */
function asPerson(
  fixture: Fixture,
  method: string,
  path: string,
  body?: unknown,
  ifMatch?: number,
): Promise<Response> {
  return Promise.resolve(fixture.app.fetch(
    new Request(fixture.config.publicBaseUrl + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": fixture.organizationId,
        Cookie: fixture.adminCookie,
        "Idempotency-Key": crypto.randomUUID(),
        ...(ifMatch === undefined ? {} : { "If-Match": '"' + ifMatch + '"' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  ));
}

async function json(response: Response, status: number): Promise<Json> {
  const text = await response.text();
  assertEquals(response.status, status, text);
  return JSON.parse(text) as Json;
}

/** The status, code and named reason of a refusal. */
async function refusal(response: Response) {
  const body = JSON.parse(await response.text()) as Json & {
    issues?: { code?: string }[];
  };
  return {
    status: response.status,
    code: body.code,
    reason: (body.reason as string | undefined) ?? body.issues?.[0]?.code,
  };
}

type Agent = {
  call(tool: string, args: Json, ifMatch?: number): Promise<Response>;
  attemptId: string;
  job: Awaited<ReturnType<typeof seedEligibleJob>>;
};

/**
 * An agent in a real session: a registered worker claims a seeded job and
 * calls Bakery's own operations through the self-connection with the session
 * credential the claim minted.
 */
async function agentSession(
  fixture: Fixture,
  name: string,
  beforeClaim: (
    job: Awaited<ReturnType<typeof seedEligibleJob>>,
  ) => Promise<void>,
): Promise<Agent> {
  const worker = await registeredWorker(fixture, { name, slots: 1 });
  // A nonmodel job (quality.check): the fixture worker claims it with its
  // default capabilities. A model job needs funding and a model route, so a
  // bare seedEligibleJob is never claimed and the claim answers 204.
  const job = await seedEligibleNonmodelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  // The write scope is minted at claim only where a grant exists by then.
  await beforeClaim(job);
  const assignment = await claimAssignment(fixture, worker) as
    & Awaited<ReturnType<typeof claimAssignment>>
    & { sessionCredential?: string };
  const token = assignment.sessionCredential;
  assert(token, "the claim mints a session credential");
  return {
    attemptId: assignment.attemptId,
    job,
    call: (tool, args, ifMatch) =>
      workerRequest(
        fixture,
        worker.credential,
        "/v1/session/call",
        { tool, arguments: args },
        {
          headers: {
            "x-session-credential": token,
            ...(ifMatch === undefined
              ? {}
              : { "If-Match": '"' + ifMatch + '"' }),
          },
        },
      ),
  };
}

/**
 * A session call answers the gateway's envelope, `{ outcome, result }`, with
 * the operation's own response under `result` (session-gateway.ts
 * callSessionTool); a refusal is an ordinary problem body.
 */
async function sessionResult(response: Response): Promise<Json> {
  const body = await json(response, 200) as { outcome?: string; result?: Json };
  assertEquals(body.outcome, "allowed", JSON.stringify(body));
  assert(body.result, "the session call returned no result");
  return body.result;
}

async function grantFolder(
  fixture: Fixture,
  workflowId: string,
  folderId: string,
  access: "read" | "write",
): Promise<Json> {
  return await json(
    await asPerson(fixture, "POST", "/v1/storage/agent-file-grants", {
      workflowId,
      folderId,
      access,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
    201,
  );
}

type Item = { id: string; path: string; kind?: string };

async function rootsAsPerson(fixture: Fixture): Promise<Item[]> {
  const page = await json(
    await asPerson(fixture, "GET", "/v1/storage/roots"),
    200,
  ) as { items: Item[] };
  return page.items;
}

function rootAt(items: readonly Item[], path: string): Item {
  const found = items.find((item) => item.path === path);
  assert(found, "no root " + path + " in " + JSON.stringify(items));
  return found;
}

Deno.test("an agent reads the O44 areas and each closed area refuses by name", () =>
  withWorkerFixture(async (fixture) => {
    // A file PUT lands in an existing folder only: create it first, or the
    // PUT answers 404 and none of the checks below run.
    await json(
      await asPerson(fixture, "POST", "/v1/storage/folders", {
        path: "/shared/agent-448-read",
      }),
      201,
    );
    const sharedFile = await json(
      await asPerson(fixture, "PUT", "/v1/storage/files", {
        path: "/shared/agent-448-read/brief.md",
        mediaType: "text/plain",
        content: btoa("shared bytes"),
      }),
      200,
    );
    const roots = await rootsAsPerson(fixture);
    const shared = rootAt(roots, "/shared");
    const library = rootAt(roots, "/library");
    const trash = rootAt(roots, "/trash");
    const system = rootAt(roots, "/system");
    const personal = roots.find((item) => item.path.startsWith("/users/"));
    assert(personal, "the person has a personal folder");
    const privateFile = await json(
      await asPerson(fixture, "PUT", "/v1/storage/files", {
        path: personal.path + "/private.md",
        mediaType: "text/plain",
        content: btoa("private bytes"),
      }),
      200,
    );

    const agent = await agentSession(
      fixture,
      "agent-448-reads",
      async () => {},
    );

    // The roots an agent sees: its files section's areas, never the starter's
    // folder, /trash or /system.
    const agentRoots = (await sessionResult(
      await agent.call("storageRoots.list", {}),
    )) as { items: Item[] };
    const paths = agentRoots.items.map((item) => item.path).sort();
    assertEquals(paths, ["/library", "/projects", "/shared"]);

    // /shared and /library: readable by default.
    for (const folder of [shared, library]) {
      await sessionResult(
        await agent.call("storageFolderEntries.list", { id: folder.id }),
      );
      await json(
        await asPerson(
          fixture,
          "GET",
          "/v1/storage/folders/" + folder.id + "/entries",
        ),
        200,
      );
    }
    const bytes = await sessionResult(
      await agent.call("storageFiles.content", { id: sharedFile.id }),
    ) as unknown;
    assertEquals(atob(bytes as string), "shared bytes");

    // /users/<starter>: open to the person, closed to the agent by name.
    await json(
      await asPerson(
        fixture,
        "GET",
        "/v1/storage/folders/" + personal.id + "/entries",
      ),
      200,
    );
    for (
      const [tool, id] of [
        ["storageFolderEntries.list", personal.id],
        ["storageFiles.content", privateFile.id as string],
      ] as const
    ) {
      assertEquals(await refusal(await agent.call(tool, { id })), {
        status: 403,
        code: "AUTH_FORBIDDEN",
        reason: "agent_file_personal_area",
      }, tool);
    }

    // /trash and /system: unreachable for the agent, even for an Admin's.
    await json(
      await asPerson(
        fixture,
        "GET",
        "/v1/storage/folders/" + trash.id + "/entries",
      ),
      200,
    );
    assertEquals(
      (await refusal(
        await agent.call("storageFolderEntries.list", { id: trash.id }),
      )).reason,
      "agent_file_trash_area",
    );
    await json(
      await asPerson(
        fixture,
        "GET",
        "/v1/storage/folders/" + system.id + "/entries",
      ),
      200,
    );
    assertEquals(
      (await refusal(
        await agent.call("storageFolderEntries.list", { id: system.id }),
      )).reason,
      "agent_file_system_area",
    );

    // An id that is not this organization's: not found, for both.
    const elsewhere = crypto.randomUUID();
    assertEquals(
      (await asPerson(
        fixture,
        "GET",
        "/v1/storage/folders/" + elsewhere + "/entries",
      ))
        .status,
      404,
    );
    assertEquals(
      (await refusal(
        await agent.call("storageFolderEntries.list", { id: elsewhere }),
      )).status,
      404,
    );
  }));

Deno.test("the starter's own folder opens to the agent only when its owner grants it", () =>
  withWorkerFixture(async (fixture) => {
    const roots = await rootsAsPerson(fixture);
    const personal = roots.find((item) => item.path.startsWith("/users/"));
    assert(personal, "the person has a personal folder");
    const agent = await agentSession(
      fixture,
      "agent-448-owner-grant",
      async () => {},
    );
    assertEquals(
      (await refusal(
        await agent.call("storageFolderEntries.list", { id: personal.id }),
      )).reason,
      "agent_file_personal_area",
    );
    // The owner grants the workflow a read on their own folder: the very next
    // read opens, because the guard reads grants at the time of the call.
    await grantFolder(fixture, agent.job.workflowId, personal.id, "read");
    await sessionResult(
      await agent.call("storageFolderEntries.list", { id: personal.id }),
    );
  }));
