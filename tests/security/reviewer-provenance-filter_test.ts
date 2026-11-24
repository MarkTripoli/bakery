/**
 * #448 [AUTH] slice S8b, O47: a reviewer agent session never receives a
 * version a writer step of the same run tree wrote outside its declared
 * outputs, nor another step's transcript, in a read, a listing or a version
 * list. Every agent case drives a real session call (worker claim, session
 * credential, /session-call), and each is set beside the same read by the
 * person the agents act for and by a session of the same tree whose step is
 * not a reviewer's.
 *
 * | what                                   | person | other session | reviewer |
 * | -------------------------------------- | ------ | ------------- | -------- |
 * | writer's side-write, in a granted folder | sees  | sees          | 404 / left out |
 * | the same, written before 0300 (no run) | sees   | sees          | 404 / left out |
 * | a person's file in the same folder     | sees   | sees          | sees     |
 * | writer's declared output (artifact)    | sees   | sees          | sees     |
 * | writer's transcript (log artifact)     | sees   | sees          | 404 / left out |
 *
 * The reviewer's workflow holds a read grant on the folder: a grant opens a
 * folder, never a version the provenance filter hides.
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
import type { ActionContext } from "../../packages/contracts/src/action-registry.ts";
import { withPgTransaction } from "../../packages/persistence/src/postgres.ts";
import { createFileSearchHandler } from "../../apps/server/src/modules/knowledge/file-search.ts";
import {
  projectArtifactEntry,
  storageQueryOf,
} from "../../apps/server/src/modules/knowledge/storage-tree.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];
type Json = Record<string, unknown>;

function asPerson(
  fixture: Fixture,
  method: string,
  path: string,
  body?: unknown,
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

type Agent = {
  call(tool: string, args: Json): Promise<Response>;
  attemptId: string;
  job: Awaited<ReturnType<typeof seedEligibleJob>>;
};

async function agentSession(
  fixture: Fixture,
  name: string,
  beforeClaim: (job: Agent["job"]) => Promise<void>,
): Promise<Agent> {
  const worker = await registeredWorker(fixture, { name, slots: 1 });
  const job = await seedEligibleNonmodelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  await beforeClaim(job);
  const assignment = await claimAssignment(fixture, worker) as
    & Awaited<ReturnType<typeof claimAssignment>>
    & { sessionCredential?: string };
  const token = assignment.sessionCredential;
  assert(token, "the claim mints a session credential");
  return {
    attemptId: assignment.attemptId,
    job,
    call: (tool, args) =>
      workerRequest(
        fixture,
        worker.credential,
        "/v1/session/call",
        { tool, arguments: args },
        { headers: { "x-session-credential": token } },
      ),
  };
}

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
): Promise<void> {
  await json(
    await asPerson(fixture, "POST", "/v1/storage/agent-file-grants", {
      workflowId,
      folderId,
      access,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
    201,
  );
}

function put(path: string, text: string): Json {
  return { path, mediaType: "text/plain", content: btoa(text) };
}

/**
 * The step's job runs the review action, and its run joins the writer's run
 * tree as a run the writer's run spawned. Set after the claim: the fixture
 * worker claims a nonmodel job, and what makes a session a reviewer's is read
 * from its job at each call.
 */
async function makeReviewerOf(
  fixture: Fixture,
  agent: Agent,
  writer: Agent,
): Promise<void> {
  await fixture.pgDatabase.query(
    "update bakery.jobs set action = 'review.independent'" +
      " where organization_id = $1 and id = $2",
    [fixture.organizationId, agent.job.jobId],
  );
  await joinTree(fixture, agent, writer);
}

async function joinTree(
  fixture: Fixture,
  agent: Agent,
  writer: Agent,
): Promise<void> {
  await fixture.pgDatabase.query(
    "update bakery.workflow_runs set spawned_by_run_id = $3" +
      " where organization_id = $1 and id = $2",
    [fixture.organizationId, agent.job.runId, writer.job.runId],
  );
}

