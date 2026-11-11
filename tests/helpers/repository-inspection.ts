import { Hono } from "hono";
import { assertEquals } from "@std/assert";
import { createApiRouter } from "../../packages/contracts/src/http.ts";
import {
  contractSchemas,
  principalId,
} from "../../packages/contracts/src/contracts.ts";
import {
  type RepositoryInspectionJobInput,
  RepositoryInspectionJobInputSchema,
  type RepositoryInspectionReceipt,
  type RepositoryInspectionReport,
  RepositoryInspectionReportSchema,
  RepositoryInspectionSourceChunkSchema,
} from "../../packages/contracts/src/repository-inspection.ts";
import type { PgDatabase } from "../../apps/server/src/platform/database.ts";
import { PostgresAuthorityRunner } from "../../apps/server/src/modules/auth/adapters/authority-postgres.ts";
import { createPostgresCommandRunner } from "../../apps/server/src/platform/command-replay.ts";
import {
  createProjectsActionRegistry,
  createProjectsHandlers,
} from "../../apps/server/src/modules/projects/index.ts";
import { createTaskActionRegistry } from "../../apps/server/src/task-actions.ts";
import { createWorkTaskHandlers } from "../../apps/server/src/modules/work/index.ts";
import { createExecutionRoutes } from "../../apps/server/src/modules/execution/routes.ts";
import {
  createExecutionControlApp,
  createExecutionWorkerCleanupApp,
} from "../../apps/server/src/modules/execution/control.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { workerCredential } from "./worker-execution.ts";

type InspectionScope = { organizationId: string; principalId: string };
type Assignment = {
  jobId: string;
  attemptId: string;
  leaseToken: string;
  fence: string;
  action: string;
  input: unknown;
};
type Registration = {
  workerHostId: string;
  workerSessionId: string;
  workerSessionGeneration: string;
};
const mappingEnvironment = "BAKERY_TRUSTED_REPOSITORIES_JSON";

async function git(args: string[], cwd?: string): Promise<string> {
  const output = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).output();
  assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
  return new TextDecoder().decode(output.stdout).trim();
}

