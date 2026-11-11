import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "node:path";
import { agentVersionDigest } from "../../apps/server/src/modules/agents/postgres.ts";
import { SkillFileStore } from "../../apps/server/src/modules/catalog/storage.ts";
import { extractFixedWorkflowSteps } from "../../apps/server/src/modules/work/run-steps.ts";
import { createBakeryPostgresWorkflowRepository } from "../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import {
  createNativeExecutor,
  type NativeActionDefinition,
} from "../../apps/worker/src/executor.ts";
import { main as workerMain } from "../../apps/worker/src/main.ts";
import { RegistrationStore } from "../../apps/worker/src/registration.ts";
import { EventSpool } from "../../apps/worker/src/spool.ts";
import { provisionDelegatedCgroupV2 } from "../../scripts/lib/cgroup-v2.ts";
import { bindLoopbackPortWithRetry } from "../fixtures/loopback-port-allocation.ts";
import {
  closeWorkerFixture,
  openWorkerFixture,
  readExecutionState,
  registeredWorker,
  type WorkerFixture,
} from "../helpers/worker-execution.ts";
import { supervisorConfig } from "../helpers/worker-execution/recovery-support.ts";

const encoder = new TextEncoder();

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function waitFor<T>(
  read: () => Promise<T | null>,
  code: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(code);
}

type NativeObservation = Readonly<{
  pid: number;
  cgroup: string;
  roots: readonly string[];
  rootPath: string;
  entryPath: string;
  entryDigest: string;
  executableDigest: string;
  mutationRejected: boolean;
  rootMode: number;
  entryMode: number;
  executableMode: number;
  entryDevice: string;
  entryInode: string;
  entryLinks: number;
}>;

async function nativeObservation(
  fixture: WorkerFixture,
  jobId: string,
): Promise<NativeObservation | null> {
  const stream = (await fixture.pgDatabase.query<{
    id: string;
    closed: boolean;
  }>(
    `select id,closed
       from bakery.session_output_streams
      where organization_id=$1 and job_id=$2`,
    [fixture.organizationId, jobId],
  )).rows[0];
  if (!stream?.closed) return null;
  const batches = (await fixture.pgDatabase.query<{
    payload: { parts: Array<{ channel: string; text: string }> };
  }>(
    `select payload
       from bakery.session_output_batches
      where organization_id=$1 and session_id=$2
      order by sequence`,
    [fixture.organizationId, stream.id],
  )).rows;
  const text = batches.flatMap((row) => row.payload.parts).filter((part) =>
    part.channel === "stdout"
  ).map((part) => part.text).join("");
  return text.length === 0 ? null : JSON.parse(text) as NativeObservation;
}

async function waitForTerminal(fixture: WorkerFixture, jobId: string) {
  return await waitFor(async () => {
    const state = await readExecutionState(fixture.pgDatabase, jobId);
    return ["completed", "failed", "canceled"].includes(state.job.status)
      ? state
      : null;
  }, `ISSUE279_JOB_TERMINAL_TIMEOUT:${jobId}`);
}

function nativeObservationAction(): NativeActionDefinition {
  const script = `
const roots = JSON.parse(Deno.env.get("BAKERY_WORKER_SKILL_ROOTS") ?? "[]");
if (roots.length !== 1) throw new Error("ISSUE279_EXACT_ROOT_REQUIRED");
const rootPath = roots[0];
const entryPath = rootPath + "/SKILL.md";
const executablePath = rootPath + "/bin/run.sh";
const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
const entryBytes = await Deno.readFile(entryPath);
const executableBytes = await Deno.readFile(executablePath);
let mutationRejected = false;
const mutation = new TextEncoder().encode("attempt-private-mutation\\n");
try {
  await Deno.writeFile(entryPath, mutation);
} catch {
  mutationRejected = true;
}
const root = await Deno.lstat(rootPath);
const entry = await Deno.lstat(entryPath);
const executable = await Deno.lstat(executablePath);
const observation = {
  pid: Deno.pid,
  cgroup: await Deno.readTextFile("/proc/self/cgroup"),
  roots,
  rootPath,
  entryPath,
  entryDigest: await digest(entryBytes),
  executableDigest: await digest(executableBytes),
  mutationRejected,
  rootMode: root.mode & 511,
  entryMode: entry.mode & 511,
  executableMode: executable.mode & 511,
  entryDevice: String(entry.dev),
  entryInode: String(entry.ino),
  entryLinks: entry.nlink,
};
await Deno.stdout.write(new TextEncoder().encode(JSON.stringify(observation)));
`;
  return {
    action: "quality.check",
    executable: Deno.execPath(),
    args: ["eval", script],
  };
}

