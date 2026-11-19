import { assert, assertEquals } from "@std/assert";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { seedOrganization } from "../helpers/coordinator-turns.ts";
import {
  agentToken,
  countRows,
  currentDraft,
  factsFor,
  json,
  PROPOSED,
  publish,
  PUBLISHABLE,
  readProposal,
  refusal,
  seedWaitingProposal,
  seedWorkflowDraft,
  send,
  withFixture,
} from "../helpers/definition-authoring.ts";
import { FIXED_CODING_PRESET } from "../../packages/contracts/src/workflow-presets.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import {
  apiCall,
  createPresetTask,
  expectJson,
  presetBudgetEnv,
  seedFundedCodingAgent,
  seedPresetRepository,
} from "../helpers/fixed-coding-preset.ts";

// Issue #421, QA test plan comment 6904898662: sections 1 (the disciplines on
// the kind that has drafts) and 4 (reconciliation on the version path).
// Agents, artifact kinds and skills have no draft model (see the unit parity
// table), so these run on workflows.

type Version = {
  id: string;
  status: string;
  normalizedSpec: unknown;
  digest: string;
};

Deno.test("1.1-1.5: publish locks, requires If-Match, refuses stale validation, transitions the draft and names the actor", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "parity", { role: "admin" });
    const agent = await agentToken(fixture, seed);
    const person = { seed };
    const asAgent = { seed, agent };

    // An agent authors a draft by default (chapter 25 section 11).
    const { workflowId, draft } = await seedWorkflowDraft(
      fixture,
      asAgent,
      "parity-flow",
    );
    const edited = await json<{ id: string; version: number; digest: string }>(
      await send(
        fixture,
        asAgent,
        "PATCH",
        `/v1/workflows/${workflowId}/versions/${draft.id}`,
        { body: { definition: PUBLISHABLE }, ifMatch: draft.version },
      ),
      200,
    );
    assertEquals(
      (await send(fixture, asAgent, "POST", "/v1/workflow-validations", {
        body: { definition: PUBLISHABLE },
      })).status,
      200,
    );

    // 1.5 O50: the agent's draft edit is recorded as an agent's action.
    const editAudit = await fixture.pgDatabase.query<
      { principal_id: string; details: Record<string, unknown> }
    >(
      `select principal_id, details from bakery.audit_events
        where organization_id = $1 and resource_id = $2
          and operation = 'workflowVersions.update'`,
      [seed.organizationId, draft.id],
    );
    assertEquals(editAudit.rows.length, 1);
    assertEquals(editAudit.rows[0].principal_id, agent.principalId);
    assertEquals(editAudit.rows[0].details.actorKind, "agent");
    assertEquals(editAudit.rows[0].details.accessTokenId, agent.tokenId);

    // 1.2 If-Match is required, and a stale one is refused.
    const path = `/v1/workflows/${workflowId}/versions/${edited.id}/publish`;
    assertEquals(
      (await send(fixture, person, "POST", path, { body: {} })).status,
      428,
    );
    assertEquals(
      (await send(fixture, person, "POST", path, {
        body: {},
        ifMatch: edited.version + 4,
      })).status,
      412,
    );
    // 1.3 A digest that no longer matches the draft is validation_stale.
    const stale = await send(fixture, person, "POST", path, {
      body: { expectedDigest: "0".repeat(64) },
      ifMatch: edited.version,
    });
    const staleBody = await stale.text();
    assertEquals(stale.status, 409, staleBody);
    assertEquals(JSON.parse(staleBody).reason, "validation_stale");
    assertEquals(
      await countRows(
        fixture,
        `select count(*)::text as count from bakery.workflow_versions
          where organization_id = $1 and workflow_id = $2`,
        [seed.organizationId, workflowId],
      ),
      0,
    );

    // 1.4 Publish is a transition: the version takes the draft's id and the
    // draft row is gone; never both, never neither.
    const published = await json<Version>(
      await publish(fixture, person, workflowId, edited, {
        expectedDigest: edited.digest,
      }),
      200,
    );
    assertEquals(published.id, edited.id);
    assertEquals(published.status, "published");
    assertEquals(
      await countRows(
        fixture,
        `select count(*)::text as count from bakery.workflow_drafts
          where organization_id = $1 and workflow_id = $2`,
        [seed.organizationId, workflowId],
      ),
      0,
    );
    // 1.5 The person's publish is labelled as a person's action.
    const publishAudit = await fixture.pgDatabase.query<
      { principal_id: string; details: Record<string, unknown> }
    >(
      `select principal_id, details from bakery.audit_events
        where organization_id = $1 and resource_id = $2
          and operation = 'workflowVersions.publish'`,
      [seed.organizationId, edited.id],
    );
    assertEquals(publishAudit.rows.length, 1);
    assertEquals(publishAudit.rows[0].principal_id, seed.principalId);
    assertEquals(publishAudit.rows[0].details.actorKind, "person");
  }));