// Uses the caller's isolated migrated PostgreSQL database and the same injected
// human principal convention as the Projects fixtures. Worker authority is real
// enrollment, credential, heartbeat, claim, session and fenced lease authority.
export async function openRepositoryInspectionHarness(
  databases: { authDb: PgDatabase; appPg: PgDatabase },
  scope: InspectionScope,
  options: { os?: "linux" | "macos" } = {},
) {
  const os = options.os ?? "linux";
  const principal = {
    principalId: principalId(scope.principalId),
    principalType: "human" as const,
    displayName: "Inspection Admin",
  };
  const app = new Hono();
  const executionOptions: Parameters<typeof createExecutionRoutes>[0] = {
    database: databases.appPg,
    publicBaseUrl: "http://inspection.test",
    secret: "issue46-inspection-regression-secret",
    browserSession: async (context, next) => {
      context.set("principal", principal);
      await next();
    },
  };
  app.route("/", createExecutionRoutes(executionOptions));
  app.route("/", createExecutionControlApp(executionOptions));
  app.route("/", createExecutionWorkerCleanupApp(executionOptions));
  const actionOptions = {
    authorityRunner: new PostgresAuthorityRunner(databases.appPg),
    commandRunner: createPostgresCommandRunner(),
  };
  app.route(
    "/",
    createApiRouter({
      registry: createProjectsActionRegistry(
        createProjectsHandlers("issue46-inspection-regression-secret"),
        actionOptions,
      ),
      createContext: () => ({ principal }),
    }),
  );
  app.route(
    "/",
    createApiRouter({
      registry: createTaskActionRegistry(
        createWorkTaskHandlers("issue46-inspection-regression-secret"),
        actionOptions,
      ),
      createContext: () => ({ principal }),
    }),
  );
  const memberRequest = (
    method: string,
    path: string,
    body?: unknown,
    organizationId = scope.organizationId,
    headers: Record<string, string> = {},
  ) =>
    app.fetch(
      new Request(`http://inspection.test${path}`, {
        method,
        headers: {
          "Bakery-Organization-Id": organizationId,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(method === "GET"
            ? {}
            : { "Idempotency-Key": crypto.randomUUID() }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const root = await Deno.makeTempDir({ prefix: "issue46-inspection-" });
  const priorMapping = Deno.env.get(mappingEnvironment);
  let registration: Registration;
  const credential = workerCredential();
  const mappings: Record<string, unknown>[] = [];
  const workerRequest = (
    path: string,
    body: Record<string, unknown>,
    idempotencyKey: string = crypto.randomUUID(),
  ) =>
    app.fetch(
      new Request(`http://inspection.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Authorization": `Bearer ${credential}`,
          "X-Bakery-Worker-Protocol-Version": "2",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          workerSessionId: registration.workerSessionId,
          workerSessionGeneration: registration.workerSessionGeneration,
          ...body,
        }),
      }),
    );
  try {
    const name = `inspection-${crypto.randomUUID()}`;
    const enrollment = await memberRequest("POST", "/v1/worker-enrollments", {
      name,
      os,
      architecture: "x64",
      capabilities: ["git"],
      slots: 1,
    });
    assertEquals(enrollment.status, 201);
    const enrollmentBody = await enrollment.json() as {
      enrollmentToken: string;
    };
    const registered = await app.fetch(
      new Request("http://inspection.test/v1/worker/registration", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Bakery-Worker-Protocol-Version": "2",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          enrollmentToken: enrollmentBody.enrollmentToken,
          workerCredential: credential,
          name,
          os,
          architecture: "x64",
          capabilities: ["git"],
          toolchainVersions: {},
          slots: 1,
        }),
      }),
    );
    assertEquals(registered.status, 200);
    registration = await registered.json() as Registration;
    const heartbeat = await workerRequest("/v1/worker/heartbeat", {
      workerHostId: registration.workerHostId,
      observedAt: new Date().toISOString(),
      load: 0,
      activeAttemptIds: [],
      ackCommandIds: [],
      rejectedCommandIds: [],
      workerSessionId: crypto.randomUUID(),
      workerSessionGeneration: "0",
    });
    assertEquals(heartbeat.status, 200);
    const session = await heartbeat.json() as Registration;
    registration.workerSessionId = session.workerSessionId;
    registration.workerSessionGeneration = session.workerSessionGeneration;
  } catch (error) {
    await Deno.remove(root, { recursive: true });
    throw error;
  }
  return {
    ...scope,
    app,
    credential,
    registration,
    memberRequest,
    workerRequest,
    async createRepository(
      requireNode = false,
      options: {
        profileConfig?: Record<string, unknown>;
        profileHeaders?: Record<string, string>;
      } = {},
    ) {
      const slug = `inspection-${crypto.randomUUID()}`;
      const applicationResponse = await memberRequest(
        "POST",
        "/v1/applications",
        { slug, name: slug, description: "" },
      );
      assertEquals(applicationResponse.status, 201);
      const application = await applicationResponse.json() as { id: string };
      const repositoryResponse = await memberRequest(
        "POST",
        "/v1/repositories",
        {
          applicationId: application.id,
          slug,
          integrationConnectionId: crypto.randomUUID(),
          providerRepoId: slug,
          owner: "inspection",
          name: slug,
          defaultBranch: "main",
        },
      );
      assertEquals(repositoryResponse.status, 201);
      const repository = await repositoryResponse.json() as { id: string };
      const config = options.profileConfig ?? {
        schemaVersion: 1,
        workflow: { kind: "fixed" },
        branches: { base: "main", allowedPatterns: ["feature/*"] },
        worktree: { root: ".bakery/worktrees" },
      };
      const profileResponse = await memberRequest(
        "POST",
        `/v1/repositories/${repository.id}/profiles`,
        { revision: 1, config, digest: await sha256Hex(canonicalJson(config)) },
        scope.organizationId,
        options.profileHeaders,
      );
      assertEquals(
        profileResponse.status,
        201,
        await profileResponse.clone().text(),
      );
      const profile = await profileResponse.json() as { id: string };
      const work = `${root}/${repository.id}`;
      const bareRepositoryPath = `${root}/${repository.id}.git`;
      await Deno.mkdir(work);
      await git(["init", "--initial-branch=main"], work);
      await git(["config", "user.name", "Inspection Fixture"], work);
      await git(["config", "user.email", "inspection@example.test"], work);
      await Deno.writeTextFile(
        `${work}/README.md`,
        "Immutable inspection fixture\n",
      );
      if (requireNode) {
        await Deno.writeTextFile(
          `${work}/package.json`,
          JSON.stringify({ scripts: { check: "node --check index.js" } }),
        );
        await Deno.writeTextFile(`${work}/index.js`, "const answer = 42;\n");
      }
      await git(["add", "."], work);
      await git(["commit", "-m", "inspection fixture"], work);
      const snapshotSha = await git(["rev-parse", "HEAD"], work);
      await git(["clone", "--bare", work, bareRepositoryPath]);
      const material = {
        organizationId: scope.organizationId,
        applicationId: application.id,
        repositoryUuid: repository.id,
        bareRepositoryPath,
        mappingRevision: "issue46-regression-1",
        snapshotSha,
        status: "active",
      };
      mappings.push({
        ...material,
        mappingDigest: await sha256Hex(canonicalJson(material)),
      });
      Deno.env.set(
        mappingEnvironment,
        JSON.stringify({ schemaVersion: 1, entries: mappings }),
      );
      return {
        applicationId: application.id,
        repositoryId: repository.id,
        baselineProfileId: profile.id,
        snapshotSha,
        config,
      };
    },
    async onboard(repositoryId: string) {
      const response = await memberRequest(
        "POST",
        `/v1/repositories/${repositoryId}/onboarding-runs`,
        {},
      );
      assertEquals(response.status, 201);
      return contractSchemas.RepositoryOnboarding.parse(await response.json());
    },
    async claim(supportedActions = ["repository.inspect"]): Promise<Response> {
      const claimKey = crypto.randomUUID();
      return await workerRequest("/v1/worker/claims", {
        claimKey,
        workerHostId: registration.workerHostId,
        capabilities: ["git"],
        supportedActions,
      }, claimKey);
    },
    async start(assignment: Assignment) {
      const eventId = crypto.randomUUID();
      const response = await workerRequest(
        `/v1/worker/attempts/${assignment.attemptId}/events`,
        {
          leaseToken: assignment.leaseToken,
          fence: assignment.fence,
          events: [{
            eventId,
            localSeq: "1",
            eventType: "job.started",
            payload: {
              startedAt: new Date().toISOString(),
              workspaceId: crypto.randomUUID(),
            },
          }],
        },
        eventId,
      );
      assertEquals(response.status, 200);
    },
    source(
      assignment: Assignment,
      offset = 0,
      maxBytes = 32768,
      overrides: Record<string, string> = {},
    ) {
      return app.fetch(
        new Request(
          `http://inspection.test/v1/job-attempts/${assignment.attemptId}/repository-source?offset=${offset}&maxBytes=${maxBytes}`,
          {
            headers: {
              "Authorization": `Bearer ${credential}`,
              "X-Bakery-Worker-Protocol-Version": "2",
              "X-Worker-Lease-Token": assignment.leaseToken,
              "X-Worker-Fence": assignment.fence,
              "X-Worker-Session-Id": registration.workerSessionId,
              "X-Worker-Session-Generation":
                registration.workerSessionGeneration,
              ...overrides,
            },
          },
        ),
      );
    },
    async report(
      input: RepositoryInspectionJobInput,
      receipt: RepositoryInspectionReceipt,
    ): Promise<RepositoryInspectionReport> {
      const version = await git(["--version"]);
      const outputDigest = await sha256Hex(`${version}\n`);
      const policy = input.profile.config.checkPolicy;
      const now = new Date().toISOString();
      return RepositoryInspectionReportSchema.parse({
        input,
        receipt,
        host: {
          workerHostId: registration.workerHostId,
          os,
          architecture: "x64",
          tools: policy.tools.map(({ tool }) =>
            tool === "git"
              ? { tool, status: "available", version, outputDigest }
              : { tool, status: "missing", version: null, outputDigest: null }
          ),
        },
        checks: policy.checks.map((check) => ({
          id: check.id,
          template: check.template,
          required: check.required,
          durationMs: 0,
          ...(check.template === "source.integrity.v1"
            ? {
              status: "passed",
              reason: "verified",
              exitCode: null,
              outputDigest: input.source.manifestDigest,
            }
            : check.template === "unsupported.v1"
            ? {
              status: "unsupported",
              reason: "unsupported_command",
              exitCode: null,
              outputDigest: null,
            }
            : check.tool === "git"
            ? {
              status: "passed",
              reason: "verified",
              exitCode: 0,
              outputDigest,
            }
            : {
              status: "missing",
              reason: "tool_missing",
              exitCode: null,
              outputDigest: null,
            }),
        })),
        startedAt: now,
        completedAt: now,
      });
    },
    result(
      assignment: Assignment,
      report: unknown,
      options: { localSeq?: string; fence?: string; key?: string } = {},
    ) {
      return workerRequest(
        `/v1/worker/attempts/${assignment.attemptId}/result`,
        {
          leaseToken: assignment.leaseToken,
          fence: options.fence ?? assignment.fence,
          localSeq: options.localSeq ?? "2",
          status: "completed",
          result: report,
        },
        options.key,
      );
    },
    async snapshot(repositoryId: string, jobId: string) {
      const result = await databases.authDb.query(
        `select r.active_profile_id, r.version,
          (select jsonb_agg(jsonb_build_object('id', p.id, 'revision', p.revision, 'digest', p.digest, 'config', p.config) order by p.revision) from bakery.repository_profiles p where p.organization_id = r.organization_id and p.repository_id = r.id) as profiles,
          (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'digest', o.observation_digest, 'payload', o.payload) order by o.id), '[]'::jsonb) from bakery.repository_profile_observations o where o.organization_id = r.organization_id and o.repository_id = r.id) as observations,
          j.status as job_status, j.current_fence::text,
          (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'status', a.status, 'result', a.result, 'seq', a.last_event_seq::text) order by a.id), '[]'::jsonb) from bakery.job_attempts a where a.organization_id = j.organization_id and a.job_id = j.id) as attempts,
          (select coalesce(jsonb_agg(jsonb_build_object('type', e.event_type, 'payload', e.payload) order by e.local_seq), '[]'::jsonb) from bakery.attempt_events e join bakery.job_attempts a on a.organization_id = e.organization_id and a.id = e.attempt_id where a.organization_id = j.organization_id and a.job_id = j.id) as events,
          n.published_profile_id, n.observation_id, n.source_attempt_id, n.source_next_offset
         from bakery.repositories r join bakery.jobs j on j.organization_id = r.organization_id and j.repository_id = r.id
         left join bakery.repository_onboardings n on n.organization_id = j.organization_id and n.job_id = j.id
         where r.organization_id = $1 and r.id = $2 and j.id = $3`,
        [scope.organizationId, repositoryId, jobId],
      );
      assertEquals(result.rows.length, 1);
      return result.rows[0];
    },
    async close() {
      if (priorMapping === undefined) Deno.env.delete(mappingEnvironment);
      else Deno.env.set(mappingEnvironment, priorMapping);
      await Deno.remove(root, { recursive: true });
    },
  };
}

export type RepositoryInspectionAssignment = Assignment;

export async function readInspectionAssignment(
  response: Response,
): Promise<Assignment & { input: RepositoryInspectionJobInput }> {
  assertEquals(response.status, 200);
  const value = await response.json() as Assignment;
  return {
    ...value,
    input: RepositoryInspectionJobInputSchema.parse(value.input),
  };
}

export async function receiveInspectionSource(
  harness: {
    source(
      assignment: Assignment,
      offset?: number,
    ): Response | Promise<Response>;
  },
  assignment: Assignment & { input: RepositoryInspectionJobInput },
) {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let receipt: RepositoryInspectionReceipt | undefined;
  while (offset < assignment.input.source.envelopeBytes) {
    const response = await harness.source(assignment, offset);
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("Cache-Control"), "no-store");
    const chunk = RepositoryInspectionSourceChunkSchema.parse(
      await response.json(),
    );
    const bytes = Uint8Array.from(
      atob(chunk.bytesBase64),
      (character) => character.charCodeAt(0),
    );
    assertEquals(chunk.offset, offset);
    assertEquals(chunk.totalBytes, assignment.input.source.envelopeBytes);
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    assertEquals(digest, chunk.chunkDigest);
    if (receipt) assertEquals(chunk.receipt, receipt);
    receipt = chunk.receipt;
    chunks.push(bytes);
    offset += bytes.length;
    assertEquals(chunk.done, offset === chunk.totalBytes);
  }
  assertEquals(receipt !== undefined, true);
  const bytes = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }
  assertEquals(
    await sha256Hex(new TextDecoder().decode(bytes)),
    assignment.input.source.envelopeDigest,
  );
  return receipt!;
}