/** A record-area artifact the writer's step published, current at one version. */
async function publishedArtifact(
  fixture: Fixture,
  writer: Agent,
  artifactType: string,
  name: string,
): Promise<{ artifactId: string; versionId: string }> {
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const bytes = new TextEncoder().encode(name);
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  await fixture.pgDatabase.query(
    "insert into bakery.artifacts (id, organization_id, task_id, artifact_type, name)" +
      " values ($1, $2, $3, $4, $5)",
    [artifactId, fixture.organizationId, writer.job.taskId, artifactType, name],
  );
  await fixture.pgDatabase.query(
    "insert into bakery.artifact_versions (id, organization_id, artifact_id," +
      " task_id, run_step_id, run_id, attempt_id, author_id, revision, content," +
      " sha256, size_bytes, media_type)" +
      " values ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11, 'text/plain')",
    [
      versionId,
      fixture.organizationId,
      artifactId,
      writer.job.taskId,
      writer.job.runStepId,
      writer.job.runId,
      writer.attemptId,
      fixture.principalId,
      bytes,
      digest,
      bytes.length,
    ],
  );
  await fixture.pgDatabase.query(
    "update bakery.artifacts set current_version_id = $2" +
      " where organization_id = $1 and id = $3",
    [fixture.organizationId, versionId, artifactId],
  );
  return { artifactId, versionId };
}

type Item = { id: string; name: string };

async function namesInFolder(
  call: () => Promise<Response>,
  session: boolean,
): Promise<string[]> {
  const page = session
    ? await sessionResult(await call())
    : await json(await call(), 200);
  return (page.items as Item[]).map((item) => item.name).sort();
}

