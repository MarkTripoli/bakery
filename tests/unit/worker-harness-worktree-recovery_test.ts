import { assert, assertEquals, assertFalse } from "@std/assert";
import { syntheticAuthSource } from "../helpers/harness-auth.ts";
import { createClaudeHarnessExecutor } from "../../apps/worker/src/claude-harness.ts";
import { createCodexHarnessExecutor } from "../../apps/worker/src/codex-harness.ts";
import { createPiHarnessExecutor } from "../../apps/worker/src/pi-harness.ts";
import {
  createHarnessBusyLatch,
  HARNESS_WORKTREE_DIRTY_REASON,
  harnessRestoreMarkerPath,
  harnessWorktreeCheck,
} from "../../apps/worker/src/harness-common.ts";
import type { WorkerExecutor } from "../../apps/worker/src/executor.ts";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import { localAssignment } from "../helpers/worker-execution/recovery-support.ts";
import {
  gitText,
  prepareScratchRepository,
  type ScratchRepository,
} from "../helpers/harness.ts";

const RUN_PERMISSIONS = {
  sanitizeResources: false,
  sanitizeOps: false,
} as const;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function assignment(scratchDir: string): Promise<JobAssignment> {
  const config = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
  };
  return {
    ...localAssignment(),
    agentSessionId: crypto.randomUUID(),
    input: {
      repositoryId: crypto.randomUUID(),
      planArtifact: crypto.randomUUID(),
      repositoryProfile: {
        organizationId: crypto.randomUUID(),
        applicationId: crypto.randomUUID(),
        repositoryId: crypto.randomUUID(),
        id: crypto.randomUUID(),
        revision: 1,
        digest: await sha256Hex(
          new TextEncoder().encode(canonicalJson(config)),
        ),
        config,
        observationId: null,
        observationDigest: null,
        baseSha: null,
      },
      instructions: "Do not change any file.",
      scratchDir,
    },
  } as JobAssignment;
}

type Fixture = {
  readonly scratch: ScratchRepository;
  readonly stateDir: string;
};

async function fixture(prefix: string): Promise<Fixture> {
  const scratch = await prepareScratchRepository(prefix);
  const stateDir = `${scratch.dir}/state`;
  await Deno.mkdir(stateDir, { recursive: true });
  return { scratch, stateDir };
}