Deno.test("4.14: publishing a draft settles each proposal waiting on it as superseded, naming the version", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "supersede", {
      role: "admin",
    });
    const person = { seed };
    const { workflowId, draft, proposal } = await seedWaitingProposal(
      fixture,
      seed,
    );

    const published = await json<Version>(
      await publish(fixture, person, workflowId, draft),
      200,
    );
    // The version holds the draft's content, not the proposal's.
    assertEquals(published.normalizedSpec, PUBLISHABLE);

    // The proposal is settled, names the version, and still exists.
    const settled = await readProposal(fixture, seed, proposal.id);
    assertEquals(settled.state, "superseded");
    assertEquals(settled.supersededByVersionId, published.id);
    assertEquals(settled.decidedBy, null);
    assertEquals(settled.version, proposal.version + 1);
    const facts = await factsFor(fixture, seed.organizationId, proposal.id);
    assert(
      facts.audits.includes("workflowDefinitionProposals.supersede"),
      JSON.stringify(facts),
    );
    assert(
      facts.events.includes("workflowDefinitionProposal.superseded"),
      JSON.stringify(facts),
    );
    const record = await fixture.pgDatabase.query<
      { details: Record<string, unknown> }
    >(
      `select details from bakery.audit_events
        where organization_id = $1 and resource_id = $2
          and operation = 'workflowDefinitionProposals.supersede'`,
      [seed.organizationId, proposal.id],
    );
    assertEquals(record.rows[0].details.supersededByVersionId, published.id);

    // A superseded proposal cannot be decided afterwards.
    const late = await send(
      fixture,
      person,
      "POST",
      `/v1/workflow-definition-proposals/${proposal.id}/decisions`,
      { body: { decision: "accept" }, ifMatch: settled.version },
    );
    const lateBody = await late.text();
    assertEquals(late.status, 409, lateBody);
    assertEquals(JSON.parse(lateBody).reason, "definition_proposal_superseded");
  }));

Deno.test("4.15 and 4.16: a rejected proposal never lands and the digest is the published content's", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "rejected", { role: "admin" });
    const person = { seed };
    const { workflowId, draft, proposal } = await seedWaitingProposal(
      fixture,
      seed,
    );
    const rejected = await json<{ state: string }>(
      await send(
        fixture,
        person,
        "POST",
        `/v1/workflow-definition-proposals/${proposal.id}/decisions`,
        { body: { decision: "reject" }, ifMatch: proposal.version },
      ),
      200,
    );
    assertEquals(rejected.state, "rejected");
    const published = await json<Version>(
      await publish(fixture, person, workflowId, draft),
      200,
    );
    assertEquals(published.normalizedSpec, PUBLISHABLE);
    assert(
      JSON.stringify(published.normalizedSpec) !== JSON.stringify(PROPOSED),
    );
    assertEquals(
      published.digest,
      await sha256Hex(canonicalJson(published.normalizedSpec)),
    );
    // A decided proposal is not touched by the publish.
    const after = await readProposal(fixture, seed, proposal.id);
    assertEquals(after.state, "rejected");
    assertEquals(after.supersededByVersionId, null);
  }));