Deno.test("a reviewer never receives a writer step's side-writes; people and other sessions do", () =>
  withWorkerFixture(async (fixture) => {
    const folder = await json(
      await asPerson(fixture, "POST", "/v1/storage/folders", {
        path: "/shared/review-448",
      }),
      201,
    );
    const folderId = folder.id as string;
    const personFile = await json(
      await asPerson(
        fixture,
        "PUT",
        "/v1/storage/files",
        put("/shared/review-448/person.md", "a person's notes"),
      ),
      200,
    );

    const writer = await agentSession(
      fixture,
      "writer-448",
      (job) => grantFolder(fixture, job.workflowId, folderId, "write"),
    );
    const side = await sessionResult(
      await writer.call(
        "storageFiles.put",
        put("/shared/review-448/side.md", "the writer's side-write"),
      ),
    );
    const legacy = await sessionResult(
      await writer.call(
        "storageFiles.put",
        put("/shared/review-448/legacy.md", "written before 0300"),
      ),
    );
    // A version written before migration 0300 recorded no run, step, attempt
    // or session: only its step write set row names the attempt.
    await fixture.pgDatabase.query(
      "update bakery.storage_file_versions set run_id = null," +
        " run_step_id = null, attempt_id = null, agent_session_id = null" +
        " where organization_id = $1 and entry_id = $2",
      [fixture.organizationId, legacy.id],
    );
    const output = await publishedArtifact(
      fixture,
      writer,
      "plan",
      "review-448-output",
    );
    const transcript = await publishedArtifact(
      fixture,
      writer,
      "log",
      "output-transcript/" + crypto.randomUUID() + "/manifest",
    );

    // The reviewer's workflow is granted the folder: a grant does not reopen
    // what provenance hides.
    const reviewer = await agentSession(
      fixture,
      "reviewer-448",
      (job) => grantFolder(fixture, job.workflowId, folderId, "read"),
    );
    await makeReviewerOf(fixture, reviewer, writer);
    const other = await agentSession(
      fixture,
      "sibling-448",
      (job) => grantFolder(fixture, job.workflowId, folderId, "read"),
    );
    await joinTree(fixture, other, writer);

    const everything = ["legacy.md", "person.md", "side.md"];
    // Listing.
    assertEquals(
      await namesInFolder(
        () =>
          asPerson(
            fixture,
            "GET",
            "/v1/storage/folders/" + folderId + "/entries",
          ),
        false,
      ),
      everything,
    );
    assertEquals(
      await namesInFolder(
        () => other.call("storageFolderEntries.list", { id: folderId }),
        true,
      ),
      everything,
    );
    assertEquals(
      await namesInFolder(
        () => reviewer.call("storageFolderEntries.list", { id: folderId }),
        true,
      ),
      ["person.md"],
    );

    // Content: hidden reads answer 404, as for a file that is not there.
    for (const id of [side.id as string, legacy.id as string]) {
      const person = await asPerson(
        fixture,
        "GET",
        "/v1/storage/files/" + id + "/content",
      );
      assertEquals(person.status, 200, await person.text());
      await sessionResult(await other.call("storageFiles.content", { id }));
      const refused = await reviewer.call("storageFiles.content", { id });
      assertEquals(refused.status, 404, await refused.text());
    }
    const personBytes = await sessionResult(
      await reviewer.call("storageFiles.content", { id: personFile.id }),
    ) as unknown;
    assertEquals(atob(personBytes as string), "a person's notes");

    // A named revision of a side-write is hidden too.
    const byRevision = await reviewer.call("storageFiles.content", {
      id: side.id,
      revision: 1,
    });
    assertEquals(byRevision.status, 404, await byRevision.text());

    // The writer's declared output stays visible to the reviewer.
    const got = await sessionResult(
      await reviewer.call("artifacts.get", { id: output.artifactId }),
    );
    assertEquals(got.id, output.artifactId);
    const versions = await sessionResult(
      await reviewer.call("artifactVersions.list", { id: output.artifactId }),
    );
    assertEquals(
      (versions.items as Item[]).map((item) => item.id),
      [output.versionId],
    );

    // The writer's transcript: people and other sessions see it, the
    // reviewer gets 404 and finds it in no list.
    await json(
      await asPerson(fixture, "GET", "/v1/artifacts/" + transcript.artifactId),
      200,
    );
    await sessionResult(
      await other.call("artifacts.get", { id: transcript.artifactId }),
    );
    for (const tool of ["artifacts.get", "artifactVersions.list"]) {
      const refused = await reviewer.call(tool, { id: transcript.artifactId });
      assertEquals(refused.status, 404, tool + ": " + await refused.text());
    }
    const listed = async (agent: Agent) =>
      ((await sessionResult(
        await agent.call("artifacts.list", { taskId: writer.job.taskId }),
      )).items as Item[]).map((item) => item.id).sort();
    assertEquals(
      await listed(other),
      [output.artifactId, transcript.artifactId].sort(),
    );
    assertEquals(await listed(reviewer), [output.artifactId]);

    // Library search: another session finds the transcript by its name, the
    // reviewer finds only the declared output.
    const found = async (agent: Agent) =>
      ((await sessionResult(
        await agent.call("library.search", {
          query: "output",
          kind: "artifact",
        }),
      )).items as Item[]).map((item) => item.id).sort();
    assertEquals(
      await found(other),
      [output.artifactId, transcript.artifactId].sort(),
    );
    assertEquals(await found(reviewer), [output.artifactId]);
  }));