async function committedTree(stateDir: string): Promise<string> {
  const root = join(stateDir, "skill-materialization-v1");
  const commits = [...Deno.readDirSync(join(root, "commits"))];
  assertEquals(commits.length, 1);
  const record = JSON.parse(
    await Deno.readTextFile(join(root, "commits", commits[0].name)),
  ) as { keyHash: string; stageId: string };
  return join(root, "objects", record.keyHash, record.stageId, "tree");
}

Deno.test("authenticated pins reach the real supervisor and native cgroup child", async () => {
  const skillRoot = await Deno.makeTempDir({ prefix: "bakery-279-store-" });
  const stateDir = await Deno.makeTempDir({ prefix: "bakery-279-worker-" });
  const realStore = new SkillFileStore(skillRoot);
  let objectReads = 0;
  const store = {
    recover: realStore.recover.bind(realStore),
    putIfAbsent: realStore.putIfAbsent.bind(realStore),
    read: async (key: string, digest: string, size: number) => {
      objectReads += 1;
      return await realStore.read(key, digest, size);
    },
  };
  const fixture = await openWorkerFixture({
    skillFileRoot: skillRoot,
    skillFileStore: store,
  });
  const allocated = new Set<number>();
  let server: Deno.HttpServer | undefined;
  let serverUrl = "";
  let manifestReads = 0;
  let sourceId = "";
  let revokeAtManifest = 0;
  const requestOrder: string[] = [];
  const cgroup = await provisionDelegatedCgroupV2(
    "bakery-279-materialization-",
  ).catch((error) => {
    const code = error instanceof Error ? error.message : String(error);
    console.error(
      `ISSUE279_NATIVE_PREREQUISITE_UNAVAILABLE:${code}:requires delegated cgroup v2 memory+pids controllers and writable cgroup.kill`,
    );
    throw error;
  });
  let supervisor: { requestStop(reason?: string): void } | undefined;
  let run: Promise<void> | undefined;
  try {
    const port = await bindLoopbackPortWithRetry({
      allocated,
      bind: async (candidate) => {
        const listening = Promise.withResolvers<void>();
        server = Deno.serve({
          hostname: "127.0.0.1",
          port: candidate,
          onListen() {
            listening.resolve();
          },
        }, async (request) => {
          const incoming = new URL(request.url);
          const isManifest = /^\/v1\/skill-versions\/[^/]+$/.test(
            incoming.pathname,
          );
          const isFile = incoming.pathname.includes("/files/");
          if (isManifest) {
            manifestReads += 1;
            requestOrder.push(`manifest:${manifestReads}`);
            if (
              revokeAtManifest === manifestReads && sourceId.length > 0
            ) {
              await fixture.pgDatabase.query(
                "update bakery.skill_sources set enabled = false where id = $1",
                [sourceId],
              );
            }
          } else if (isFile) {
            requestOrder.push(`file:${decodeURIComponent(incoming.pathname)}`);
          }
          const target = new URL(
            `${incoming.pathname}${incoming.search}`,
            fixture.config.publicBaseUrl,
          );
          return await fixture.app.fetch(new Request(target, request));
        });
        await listening.promise;
        serverUrl = `http://127.0.0.1:${candidate}`;
      },
      cleanupOwnedAttempt: async () => {
        await server?.shutdown().catch(() => undefined);
        server = undefined;
      },
    });
    assertEquals(serverUrl, `http://127.0.0.1:${port}`);

    const markdown = encoder.encode("# exact native worker skill\n");
    const executable = encoder.encode("#!/bin/sh\nprintf ready\\n\n");
    const markdownDigest = await sha256(markdown);
    const executableDigest = await sha256(executable);
    const manifest = {
      schemaVersion: 1,
      license: "MIT",
      entryPath: "SKILL.md",
      files: [{
        path: "SKILL.md",
        mediaType: "text/markdown",
        sizeBytes: markdown.byteLength,
        sha256: markdownDigest,
        isExecutable: false,
      }, {
        path: "bin/run.sh",
        mediaType: "text/x-shellscript",
        sizeBytes: executable.byteLength,
        sha256: executableDigest,
        isExecutable: true,
      }],
    };
    const versionDigest = await sha256Hex(canonicalJson(manifest));
    const adminPost = (
      path: string,
      body: unknown,
      idempotencyKey: string = crypto.randomUUID(),
    ) =>
      fetch(`${serverUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: fixture.adminCookie,
          origin: fixture.config.publicBaseUrl,
          "Bakery-Organization-Id": fixture.organizationId,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });
    const create = await adminPost("/v1/skills", {
      slug: "issue279-native-materialization",
      name: "Issue 279 native materialization",
    });
    assertEquals(create.status, 201, await create.clone().text());
    const skill = await create.json() as { id: string; sourceId: string };
    sourceId = skill.sourceId;
    const publish = await adminPost(`/v1/skills/${skill.id}/versions`, {
      revision: 1,
      digest: versionDigest,
      entryPath: "SKILL.md",
      manifest,
      files: [{
        path: "SKILL.md",
        mediaType: "text/markdown",
        isExecutable: false,
        contentBase64: btoa(String.fromCharCode(...markdown)),
      }, {
        path: "bin/run.sh",
        mediaType: "text/x-shellscript",
        isExecutable: true,
        contentBase64: btoa(String.fromCharCode(...executable)),
      }],
    });
    assertEquals(publish.status, 201, await publish.clone().text());
    const version = await publish.json() as { id: string; digest: string };
    assertEquals(version.digest, versionDigest);

    const agentConfig = {
      harness: "pi",
      skillBindings: { native: version.id },
    };
    const createAgent = await adminPost("/v1/agents", {
      slug: "issue279-native-producer",
      name: "Issue 279 native producer",
      description: "Authenticated producer for native pinned skill proof.",
    });
    assertEquals(createAgent.status, 201, await createAgent.clone().text());
    const agent = await createAgent.json() as { id: string };
    const createAgentVersion = await adminPost(
      `/v1/agents/${agent.id}/versions`,
      {
        revision: 1,
        config: agentConfig,
        digest: await agentVersionDigest(agentConfig),
      },
    );
    assertEquals(
      createAgentVersion.status,
      201,
      await createAgentVersion.clone().text(),
    );
    const agentVersion = await createAgentVersion.json() as {
      id: string;
      revision: number;
      config: unknown;
      digest: string;
    };
    assertEquals(agentVersion.config, agentConfig);

    const applicationId = crypto.randomUUID();
    const repositoryId = crypto.randomUUID();
    const profileId = crypto.randomUUID();
    const replacementProfileId = crypto.randomUUID();
    const workflowId = crypto.randomUUID();
    const workflowVersionId = crypto.randomUUID();
    const profileConfig = {
      schemaVersion: 1,
      workflow: { kind: "fixed" },
      branches: { base: "main", allowedPatterns: ["feature/*"] },
      worktree: { root: ".bakery/worktrees" },
    };
    const profileDigest = await sha256Hex(canonicalJson(profileConfig));
    const workflowSpec = {
      apiVersion: "bakery.dev/v1",
      kind: "workflow",
      name: "issue279-authenticated-native-proof",
      workflow: { kind: "fixed" },
      agents: { "quality.check": agentVersion.id },
      steps: [{
        id: "quality",
        uses: "quality.check",
        with: { repositoryId, revision: "HEAD", checks: ["fmt"] },
      }],
    };
    assertEquals(extractFixedWorkflowSteps(workflowSpec, "fixed").length, 1);
    const workflowDigest = await sha256Hex(canonicalJson(workflowSpec));
    await fixture.pgDatabase.query(
      `insert into bakery.applications (
         id, organization_id, slug, name, description
       ) values ($1, $2, $3, 'Issue 279 native app', '')`,
      [applicationId, fixture.organizationId, `issue279-${applicationId}`],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.repositories (
         id, organization_id, application_id, integration_connection_id,
         provider_repo_id, owner, name, default_branch
       ) values ($1, $2, $3, $4, $5, 'bakery', 'issue279-native', 'main')`,
      [
        repositoryId,
        fixture.organizationId,
        applicationId,
        crypto.randomUUID(),
        `bakery/issue279-${repositoryId}`,
      ],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.repository_profiles (
         id, organization_id, application_id, repository_id, revision,
         config, digest, created_by
       ) values ($1, $2, $3, $4, 1, $5::jsonb, $6, $7)`,
      [
        profileId,
        fixture.organizationId,
        applicationId,
        repositoryId,
        JSON.stringify(profileConfig),
        profileDigest,
        fixture.principalId,
      ],
    );
    await fixture.pgDatabase.query(
      `update bakery.repositories set active_profile_id = $3
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, repositoryId, profileId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.workflow_definitions (
         id, organization_id, slug, name, description, enabled
       ) values ($1, $2, 'issue279-native-proof',
                 'Issue 279 native proof', '', true)`,
      [workflowId, fixture.organizationId],
    );
    await fixture.pgDatabase.query(
      `insert into bakery.workflow_versions (
         id, organization_id, workflow_id, revision, source_yaml,
         normalized_spec, digest, status, created_by
       ) values ($1, $2, $3, 1, '', $4::jsonb, $5, 'published', $6)`,
      [
        workflowVersionId,
        fixture.organizationId,
        workflowId,
        JSON.stringify(workflowSpec),
        workflowDigest,
        fixture.principalId,
      ],
    );
    await fixture.pgDatabase.query(
      `update bakery.workflow_definitions set active_version_id = $3
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, workflowId, workflowVersionId],
    );

    const workflowRepository = createBakeryPostgresWorkflowRepository({
      database: fixture.pgDatabase,
      maxAttempts: 3,
    });
    const submitRun = async (label: string) => {
      const conversationId = crypto.randomUUID();
      const taskId = crypto.randomUUID();
      await fixture.pgDatabase.query(
        `insert into bakery.conversations (
           id, organization_id, application_id, repository_id, title,
           created_by
         ) values ($1, $2, $3, $4, $5, $6)`,
        [
          conversationId,
          fixture.organizationId,
          applicationId,
          repositoryId,
          label,
          fixture.principalId,
        ],
      );
      await fixture.pgDatabase.query(
        `insert into bakery.tasks (
           id, organization_id, application_id, repository_id, conversation_id,
           title, description, task_type, status, priority, created_by,
           repository_profile_id, repository_profile_revision,
           repository_profile_digest
         ) values ($1, $2, $3, $4, $5, $6, '', 'feature', 'draft', 50,
                   $7, $8, 1, $9)`,
        [
          taskId,
          fixture.organizationId,
          applicationId,
          repositoryId,
          conversationId,
          label,
          fixture.principalId,
          profileId,
          profileDigest,
        ],
      );
      const requestBody = {
        workflowVersionId,
        executionMode: "repository",
        repositoryProfileId: profileId,
        inputs: {},
      };
      const idempotencyKey = `issue279-${label}-${crypto.randomUUID()}`;
      const response = await adminPost(
        `/v1/tasks/${taskId}/runs`,
        requestBody,
        idempotencyKey,
      );
      assertEquals(response.status, 201, await response.clone().text());
      const responseBody = await response.json() as { id: string };
      const frozen = await fixture.pgDatabase.query<{
        snapshot: {
          stepAgents: Record<string, {
            agentVersionId: string;
            revision: number;
            config: unknown;
            digest: string;
            skillRefs: unknown;
          }>;
        };
      }>(
        `select snapshot from bakery.workflow_runs
          where organization_id = $1 and id = $2`,
        [fixture.organizationId, responseBody.id],
      );
      assertEquals(frozen.rows[0]?.snapshot.stepAgents.quality, {
        agentVersionId: agentVersion.id,
        revision: agentVersion.revision,
        config: agentConfig,
        digest: agentVersion.digest,
        skillRefs: [{ versionId: version.id, digest: version.digest }],
      });
      return {
        runId: responseBody.id,
        taskId,
        requestBody,
        idempotencyKey,
        responseBody,
      };
    };
    const admitRun = async (runId: string) => {
      const key = {
        runId,
        stepKey: "quality",
        iteration: 0,
        actionVersion: workflowVersionId,
      };
      // Production workflow-engine repository driver. Fixture code does not
      // insert a job or write any agent/pin column.
      const admission = await workflowRepository.admit(key);
      assertExists(admission.jobId);
      const jobId = admission.jobId;
      const selected = await fixture.pgDatabase.query<{
        id: string;
        action: string;
        agent_version_id: string | null;
        agent_config: unknown;
        skill_refs: unknown;
      }>(
        `select id, action, agent_version_id, agent_config, skill_refs
           from bakery.jobs where organization_id = $1 and id = $2`,
        [fixture.organizationId, jobId],
      );
      assertEquals(selected.rows[0], {
        id: jobId,
        action: "quality.check",
        agent_version_id: agentVersion.id,
        agent_config: agentConfig,
        skill_refs: [{ versionId: version.id, digest: version.digest }],
      });
      const retry = await workflowRepository.admit(key);
      assertEquals(retry.jobId, jobId);
      const afterRetry = await fixture.pgDatabase.query<{
        agent_version_id: string | null;
        agent_config: unknown;
        skill_refs: unknown;
      }>(
        `select agent_version_id, agent_config, skill_refs
           from bakery.jobs where organization_id = $1 and id = $2`,
        [fixture.organizationId, jobId],
      );
      assertEquals(afterRetry.rows[0], {
        agent_version_id: agentVersion.id,
        agent_config: agentConfig,
        skill_refs: [{ versionId: version.id, digest: version.digest }],
      });
      return { jobId };
    };

    const coldRun = await submitRun("cold");
    const warmRun = await submitRun("warm");
    const revokedRun = await submitRun("revoked-after-job-creation");
    const corruptRun = await submitRun("corrupt-warm-cache");
    const replacementMarkdown = encoder.encode("# replacement native skill\n");
    const replacementMarkdownDigest = await sha256(replacementMarkdown);
    const replacementManifest = {
      ...manifest,
      files: [{
        ...manifest.files[0],
        sizeBytes: replacementMarkdown.byteLength,
        sha256: replacementMarkdownDigest,
      }, manifest.files[1]],
    };
    const replacementVersionDigest = await sha256Hex(
      canonicalJson(replacementManifest),
    );
    const replacementPublication = await adminPost(
      `/v1/skills/${skill.id}/versions`,
      {
        revision: 2,
        digest: replacementVersionDigest,
        entryPath: "SKILL.md",
        manifest: replacementManifest,
        files: [{
          path: "SKILL.md",
          mediaType: "text/markdown",
          isExecutable: false,
          contentBase64: btoa(String.fromCharCode(...replacementMarkdown)),
        }, {
          path: "bin/run.sh",
          mediaType: "text/x-shellscript",
          isExecutable: true,
          contentBase64: btoa(String.fromCharCode(...executable)),
        }],
      },
    );
    assertEquals(
      replacementPublication.status,
      201,
      await replacementPublication.clone().text(),
    );
    const replacementVersion = await replacementPublication.json() as {
      id: string;
      digest: string;
    };
    const replacementAgentConfig = {
      harness: "pi",
      skillBindings: { native: replacementVersion.id },
    };
    const replacementAgentResponse = await adminPost(
      `/v1/agents/${agent.id}/versions`,
      {
        revision: 2,
        config: replacementAgentConfig,
        digest: await agentVersionDigest(replacementAgentConfig),
      },
    );
    assertEquals(
      replacementAgentResponse.status,
      201,
      await replacementAgentResponse.clone().text(),
    );
    const replacementAgentVersion = await replacementAgentResponse.json() as {
      id: string;
    };
    const replacementProfileConfig = {
      ...profileConfig,
      agentBindings: { "quality.check": replacementAgentVersion.id },
    };
    const replacementProfileDigest = await sha256Hex(
      canonicalJson(replacementProfileConfig),
    );
    await fixture.pgDatabase.query(
      `insert into bakery.repository_profiles (
         id, organization_id, application_id, repository_id, revision,
         config, digest, created_by
       ) values ($1, $2, $3, $4, 2, $5::jsonb, $6, $7)`,
      [
        replacementProfileId,
        fixture.organizationId,
        applicationId,
        repositoryId,
        JSON.stringify(replacementProfileConfig),
        replacementProfileDigest,
        fixture.principalId,
      ],
    );
    await fixture.pgDatabase.query(
      `update bakery.agent_definitions set active_version_id = $3
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, agent.id, replacementAgentVersion.id],
    );
    await fixture.pgDatabase.query(
      `update bakery.repositories set active_profile_id = $3
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, repositoryId, replacementProfileId],
    );
    const activePointers = await fixture.pgDatabase.query<{
      skill: string | null;
      agent: string | null;
      profile: string | null;
    }>(
      `select skill.active_version_id as skill,
              agent.active_version_id as agent,
              repository.active_profile_id as profile
         from bakery.skills skill
         join bakery.agent_definitions agent
           on agent.organization_id = skill.organization_id and agent.id = $3
         join bakery.repositories repository
           on repository.organization_id = skill.organization_id
          and repository.id = $4
        where skill.organization_id = $1 and skill.id = $2`,
      [fixture.organizationId, skill.id, agent.id, repositoryId],
    );
    assertEquals(activePointers.rows[0], {
      skill: replacementVersion.id,
      agent: replacementAgentVersion.id,
      profile: replacementProfileId,
    });
    const replay = await adminPost(
      `/v1/tasks/${coldRun.taskId}/runs`,
      coldRun.requestBody,
      coldRun.idempotencyKey,
    );
    assertEquals(replay.status, 201, await replay.clone().text());
    assertEquals(replay.headers.get("Idempotent-Replayed"), "true");
    assertEquals(await replay.json(), coldRun.responseBody);

    const coldJob = await admitRun(coldRun.runId);
    objectReads = 0;

    const worker = await registeredWorker(fixture, {
      name: "issue279-native-materializer",
    });
    const registrationStore = new RegistrationStore(
      join(stateDir, "registration.json"),
    );
    await registrationStore.saveRegistered(
      worker.credential,
      worker.registration,
    );
    const spool = await EventSpool.open({
      path: join(stateDir, "spool.json"),
      maxRecords: 1_000,
      maxBytes: 1024 * 1024,
    });
    const claimedAssignments: Array<{
      jobId: string;
      action: string;
      agentVersionId: string | null;
      agentConfig: unknown;
      skillRefs: unknown;
    }> = [];
    const client = new WorkerApiClient({
      baseUrl: serverUrl,
      credential: worker.credential,
      requestTimeoutMs: 5_000,
      fetcher: async (input, init) => {
        const response = await fetch(input, init);
        const requestUrl = input instanceof Request ? input.url : String(input);
        if (
          new URL(requestUrl).pathname === "/v1/worker/claims" &&
          response.status === 200
        ) {
          claimedAssignments.push(
            await response.clone().json() as {
              jobId: string;
              action: string;
              agentVersionId: string | null;
              agentConfig: unknown;
              skillRefs: unknown;
            },
          );
        }
        return response;
      },
    });
    const executor = createNativeExecutor({
      cgroupRoot: cgroup.root,
      stateDir,
      actions: [nativeObservationAction()],
      terminationGraceMs: 1_000,
      probeIntervalMs: 10,
    });
    const config = {
      ...supervisorConfig(stateDir),
      serverUrl,
      nativeCgroupRoot: cgroup.root,
      requestTimeoutMs: 5_000,
      drainTimeoutMs: 5_000,
    };
    const expectExactClaim = async (jobId: string) => {
      const assignment = await waitFor(
        () =>
          Promise.resolve(
            claimedAssignments.find((candidate) => candidate.jobId === jobId) ??
              null,
          ),
        `ISSUE279_ASSIGNMENT_NOT_OBSERVED:${jobId}`,
      );
      assertEquals(assignment, {
        ...assignment,
        jobId,
        action: "quality.check",
        agentVersionId: agentVersion.id,
        agentConfig,
        skillRefs: [{ versionId: version.id, digest: version.digest }],
      });
    };
    run = workerMain({
      config,
      client,
      registrationStore,
      spool,
      executor,
      onSupervisor: (value) => supervisor = value,
    });
    const cold = await waitFor(
      () => nativeObservation(fixture, coldJob.jobId),
      "ISSUE279_COLD_NATIVE_OBSERVATION_TIMEOUT",
    );
    assertEquals(objectReads, 2);
    assertEquals(manifestReads, 3);
    assertEquals(requestOrder.length, 5);

    const warmJob = await admitRun(warmRun.runId);
    await waitForTerminal(fixture, warmJob.jobId);
    await expectExactClaim(warmJob.jobId);
    const warm = await waitFor(
      () => nativeObservation(fixture, warmJob.jobId),
      "ISSUE279_WARM_NATIVE_OBSERVATION_TIMEOUT",
    );
    assertEquals(objectReads, 2);
    assertEquals(manifestReads, 5);
    assertEquals(requestOrder.slice(-2), ["manifest:4", "manifest:5"]);

    revokeAtManifest = manifestReads + 2;
    const revokedJob = await admitRun(revokedRun.runId);
    await waitForTerminal(fixture, revokedJob.jobId);
    await expectExactClaim(revokedJob.jobId);
    assertEquals(await nativeObservation(fixture, revokedJob.jobId), null);
    assertEquals(manifestReads, 7);
    assertEquals(objectReads, 2);
    await fixture.pgDatabase.query(
      "update bakery.skill_sources set enabled = true where id = $1",
      [sourceId],
    );

    const tree = await committedTree(stateDir);
    const cacheEntry = join(tree, "SKILL.md");
    const cacheExecutable = join(tree, "bin/run.sh");
    assertEquals(await Deno.readFile(cacheEntry), markdown);
    assertEquals((await Deno.lstat(cacheEntry)).mode! & 0o777, 0o400);
    assertEquals((await Deno.lstat(cacheExecutable)).mode! & 0o777, 0o500);
    await Deno.chmod(cacheEntry, 0o600);
    const corrupted = await Deno.readFile(cacheEntry);
    corrupted[0] ^= 0xff;
    await Deno.writeFile(cacheEntry, corrupted);
    await Deno.chmod(cacheEntry, 0o400);
    const corruptJob = await admitRun(corruptRun.runId);
    await waitForTerminal(fixture, corruptJob.jobId);
    await expectExactClaim(corruptJob.jobId);
    assertEquals(await nativeObservation(fixture, corruptJob.jobId), null);
    assertEquals(objectReads, 2);
    assertEquals(manifestReads, 8);

    const observations = [cold, warm];
    for (const record of [cold, warm]) {
      assert(record.pid > 1);
      assert(record.cgroup.includes("bakery-279-materialization-"));
      assertEquals(record.roots, [record.rootPath]);
      assert(record.rootPath.includes("/skill-materialization-v1/attempts/"));
      assertEquals(record.rootPath.includes("/objects/"), false);
      assertEquals(record.entryPath, `${record.rootPath}/SKILL.md`);
      assertEquals(record.entryDigest, markdownDigest);
      assertEquals(record.executableDigest, executableDigest);
      assertEquals(record.rootMode, 0o700);
      assertEquals(record.executableMode, 0o700);
      assertEquals(record.entryLinks, 1);
    }
    assertEquals(cold.mutationRejected, true);
    assertEquals(warm.mutationRejected, true);
    assertEquals(warm.entryMode, 0o600);
    assertEquals(
      `${cold.entryDevice}:${cold.entryInode}` ===
        `${warm.entryDevice}:${warm.entryInode}`,
      false,
    );
    assert(cold.rootPath !== warm.rootPath);
    console.log(JSON.stringify({
      mechanismProof: "issue279-authenticated-producer-to-native-root",
      authenticatedApiChain: [
        "POST /v1/skills",
        "POST /v1/skills/:id/versions",
        "POST /v1/agents",
        "POST /v1/agents/:id/versions",
        "POST /v1/tasks/:id/runs",
        "POST /v1/worker/claims",
      ],
      jobAdmissionDriver: "createBakeryPostgresWorkflowRepository.admit",
      codingInference: false,
      frozen: {
        agentVersionId: agentVersion.id,
        agentConfig,
        skillRefs: [{ versionId: version.id, digest: version.digest }],
      },
      changedPointers: {
        skillVersionId: replacementVersion.id,
        agentVersionId: replacementAgentVersion.id,
        repositoryProfileId: replacementProfileId,
      },
      observedAssignments: claimedAssignments.length,
      objectReads: { cold: 2, warmAdditional: 0 },
      manifestReads: { cold: 3, warmAdditional: 2 },
      observations,
    }));
  } finally {
    supervisor?.requestStop("ISSUE279_NATIVE_PROOF_COMPLETE");
    await run?.catch(() => undefined);
    await server?.shutdown().catch(() => undefined);
    await closeWorkerFixture(fixture).catch(() => undefined);
    await cgroup.release().catch(() => undefined);
    await Deno.remove(stateDir, { recursive: true }).catch(() => undefined);
    await Deno.remove(skillRoot, { recursive: true }).catch(() => undefined);
  }
});