async function writeMarker(
  stateDir: string,
  worktree: string,
  baseSha: string,
): Promise<void> {
  await Deno.writeTextFile(
    harnessRestoreMarkerPath(stateDir),
    JSON.stringify({ worktree, baseSha }),
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function porcelain(dir: string): Promise<string> {
  return await gitText(dir, ["status", "--porcelain", "--untracked-files=all"]);
}

/** Leaves the clone the way a SIGKILLed run does: edits, untracked file, commit. */
async function wedgeClone(scratch: ScratchRepository): Promise<void> {
  await Deno.writeTextFile(scratch.notesPath, "half edit\n");
  await Deno.writeTextFile(`${scratch.dir}/agent-new.txt`, "orphan\n");
  await gitText(scratch.dir, ["add", "agent-new.txt"]);
  await gitText(scratch.dir, ["commit", "-m", "agent commit"]);
  await Deno.writeTextFile(`${scratch.dir}/orphan-untracked.txt`, "orphan\n");
}

function unusedPublish(): never {
  throw new Error("UNUSED");
}

type Variant = {
  readonly name: string;
  readonly build: (repo: string, stateDir: string) => WorkerExecutor;
};

const VARIANTS: readonly Variant[] = [
  {
    name: "codex",
    build: (repo, stateDir) =>
      createCodexHarnessExecutor({
        publishFor: unusedPublish,
        repositoryFor: () => repo,
        repository: repo,
        stateDir,
        authSourceDir: syntheticAuthSource("auth.json"),
        codexExecutable: `${repo}/fake-codex`,
      }),
  },
  {
    name: "claude",
    build: (repo, stateDir) =>
      createClaudeHarnessExecutor({
        publishFor: unusedPublish,
        repositoryFor: () => repo,
        repository: repo,
        stateDir,
        authSourceDir: syntheticAuthSource(".credentials.json"),
        claudeExecutable: `${repo}/fake-claude`,
      }),
  },
  {
    name: "pi",
    build: (repo, stateDir) =>
      createPiHarnessExecutor({
        publishFor: unusedPublish,
        repositoryFor: () => repo,
        repository: repo,
        stateDir,
        piAgentSourceDir: syntheticAuthSource("auth.json"),
        piExecutable: `${repo}/fake-pi`,
      }),
  },
];

for (const variant of VARIANTS) {
  Deno.test({
    name: `${variant.name}: marker plus dirty clone is restored on initialize`,
    ...RUN_PERMISSIONS,
    fn: async () => {
      const { scratch, stateDir } = await fixture(
        `bakery-wt-${variant.name}-restore-`,
      );
      await wedgeClone(scratch);
      await writeMarker(stateDir, scratch.dir, scratch.baseSha);
      const executor = variant.build(scratch.dir, stateDir);

      await executor.initialize!();

      assertEquals(
        await gitText(scratch.dir, ["rev-parse", "HEAD"]),
        scratch.baseSha,
      );
      assertEquals(await porcelain(scratch.dir), "");
      assertFalse(await exists(harnessRestoreMarkerPath(stateDir)));
      const checks = await executor.readinessChecks!();
      const git = checks.find((check) => check.checkId === "capability:git");
      assertEquals(git?.status, "pass");
      assertEquals(git?.reason, undefined);
    },
  });

  Deno.test({
    name:
      `${variant.name}: dirty clone without a marker is reported, not wiped`,
    ...RUN_PERMISSIONS,
    fn: async () => {
      const { scratch, stateDir } = await fixture(
        `bakery-wt-${variant.name}-nomarker-`,
      );
      await Deno.writeTextFile(`${scratch.dir}/operator-edit.txt`, "keep\n");
      await Deno.writeTextFile(`${scratch.dir}/untracked-work.txt`, "keep\n");
      const executor = variant.build(scratch.dir, stateDir);

      await executor.initialize!();

      assert(await exists(`${scratch.dir}/untracked-work.txt`));
      const checks = await executor.readinessChecks!();
      const git = checks.find((check) => check.checkId === "capability:git");
      assertEquals(git?.status, "fail");
      assertEquals(git?.reason, HARNESS_WORKTREE_DIRTY_REASON);
      assertFalse((git?.reason ?? "").includes(scratch.dir));
    },
  });
}

Deno.test({
  name: "codex: dirty clone still refuses to execute",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const { scratch, stateDir } = await fixture("bakery-wt-codex-guard-");
    await Deno.writeTextFile(`${scratch.dir}/untracked-work.txt`, "keep\n");
    const executor = VARIANTS[0].build(scratch.dir, stateDir);
    await executor.initialize!();
    const outcome = await executor.execute(
      await assignment(scratch.dir),
      new AbortController().signal,
    );
    assert(outcome.status === "failed");
    assertEquals(
      (outcome.fault as { code?: string } | null)?.code,
      "CODEX_HARNESS_WORKTREE_DIRTY",
    );
  },
});

Deno.test({
  name: "clean clone: nothing changes and no marker appears",
  ...RUN_PERMISSIONS,
  fn: async () => {
    for (const variant of VARIANTS) {
      const { scratch, stateDir } = await fixture(
        `bakery-wt-${variant.name}-clean-`,
      );
      const executor = variant.build(scratch.dir, stateDir);
      await executor.initialize!();
      assertEquals(
        await gitText(scratch.dir, ["rev-parse", "HEAD"]),
        scratch.baseSha,
      );
      assertFalse(await exists(harnessRestoreMarkerPath(stateDir)));
      const checks = await executor.readinessChecks!();
      assertEquals(
        checks.find((check) => check.checkId === "capability:git")?.status,
        "pass",
      );
    }
  },
});

Deno.test({
  name: "a marker for another repository is ignored",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const { scratch, stateDir } = await fixture("bakery-wt-foreign-");
    await Deno.writeTextFile(`${scratch.dir}/untracked-work.txt`, "keep\n");
    await writeMarker(stateDir, "/somewhere/else", scratch.baseSha);
    const executor = VARIANTS[0].build(scratch.dir, stateDir);
    await executor.initialize!();
    assert(await exists(`${scratch.dir}/untracked-work.txt`));
    const checks = await executor.readinessChecks!();
    assertEquals(
      checks.find((check) => check.checkId === "capability:git")?.status,
      "fail",
    );
  },
});

Deno.test({
  name: "a busy harness reports pass without inspecting the clone",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const { scratch, stateDir } = await fixture("bakery-wt-busy-");
    await Deno.writeTextFile(`${scratch.dir}/mid-run-edit.txt`, "editing\n");
    const busy = createHarnessBusyLatch();
    assert(busy.acquire());
    const check = await harnessWorktreeCheck(
      { repository: scratch.dir, stateDir },
      busy,
    );
    assertEquals(check.status, "pass");
    assert(await exists(`${scratch.dir}/mid-run-edit.txt`));
    busy.release();
    const idle = await harnessWorktreeCheck(
      { repository: scratch.dir, stateDir },
      busy,
    );
    assertEquals(idle.status, "fail");
    assertFalse(busy.isBusy());
  },
});

Deno.test({
  name: "an unreadable clone reports unknown with a path-free reason",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const stateDir = await Deno.makeTempDir({
      prefix: "bakery-wt-unreadable-",
    });
    const missing = `${stateDir}/not-a-repository`;
    await Deno.mkdir(missing);
    const check = await harnessWorktreeCheck(
      { repository: missing, stateDir },
      createHarnessBusyLatch(),
    );
    assertEquals(check.status, "unknown");
    assertFalse((check.reason ?? "").includes(missing));
  },
});