Deno.test("a reviewer outside the writer's run tree, and its own writes, stay unfiltered", () =>
  withWorkerFixture(async (fixture) => {
    const folder = await json(
      await asPerson(fixture, "POST", "/v1/storage/folders", {
        path: "/shared/review-448-apart",
      }),
      201,
    );
    const folderId = folder.id as string;
    const writer = await agentSession(
      fixture,
      "writer-448-apart",
      (job) => grantFolder(fixture, job.workflowId, folderId, "write"),
    );
    const side = await sessionResult(
      await writer.call(
        "storageFiles.put",
        put("/shared/review-448-apart/side.md", "another tree's write"),
      ),
    );
    // A reviewer of an unrelated run: the side-write is not of its tree.
    const reviewer = await agentSession(
      fixture,
      "reviewer-448-apart",
      (job) => grantFolder(fixture, job.workflowId, folderId, "write"),
    );
    // Written by the reviewer's own step before its job became a review: what
    // its step wrote itself it reads back.
    const own = await sessionResult(
      await reviewer.call(
        "storageFiles.put",
        put("/shared/review-448-apart/verdict.md", "the reviewer's own"),
      ),
    );
    await fixture.pgDatabase.query(
      "update bakery.jobs set action = 'review.independent'" +
        " where organization_id = $1 and id = $2",
      [fixture.organizationId, reviewer.job.jobId],
    );
    await sessionResult(
      await reviewer.call("storageFiles.content", { id: side.id }),
    );
    await sessionResult(
      await reviewer.call("storageFiles.content", { id: own.id }),
    );
    // A reviewer writes only its declared outputs: every storage write is
    // refused by name, though its workflow holds a write grant on the folder,
    // and nothing is created.
    for (
      const [tool, args] of [
        [
          "storageFiles.put",
          put("/shared/review-448-apart/extra.md", "a side-write"),
        ],
        ["storageFolders.create", { path: "/shared/review-448-apart/sub" }],
        [
          "storageFiles.put",
          put("/shared/review-448-apart/verdict.md", "overwrite"),
        ],
      ] as const
    ) {
      const refused = await reviewer.call(tool, args as Json);
      const text = await refused.text();
      assertEquals(refused.status, 403, tool + ": " + text);
      assertEquals(
        (JSON.parse(text) as Json).reason,
        "agent_file_reviewer_outputs_only",
        tool,
      );
    }
    const made = await fixture.pgDatabase.query<{ name: string }>(
      "select name from bakery.storage_entries" +
        " where organization_id = $1 and parent_id = $2 order by name",
      [fixture.organizationId, folderId],
    );
    assertEquals(made.rows.map((row) => row.name), ["side.md", "verdict.md"]);
    const versions = await fixture.pgDatabase.query<{ n: string }>(
      "select count(*) as n from bakery.storage_file_versions" +
        " where organization_id = $1 and entry_id = $2",
      [fixture.organizationId, own.id],
    );
    assertEquals(Number(versions.rows[0].n), 1);
    // Once the reviewer's run joins the writer's tree, the same read is
    // hidden on the very next call; its own write is not.
    await fixture.pgDatabase.query(
      "update bakery.workflow_runs set spawned_by_run_id = $3" +
        " where organization_id = $1 and id = $2",
      [fixture.organizationId, reviewer.job.runId, writer.job.runId],
    );
    const refused = await reviewer.call("storageFiles.content", {
      id: side.id,
    });
    assertEquals(refused.status, 404, await refused.text());
    await sessionResult(
      await reviewer.call("storageFiles.content", { id: own.id }),
    );
  }));

Deno.test("a declared output of the tree reaches the reviewer where nothing else of that folder does", () =>
  withWorkerFixture(async (fixture) => {
    const writer = await agentSession(
      fixture,
      "writer-448-out",
      () => Promise.resolve(),
    );
    const output = await publishedArtifact(
      fixture,
      writer,
      "plan",
      "review-448-elsewhere",
    );
    // A person's artifact on the same work item: not an output of any step.
    const personArtifact = crypto.randomUUID();
    await fixture.pgDatabase.query(
      "insert into bakery.artifacts (id, organization_id, task_id, artifact_type, name)" +
        " values ($1, $2, $3, 'plan', 'review-448-person')",
      [personArtifact, fixture.organizationId, writer.job.taskId],
    );
    const personVersion = crypto.randomUUID();
    const bytes = new TextEncoder().encode("person");
    await fixture.pgDatabase.query(
      "insert into bakery.artifact_versions (id, organization_id, artifact_id," +
        " task_id, author_id, revision, content, sha256, size_bytes, media_type)" +
        " values ($1, $2, $3, $4, $5, 1, $6, $7, $8, 'text/plain')",
      [
        personVersion,
        fixture.organizationId,
        personArtifact,
        writer.job.taskId,
        fixture.principalId,
        bytes,
        "0".repeat(64),
        bytes.length,
      ],
    );
    await fixture.pgDatabase.query(
      "update bakery.artifacts set current_version_id = $2" +
        " where organization_id = $1 and id = $3",
      [fixture.organizationId, personVersion, personArtifact],
    );
    const db = storageQueryOf(fixture.pgDatabase as never);
    const outputEntry = await projectArtifactEntry(db, {
      organizationId: fixture.organizationId,
      artifactId: output.artifactId,
    });
    const personEntry = await projectArtifactEntry(db, {
      organizationId: fixture.organizationId,
      artifactId: personArtifact,
    });
    assert(outputEntry && personEntry, "both artifacts are projected");

    const reviewer = await agentSession(
      fixture,
      "reviewer-448-out",
      () => Promise.resolve(),
    );
    await makeReviewerOf(fixture, reviewer, writer);
    const sibling = await agentSession(
      fixture,
      "sibling-448-out",
      () => Promise.resolve(),
    );
    await joinTree(fixture, sibling, writer);

    // The writer's work item is not a place either session's files section
    // reaches: a sibling of the tree is refused the output by area.
    const siblingRead = await sibling.call("storageFiles.content", {
      id: outputEntry,
    });
    const siblingText = await siblingRead.text();
    assertEquals(siblingRead.status, 403, siblingText);
    assertEquals(
      (JSON.parse(siblingText) as Json).reason,
      "agent_file_area_not_declared",
    );
    // The reviewer reads the declared output it reviews.
    const got = await sessionResult(
      await reviewer.call("storageFiles.content", { id: outputEntry }),
    ) as unknown;
    assertEquals(atob(got as string), "review-448-elsewhere");
    // Nothing else of that folder opens: a person's file beside it is still
    // refused by area, and the folder still does not list.
    const beside = await reviewer.call("storageFiles.content", {
      id: personEntry,
    });
    const besideText = await beside.text();
    assertEquals(beside.status, 403, besideText);
    assertEquals(
      (JSON.parse(besideText) as Json).reason,
      "agent_file_area_not_declared",
    );
    const parent = await fixture.pgDatabase.query<{ parent_id: string }>(
      "select parent_id from bakery.storage_entries" +
        " where organization_id = $1 and id = $2",
      [fixture.organizationId, outputEntry],
    );
    const listing = await reviewer.call("storageFolderEntries.list", {
      id: parent.rows[0].parent_id,
    });
    assertEquals(listing.status, 403, await listing.text());
  }));