Deno.test("4.18: Use this version points at a real, immutable version of this definition", () =>
  withFixture(async (fixture) => {
    const seed = await seedOrganization(fixture, "activate", { role: "admin" });
    const person = { seed };
    const first = await seedWorkflowDraft(fixture, person, "activate-one");
    const other = await seedWorkflowDraft(fixture, person, "activate-two");
    const v1 = await json<Version>(
      await publish(fixture, person, first.workflowId, first.draft),
      200,
    );
    const otherVersion = await json<Version>(
      await publish(fixture, person, other.workflowId, other.draft),
      200,
    );
    const definitionVersion = async () => (await json<
      { version: number; activeVersionId: string | null }
    >(
      await send(fixture, person, "GET", `/v1/workflows/${first.workflowId}`),
      200,
    ));
    const activate = async (versionId: string) =>
      await send(
        fixture,
        person,
        "POST",
        `/v1/workflows/${first.workflowId}/activations`,
        { body: { versionId }, ifMatch: (await definitionVersion()).version },
      );
    // Another definition's version and an unknown one are not found.
    assertEquals((await refusal(await activate(otherVersion.id))).status, 404);
    assertEquals(
      (await refusal(await activate(crypto.randomUUID()))).status,
      404,
    );
    const active = await json<{ activeVersionId: string }>(
      await activate(v1.id),
      200,
    );
    assertEquals(active.activeVersionId, v1.id);
    // Publishing again leaves the activated version and its content alone.
    await json(
      await send(
        fixture,
        person,
        "POST",
        `/v1/workflows/${first.workflowId}/versions`,
        { body: { definition: PROPOSED } },
      ),
      201,
    );
    const next = await currentDraft(fixture, seed, first.workflowId);
    await json(await publish(fixture, person, first.workflowId, next), 200);
    const after = await definitionVersion();
    assertEquals(after.activeVersionId, v1.id);
    const reread = await json<Version>(
      await send(
        fixture,
        person,
        "GET",
        `/v1/workflows/${first.workflowId}/versions/${v1.id}`,
      ),
      200,
    );
    assertEquals(reread.normalizedSpec, PUBLISHABLE);
    assertEquals(reread.digest, v1.digest);
  }));

