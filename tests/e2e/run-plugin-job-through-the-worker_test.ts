import { assert, assertEquals } from "@std/assert";
import {
  call,
  type Fixture,
  install,
  publishWithPages,
  withPluginFixture,
} from "../helpers/plugin-pages-fixture.ts";
import {
  registeredWorker,
  seedEligibleJob,
  workerFixtureCapabilities,
} from "../helpers/worker-execution.ts";
import { claimAssignment } from "../helpers/worker-execution/scenarios.ts";
import { WorkerApiClient } from "../../apps/worker/src/client.ts";
import {
  createDockerRuntime,
  DOCKER_FLAG,
} from "../../apps/worker/src/plugin-job-docker.ts";
import {
  executePluginJob,
  type PluginJobDeps,
} from "../../apps/worker/src/plugin-job-executor.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import type { BrokerClaims } from "../../apps/server/src/modules/catalog/plugin-broker.ts";

/**
 * A plugin job from claim to outcome (#29, B14.02): the real server, the real
 * worker client over it, the real executor and the real contained runtime. The
 * job is code from the install's own bundle; it reaches Bakery only through
 * its worker's relay, and it stops being served the moment its authority goes.
 * Needs Docker and an `alpine` image, and skips without them.
 */

const IMAGE = Deno.env.get("BAKERY_PLUGIN_TEST_IMAGE") ?? "alpine:latest";
const CAPS = [...workerFixtureCapabilities, "plugin.job.contained"];

async function dockerReady(): Promise<boolean> {
  try {
    const out = await new Deno.Command("docker", {
      args: ["image", "inspect", IMAGE],
      stdout: "null",
      stderr: "null",
    }).output();
    return out.code === 0;
  } catch {
    return false;
  }
}
const ready = await dockerReady();
const dockerTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, ignore: !ready, fn });

/** What the broker's `state.read` does in these tests, and what it saw. */
function stateRead(onCall: (claims: BrokerClaims) => Promise<void> | void) {
  const seen: { installId: string; jobId: string; key: string }[] = [];
  return {
    seen,
    operation: {
      name: "state.read",
      run: async (
        claims: BrokerClaims,
        args: Readonly<Record<string, unknown>>,
      ) => {
        seen.push({
          installId: claims.installId,
          jobId: claims.jobId,
          key: String(args.key),
        });
        await onCall(claims);
        return { value: `stored-${args.key}` };
      },
    },
  };
}

async function scenario(
  fixture: Fixture,
  store: Parameters<typeof publishWithPages>[1],
  script: string,
) {
  const published = await publishWithPages(
    fixture,
    store,
    { name: "nightly", requestedCapabilities: ["jobs.schedule", "state.read"] },
    { "jobs/nightly.sh": script },
  );
  assertEquals(published.response.status, 201, await published.response.text());
  const installId = await install(fixture, published);
  const worker = await registeredWorker(fixture, { capabilities: CAPS });
  await seedEligibleJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
    {
      action: "plugin.job",
      capabilities: ["plugin.job.contained"],
      input: {
        installId,
        entry: "jobs/nightly.sh",
        versionId: published.versionId,
      },
    },
  );
  const assignment = await claimAssignment(fixture, worker, {
    capabilities: CAPS,
    supportedActions: ["plugin.job"],
  });
  assertEquals(assignment.action, "plugin.job");
  // The worker's own client, talking to the real app.
  const client = new WorkerApiClient({
    baseUrl: fixture.config.publicBaseUrl,
    credential: worker.credential,
    fetcher: (input, init) =>
      Promise.resolve(fixture.app.fetch(new Request(input, init))),
  });
  const proof = {
    leaseToken: String(assignment.leaseToken),
    fence: String(assignment.fence),
    workerSessionId: worker.registration.workerSessionId,
    workerSessionGeneration: worker.registration.workerSessionGeneration,
  };
  const parent = await Deno.makeTempDir({ prefix: "plugin-e2e-" });
  const deps: PluginJobDeps = {
    runtime: createDockerRuntime({ env: { [DOCKER_FLAG]: "1" }, image: IMAGE }),
    codeParent: parent,
    limits: {
      cpus: 1,
      memoryBytes: 64 * 1024 * 1024,
      pids: 16,
      timeoutMs: 20_000,
      outputBytes: 64 * 1024,
      lineBytes: 8 * 1024,
    },
    command: (entry) => ["sh", `/code/${entry}`],
    fetchFiles: async (signal) =>
      (await client.getPluginJobFiles(assignment.attemptId, proof, signal))
        .value,
    relay: async (relayed, signal) => {
      const answer = (await client.callPluginBroker(
        assignment.attemptId,
        proof,
        relayed,
        signal,
      )).value;
      return answer.ok
        ? { ok: true as const, result: answer.result }
        : { ok: false as const, denial: answer.denial };
    },
  };
  return {
    installId,
    assignment: assignment as unknown as JobAssignment,
    deps,
    cleanup: () => Deno.remove(parent, { recursive: true }),
  };
}

const CALL = (id: string, seq: number, key: string) =>
  `echo '{"call":{"requestId":"${id}","sequence":${seq},"operation":"state.read","args":{"key":"${key}"}}}'`;