Deno.test("search leaves a writer's side-write out for a reviewer (files.search is not a session tool)", () =>
  withWorkerFixture(async (fixture) => {
    // files.search is not offered to sessions (no session scope names it), so
    // the filter is proven by calling the search handler itself, in a real
    // transaction, under the reviewer session's context.
    const folder = await json(
      await asPerson(fixture, "POST", "/v1/storage/folders", {
        path: "/shared/review-448-search",
      }),
      201,
    );
    const folderId = folder.id as string;
    await json(
      await asPerson(
        fixture,
        "PUT",
        "/v1/storage/files",
        put("/shared/review-448-search/srch448-person.md", "a person's"),
      ),
      200,
    );
    const writer = await agentSession(
      fixture,
      "writer-448-search",
      (job) => grantFolder(fixture, job.workflowId, folderId, "write"),
    );
    await sessionResult(
      await writer.call(
        "storageFiles.put",
        put("/shared/review-448-search/srch448-side.md", "side-write"),
      ),
    );
    const reviewer = await agentSession(
      fixture,
      "reviewer-448-search",
      (job) => grantFolder(fixture, job.workflowId, folderId, "read"),
    );
    await makeReviewerOf(fixture, reviewer, writer);
    const sibling = await agentSession(
      fixture,
      "sibling-448-search",
      (job) => grantFolder(fixture, job.workflowId, folderId, "read"),
    );
    await joinTree(fixture, sibling, writer);

    const search = createFileSearchHandler(
      "reviewer-search-test-cursor-secret-0123456789",
      () => false,
      () => true,
    );
    const names = (attemptId?: string) =>
      withPgTransaction(fixture.pgDatabase, async (transaction) => {
        const page = await search(
          {
            authority: {
              organizationId: fixture.organizationId,
              subject: { principalId: fixture.principalId },
            },
            transaction,
            ...(attemptId === undefined ? {} : {
              agentSession: { attemptId },
              sessionScopes: ["artifacts.read", "files.read"],
            }),
          } as unknown as ActionContext,
          { query: "srch448" } as never,
        ) as { items: { name: string }[] };
        return page.items.map((item) => item.name).sort();
      });
    const both = ["srch448-person.md", "srch448-side.md"];
    assertEquals(await names(), both);
    assertEquals(await names(sibling.attemptId), both);
    assertEquals(await names(reviewer.attemptId), ["srch448-person.md"]);
  }));