Deno.test("3.12: a run admitted on version N keeps N after a new version is published and used", () =>
  withWorkerFixture(async (fixture) => {
    const scope = fixture;
    const runnable = JSON.parse(JSON.stringify(FIXED_CODING_PRESET.spec));
    const agent = await seedFundedCodingAgent(fixture, scope, "pin");
    const repository = await seedPresetRepository(fixture.pgDatabase, scope, {
      agentVersionId: agent,
    });
    const workflow = await expectJson<{ id: string }>(
      await apiCall(fixture, scope, "POST", "/v1/workflows", {
        body: { slug: "pinned-flow", name: "Pinned", description: "" },
      }),
      201,
    );
    const publishDraft = async () => {
      const draft = await expectJson<{ id: string; version: number }>(
        await apiCall(
          fixture,
          scope,
          "POST",
          `/v1/workflows/${workflow.id}/versions`,
          { body: { definition: runnable } },
        ),
        201,
      );
      return await expectJson<{ id: string; digest: string }>(
        await apiCall(
          fixture,
          scope,
          "POST",
          `/v1/workflows/${workflow.id}/versions/${draft.id}/publish`,
          { body: {}, headers: { "If-Match": `"${draft.version}"` } },
        ),
        200,
      );
    };
    const use = async (versionId: string) => {
      const current = await expectJson<{ version: number }>(
        await apiCall(fixture, scope, "GET", `/v1/workflows/${workflow.id}`),
        200,
      );
      return await expectJson<{ activeVersionId: string }>(
        await apiCall(
          fixture,
          scope,
          "POST",
          `/v1/workflows/${workflow.id}/activations`,
          {
            body: { versionId },
            headers: { "If-Match": `"${current.version}"` },
          },
        ),
        200,
      );
    };
    const first = await publishDraft();
    await use(first.id);
    const task = await createPresetTask(fixture, scope, repository, {
      title: "Pinned run",
    });
    const run = await expectJson<{ id: string; workflowVersionId: string }>(
      await apiCall(fixture, scope, "POST", `/v1/tasks/${task.id}/runs`, {
        body: {
          workflowVersionId: first.id,
          executionMode: "repository",
          repositoryProfileId: repository.profileId,
          budgetLimitUsd: "5.00",
          inputs: {
            repositoryId: repository.repositoryId,
            brief: {
              title: "Pin",
              description: "Keep the pin.",
              taskType: "feature",
            },
            instructions: "Keep the pin.",
          },
        },
      }),
      201,
    );
    assertEquals(run.workflowVersionId, first.id);

    // A new version is published and made the one in use.
    const second = await publishDraft();
    assert(second.id !== first.id);
    assertEquals((await use(second.id)).activeVersionId, second.id);

    // The admitted run still names version N, and N is unchanged.
    const reread = await expectJson<{ workflowVersionId: string }>(
      await apiCall(fixture, scope, "GET", `/v1/runs/${run.id}`),
      200,
    );
    assertEquals(reread.workflowVersionId, first.id);
    const pinned = await expectJson<{ id: string; digest: string }>(
      await apiCall(
        fixture,
        scope,
        "GET",
        `/v1/workflows/${workflow.id}/versions/${first.id}`,
      ),
      200,
    );
    assertEquals(pinned.digest, first.digest);
    const stored = await fixture.pgDatabase.query<
      { workflow_version_id: string }
    >(
      `select workflow_version_id from bakery.workflow_runs
        where organization_id = $1 and id = $2`,
      [scope.organizationId, run.id],
    );
    assertEquals(stored.rows[0].workflow_version_id, first.id);
  }, { env: presetBudgetEnv }));