dockerTest(
  "a leased plugin job runs the install's code in a container and reads through the broker as its own install",
  () => {
    const rec = stateRead(() => {});
    return withPluginFixture(async (fixture, store) => {
      const { installId, assignment, deps, cleanup } = await scenario(
        fixture,
        store,
        [
          CALL("r1", 1, "a"),
          "read first",
          // A job that tries what it must not be able to: the network, its code.
          `wget -q -T 2 -O- http://1.1.1.1/ >/dev/null 2>&1 && net=open || net=closed`,
          `touch /code/x 2>/dev/null && code=wrote || code=refused`,
          `echo "{\\"result\\":{\\"first\\":$first,\\"net\\":\\"$net\\",\\"code\\":\\"$code\\"}}"`,
        ].join("\n"),
      );
      try {
        const outcome = await executePluginJob(
          assignment,
          new AbortController().signal,
          deps,
        );
        assertEquals(outcome.status, "completed", JSON.stringify(outcome));
        const result = JSON.parse(
          (outcome as unknown as { result: { resultJson: string } }).result
            .resultJson,
        );
        assertEquals(result.first.ok, true);
        assertEquals(result.first.result, { value: "stored-a" });
        assertEquals(result.net, "closed");
        assertEquals(result.code, "refused");
        // The broker saw this install and this job, which the server derived.
        assertEquals(rec.seen.length, 1);
        assertEquals(rec.seen[0].installId, installId);
        assertEquals(rec.seen[0].jobId, assignment.jobId);
        assertEquals(rec.seen[0].key, "a");
      } finally {
        await cleanup();
      }
    }, { pluginBrokerOperations: [rec.operation] });
  },
);

dockerTest(
  "turning the install off mid-job stops the job's next broker call",
  () => {
    let fixtureRef: Fixture | undefined;
    let installRef = "";
    const rec = stateRead(async () => {
      // Once the first call has run, the install is switched off.
      if (rec.seen.length === 1 && fixtureRef) {
        const off = await call(
          fixtureRef,
          `/v1/plugin-installs/${installRef}`,
          {
            method: "PATCH",
            body: { status: "disabled" },
          },
        );
        assertEquals(off.status, 200);
      }
    });
    return withPluginFixture(async (fixture, store) => {
      fixtureRef = fixture;
      const { installId, assignment, deps, cleanup } = await scenario(
        fixture,
        store,
        [
          CALL("r1", 1, "a"),
          "read first",
          CALL("r2", 2, "b"),
          "read second",
          `echo "{\\"result\\":{\\"first\\":$first,\\"second\\":$second}}"`,
        ].join("\n"),
      );
      installRef = installId;
      try {
        const outcome = await executePluginJob(
          assignment,
          new AbortController().signal,
          deps,
        );
        assertEquals(outcome.status, "completed", JSON.stringify(outcome));
        const result = JSON.parse(
          (outcome as unknown as { result: { resultJson: string } }).result
            .resultJson,
        );
        assertEquals(result.first.ok, true);
        assertEquals(result.second, {
          requestId: "r2",
          ok: false,
          denial: "install_off",
        });
        assertEquals(rec.seen.length, 1);
      } finally {
        await cleanup();
      }
    }, { pluginBrokerOperations: [rec.operation] });
  },
);

dockerTest("a plugin job whose install is already off is never started", () => {
  const rec = stateRead(() => {});
  return withPluginFixture(async (fixture, store) => {
    const { installId, assignment, deps, cleanup } = await scenario(
      fixture,
      store,
      `touch /tmp/ran; echo '{"result":1}'`,
    );
    try {
      const off = await call(fixture, `/v1/plugin-installs/${installId}`, {
        method: "PATCH",
        body: { status: "disabled" },
      });
      assertEquals(off.status, 200);
      const outcome = await executePluginJob(
        assignment,
        new AbortController().signal,
        deps,
      );
      assertEquals(outcome.status, "failed");
      assertEquals(
        (outcome as unknown as { fault: { code: string } }).fault.code,
        "STATE_CONFLICT",
      );
      assertEquals(rec.seen.length, 0);
    } finally {
      await cleanup();
    }
  }, { pluginBrokerOperations: [rec.operation] });
});

dockerTest(
  "a caller abort stops a running plugin job and leaves no container or code behind",
  () => {
    const rec = stateRead(() => {});
    return withPluginFixture(async (fixture, store) => {
      const { assignment, deps, cleanup } = await scenario(
        fixture,
        store,
        `sleep 60`,
      );
      try {
        const controller = new AbortController();
        const running = executePluginJob(assignment, controller.signal, deps);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        controller.abort();
        const outcome = await running;
        assertEquals(outcome.status, "canceled");
        assertEquals([...Deno.readDirSync(deps.codeParent)].length, 0);
        const left = await new Deno.Command("docker", {
          args: [
            "ps",
            "-a",
            "--filter",
            `name=bakery-plugin-job-`,
            "--format",
            "{{.Names}}",
          ],
          stdout: "piped",
        }).output();
        assert(new TextDecoder().decode(left.stdout).trim() === "");
      } finally {
        await cleanup();
      }
    }, { pluginBrokerOperations: [rec.operation] });
  },
);
