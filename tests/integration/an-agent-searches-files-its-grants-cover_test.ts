import { assert, assertEquals } from "@std/assert";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  registeredWorker,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

function putFile(fixture: Fixture, path: string, content: string) {
  return Promise.resolve(fixture.app.fetch(
    new Request(`${fixture.config.publicBaseUrl}/v1/storage/files`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: fixture.config.publicBaseUrl,
        "Bakery-Organization-Id": fixture.organizationId,
        Cookie: fixture.adminCookie,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        path,
        mediaType: "text/plain",
        content: btoa(content),
      }),
    }),
  ));
}

Deno.test("an agent's file search shows only files its step's grants cover", () =>
  withWorkerFixture(async (fixture) => {
    const stored = await putFile(
      fixture,
      "/shared/needle-report.txt",
      "the needle",
    );
    assertEquals(stored.ok, true, await stored.clone().text());
    await stored.body?.cancel();
    const folder = await fixture.pgDatabase.query<{ id: string }>(
      `select id from bakery.storage_entries
        where organization_id = $1 and system_key = 'shared'`,
      [fixture.organizationId],
    );
    const folderId = folder.rows[0]!.id;
    const worker = await registeredWorker(fixture, {
      name: "file-search",
      slots: 1,
    });
    const job = await seedEligibleNonmodelJob(
      fixture.pgDatabase,
      fixture.organizationId,
      fixture.principalId,
    );
    const assignment = await claimAssignment(fixture, worker) as
      & Awaited<ReturnType<typeof claimAssignment>>
      & { sessionCredential?: string };
    const token = assignment.sessionCredential;
    assert(token);
    await fixture.pgDatabase.query(
      `update bakery.session_operation_credentials
          set scopes = array(select scope from unnest(scopes) as scope where scope not like 'files.read:%')
        where organization_id = $1 and attempt_id = $2`,
      [fixture.organizationId, assignment.attemptId],
    );
    for (let index = 0; index < 201; index++) {
      const refusedFile = await putFile(
        fixture,
        `/users/${fixture.principalId}/uploads/needle-${index}.txt`,
        "a refused needle",
      );
      assertEquals(refusedFile.ok, true, await refusedFile.clone().text());
      await refusedFile.body?.cancel();
    }
    const search = async (limit?: number) => {
      const response = await workerRequest(
        fixture,
        worker.credential,
        "/v1/session/call",
        {
          tool: "files.search",
          arguments: {
            query: "needle",
            ...(limit === undefined ? {} : { limit }),
          },
        },
        { headers: { "x-session-credential": token } },
      );
      const text = await response.text();
      const body = JSON.parse(text) as {
        result?: { items?: { name: string }[]; nextCursor?: string | null };
      };
      return {
        status: response.status,
        text,
        names: (body.result?.items ?? []).map((item) => item.name),
        nextCursor: body.result?.nextCursor ?? null,
      };
    };
    const before = await search();
    assertEquals(before.status, 200, before.text);
    assertEquals([before.names, before.nextCursor], [[], null]);
    await fixture.pgDatabase.query(
      `insert into bakery.agent_file_grants
         (organization_id, workflow_id, folder_id, access, granted_by, expires_at)
       values ($1, $2, $3, 'read', $4, now() + interval '1 hour')`,
      [fixture.organizationId, job.workflowId, folderId, fixture.principalId],
    );
    const after = await search();
    assertEquals([after.status, after.names], [200, ["needle-report.txt"]]);
    const single = await search(1);
    assertEquals(
      [single.status, single.names, single.nextCursor],
      [200, ["needle-report.txt"], null],
      single.text,
    );
    const recorded = await fixture.pgDatabase.query<{ name: string }>(
      `select e.name from bakery.step_read_set r
         join bakery.storage_entries e
           on e.organization_id = r.organization_id and e.id = r.entry_id
        where r.organization_id = $1 and r.attempt_id = $2
          and r.version_id is null and r.artifact_version_id is null`,
      [fixture.organizationId, assignment.attemptId],
    );
    assertEquals(
      recorded.rows.map((row) => row.name),
      ["needle-report.txt", "needle-report.txt"],
      "each search that showed the file is on the step; refused files are not",
    );
  }));