Deno.test("publishing a version stores its starts canonically, and an invalid start publishes nothing", () =>
  withFixture(async (fixture) => {
    // The unit cases prove the schema and the insert; this proves the path a
    // caller takes. Two mutants survived every PR test before it existed: the
    // insert binding "[]" instead of the draft's starts, and publish dropping
    // the parse. Both produce a published version that silently starts nothing.
    const seed = await seedOrganization(fixture, "starts", { role: "admin" });
    const person = { seed };
    const { workflowId, draft } = await seedWorkflowDraft(
      fixture,
      person,
      "starts-flow",
    );

    // Written directly, because starts are not a definition edit: they sit
    // beside the specification and no route authors them yet.
    const starts = [{
      id: "on-ready",
      on: {
        kind: "event",
        eventKind: "work_item.ready",
        filter: { state: "open" },
      },
    }];
    await fixture.pgDatabase.query(
      `update bakery.workflow_drafts set starts = $1::jsonb
        where organization_id = $2 and id = $3`,
      [JSON.stringify(starts), seed.organizationId, draft.id],
    );

    const published = await json<Version>(
      await publish(fixture, person, workflowId, draft, {
        expectedDigest: draft.digest,
      }),
      200,
    );
    const stored = await fixture.pgDatabase.query<
      { starts: unknown; digest: string; normalized_spec: unknown }
    >(
      `select starts, digest, normalized_spec from bakery.workflow_versions
        where organization_id = $1 and id = $2`,
      [seed.organizationId, published.id],
    );
    assertEquals(stored.rows.length, 1);
    // Canonical JSON text, not whatever key order the caller sent.
    assertEquals(
      stored.rows[0].starts,
      [{
        id: "on-ready",
        on: {
          eventKind: "work_item.ready",
          filter: { state: "open" },
          kind: "event",
        },
      }],
    );
    // Starts sit beside the specification, so publishing one moves no digest.
    assertEquals(stored.rows[0].digest, draft.digest);

    // An invalid start is refused on the way in, and nothing is published.
    const second = await seedWorkflowDraft(fixture, person, "starts-bad");
    await fixture.pgDatabase.query(
      `update bakery.workflow_drafts set starts = $1::jsonb
        where organization_id = $2 and id = $3`,
      [
        JSON.stringify([{
          id: "Not An Id",
          on: { kind: "event", eventKind: "", filter: {} },
        }]),
        seed.organizationId,
        second.draft.id,
      ],
    );
    const refusal = await publish(fixture, person, second.workflowId, {
      id: second.draft.id,
      version: second.draft.version,
    }, { expectedDigest: second.draft.digest });
    assert(
      refusal.status >= 400 && refusal.status < 500,
      `an invalid start is refused, not published: ${refusal.status}`,
    );
    assertEquals(
      await countRows(
        fixture,
        `select count(*)::text as count from bakery.workflow_versions
          where organization_id = $1 and workflow_id = $2`,
        [seed.organizationId, second.workflowId],
      ),
      0,
      "no version row is written for a refused start",
    );

    // The contract checks a schedule's shape, not that the clock can read it.
    // A version is immutable once published, so these must be refused at
    // publish rather than frozen into a version that fails at its first tick.
    for (
      const [index, reason, on] of [
        [
          1,
          "an expression the scheduler cannot read",
          { kind: "schedule", cron: "61 * * * *", timezone: "UTC" },
        ],
        [
          2,
          "a zone that is not a zone",
          { kind: "schedule", cron: "0 9 * * *", timezone: "Europe/Nowhere" },
        ],
      ] as const
    ) {
      const bad = await seedWorkflowDraft(
        fixture,
        person,
        `starts-bad-${index}`,
      );
      await fixture.pgDatabase.query(
        `update bakery.workflow_drafts set starts = $1::jsonb
          where organization_id = $2 and id = $3`,
        [
          JSON.stringify([{ id: "clock", on }]),
          seed.organizationId,
          bad.draft.id,
        ],
      );
      const refused = await publish(fixture, person, bad.workflowId, {
        id: bad.draft.id,
        version: bad.draft.version,
      }, { expectedDigest: bad.draft.digest });
      assert(
        refused.status >= 400 && refused.status < 500,
        `${reason} is refused: ${refused.status}`,
      );
      assertEquals(
        await countRows(
          fixture,
          `select count(*)::text as count from bakery.workflow_versions
            where organization_id = $1 and workflow_id = $2`,
          [seed.organizationId, bad.workflowId],
        ),
        0,
        `${reason} publishes nothing`,
      );
    }

    // A schedule the scheduler can read publishes, with the zone in its
    // canonical spelling so two versions naming one zone store the same text.
    const clock = await seedWorkflowDraft(fixture, person, "starts-clock");
    await fixture.pgDatabase.query(
      `update bakery.workflow_drafts set starts = $1::jsonb
        where organization_id = $2 and id = $3`,
      [
        JSON.stringify([{
          id: "clock",
          on: {
            kind: "schedule",
            cron: "0 9 * * *",
            timezone: "europe/london",
          },
        }]),
        seed.organizationId,
        clock.draft.id,
      ],
    );
    const scheduled = await json<Version>(
      await publish(fixture, person, clock.workflowId, clock.draft, {
        expectedDigest: clock.draft.digest,
      }),
      200,
    );
    const clockRow = await fixture.pgDatabase.query<{ starts: unknown }>(
      `select starts from bakery.workflow_versions
        where organization_id = $1 and id = $2`,
      [seed.organizationId, scheduled.id],
    );
    assertEquals(clockRow.rows[0].starts, [{
      id: "clock",
      on: { cron: "0 9 * * *", kind: "schedule", timezone: "Europe/London" },
    }]);
  }));