async function fakeExecutor(
  dir: string,
  releaseFile: string,
  body: string,
): Promise<string> {
  const executable = `${dir}/fake-codex`;
  await Deno.writeTextFile(
    executable,
    `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo 'codex-cli 0.0.0-fake'; exit 0; fi
${body}
while [ ! -e '${releaseFile}' ]; do sleep 0.05; done
exit 0
`,
  );
  await Deno.chmod(executable, 0o755);
  return executable;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("WAIT_TIMEOUT");
}

function codexWithState(dir: string, executable: string, stateDir: string) {
  return createCodexHarnessExecutor({
    publishFor: () => async (request) => ({
      artifactId: crypto.randomUUID(),
      versionId: crypto.randomUUID(),
      sha256: await sha256Hex(request.bytes),
    }),
    repositoryFor: () => dir,
    repository: dir,
    stateDir,
    authSourceDir: syntheticAuthSource("auth.json"),
    codexExecutable: executable,
    timeLimitMs: 10_000,
  });
}

Deno.test({
  name:
    "the restore marker exists while a run is live and is gone after an abort",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const { scratch, stateDir } = await fixture("bakery-wt-lifecycle-");
    const release = `${scratch.dir}/fake-release`;
    const executable = await fakeExecutor(
      scratch.dir,
      release,
      `printf 'half\\n' >> '${scratch.notesPath}'; printf 'x\\n' > '${scratch.dir}/orphan.txt'; touch '${scratch.dir}/fake-started'`,
    );
    const executor = codexWithState(scratch.dir, executable, stateDir);
    await executor.initialize!();
    const controller = new AbortController();
    const running = executor.execute(
      await assignment(scratch.dir),
      controller.signal,
    );
    await waitFor(() => exists(`${scratch.dir}/fake-started`));
    const marker = JSON.parse(
      await Deno.readTextFile(harnessRestoreMarkerPath(stateDir)),
    );
    assertEquals(marker, { worktree: scratch.dir, baseSha: scratch.baseSha });
    // Readiness mid-run neither inspects nor resets the live clone.
    const midRun = await executor.readinessChecks!();
    assertEquals(
      midRun.find((check) => check.checkId === "capability:git")?.status,
      "pass",
    );
    assert(await exists(`${scratch.dir}/orphan.txt`));
    controller.abort();
    await running;
    assertEquals(await porcelain(scratch.dir), "");
    assertFalse(await exists(harnessRestoreMarkerPath(stateDir)));
  },
});

Deno.test({
  name: "a completed run clears the restore marker",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const { scratch, stateDir } = await fixture("bakery-wt-completed-");
    const release = `${scratch.dir}/fake-release`;
    await Deno.writeTextFile(release, "");
    const executable = await fakeExecutor(scratch.dir, release, ":");
    const executor = codexWithState(scratch.dir, executable, stateDir);
    const outcome = await executor.execute(
      await assignment(scratch.dir),
      new AbortController().signal,
    );
    assertEquals(outcome.status, "completed");
    assertFalse(await exists(harnessRestoreMarkerPath(stateDir)));
  },
});

Deno.test({
  name: "a restored clone passes the dirty guard and runs",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const { scratch, stateDir } = await fixture("bakery-wt-runs-");
    const release = `${scratch.dir}/fake-release`;
    await Deno.writeTextFile(release, "");
    const executable = await fakeExecutor(scratch.dir, release, ":");
    await wedgeClone(scratch);
    await writeMarker(stateDir, scratch.dir, scratch.baseSha);
    const executor = codexWithState(scratch.dir, executable, stateDir);
    await executor.initialize!();
    const outcome = await executor.execute(
      await assignment(scratch.dir),
      new AbortController().signal,
    );
    assertEquals(outcome.status, "completed");
  },
});

Deno.test({
  name: "the busy latch lets a start wait for an in-flight readiness pass",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const { scratch, stateDir } = await fixture("bakery-wt-latch-wait-");
    const latch = createHarnessBusyLatch();
    const pending = harnessWorktreeCheck(
      { repository: scratch.dir, stateDir },
      latch,
    );
    // The pass holds the latch synchronously, so a start that skipped the
    // wait would be refused here.
    assert(latch.isBusy());
    assertFalse(latch.acquire());
    await latch.settled();
    assertFalse(latch.isBusy());
    assert(latch.acquire());
    latch.release();
    assertEquals((await pending).status, "pass");
  },
});

Deno.test({
  name: "a run started during a readiness pass waits instead of failing busy",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const { scratch, stateDir } = await fixture("bakery-wt-start-in-pass-");
    const release = `${scratch.dir}/fake-release`;
    await Deno.writeTextFile(release, "");
    const executable = await fakeExecutor(scratch.dir, release, ":");
    // A restorable wedge makes the readiness pass do real git work.
    await wedgeClone(scratch);
    await writeMarker(stateDir, scratch.dir, scratch.baseSha);
    const executor = codexWithState(scratch.dir, executable, stateDir);
    const readiness = executor.readinessChecks!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const outcome = await executor.execute(
      await assignment(scratch.dir),
      new AbortController().signal,
    );
    await readiness;
    assertEquals(outcome.status, "completed");
  },
});
