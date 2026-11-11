import { assert, assertEquals, assertFalse } from "@std/assert";
import { createCodexHarnessExecutor } from "../../apps/worker/src/codex-harness.ts";
import { workerActionOutputSchema } from "../../packages/contracts/src/contracts.ts";
import { canonicalJson } from "../../apps/server/src/platform/canonical-json.ts";
import type { JobAssignment } from "../../apps/worker/src/types.ts";
import { localAssignment } from "../helpers/worker-execution/recovery-support.ts";
import { prepareScratchRepository } from "../helpers/harness.ts";
import { syntheticAuthSource } from "../helpers/harness-auth.ts";

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

async function repositoryProfile() {
  const config = {
    schemaVersion: 1,
    workflow: { kind: "fixed" },
    branches: { base: "main", allowedPatterns: ["feature/*"] },
    worktree: { root: ".bakery/worktrees" },
  };
  return {
    organizationId: crypto.randomUUID(),
    applicationId: crypto.randomUUID(),
    repositoryId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    revision: 1,
    digest: await sha256Hex(new TextEncoder().encode(canonicalJson(config))),
    config,
    observationId: null,
    observationDigest: null,
    baseSha: null,
  };
}

async function assignment(scratchDir: string): Promise<JobAssignment> {
  return {
    ...localAssignment(),
    agentSessionId: crypto.randomUUID(),
    input: {
      repositoryId: crypto.randomUUID(),
      planArtifact: crypto.randomUUID(),
      repositoryProfile: await repositoryProfile(),
      instructions: "Do not change any file.",
      scratchDir,
    },
  } as JobAssignment;
}

/** Fake codex: `versionBranch` answers `--version`; anything else drops a marker. */
async function fakeCodex(
  dir: string,
  versionBranch: string,
): Promise<{ executable: string; execMarker: string }> {
  const executable = `${dir}/fake-codex`;
  const execMarker = `${dir}/exec-ran.txt`;
  await Deno.writeTextFile(
    executable,
    `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  ${versionBranch}
fi
printf 'ran\\n' > '${execMarker}'
exit 0
`,
  );
  await Deno.chmod(executable, 0o755);
  return { executable, execMarker };
}

function executorFor(
  dir: string,
  executable: string,
  redactionSecrets?: readonly string[],
  publications?: { count: number },
  authSourceDir: string = syntheticAuthSource("auth.json"),
) {
  return createCodexHarnessExecutor({
    publishFor: () => async (request) => {
      if (publications) publications.count++;
      return {
        artifactId: crypto.randomUUID(),
        versionId: crypto.randomUUID(),
        sha256: await sha256Hex(request.bytes),
      };
    },
    repositoryFor: () => dir,
    codexExecutable: executable,
    authSourceDir,
    timeLimitMs: 5_000,
    redactionSecrets,
  });
}

async function head(dir: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    cwd: dir,
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout).trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function faultOf(outcome: { status: string; fault?: unknown }) {
  assertEquals(outcome.status, "failed");
  return outcome.fault as Record<string, unknown>;
}

Deno.test({
  name: "Codex records its probed CLI version and the result parses",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-codex-unit-");
    const fake = await fakeCodex(
      scratch.dir,
      "echo 'codex-cli 0.0.0-fake'; exit 0",
    );
    const outcome = await executorFor(scratch.dir, fake.executable).execute(
      await assignment(scratch.dir),
      new AbortController().signal,
    );
    assertEquals(outcome.status, "completed");
    if (outcome.status !== "completed") throw new Error("unreachable");
    const result = workerActionOutputSchema("harness.implement").parse(
      outcome.result,
    ) as Record<string, unknown>;
    assertEquals(result.codexVersion, "codex-cli 0.0.0-fake");
    assert(await exists(fake.execMarker));
  },
});

Deno.test({
  name: "Codex refuses to run when the version probe yields nothing or fails",
  ...RUN_PERMISSIONS,
  fn: async () => {
    for (
      const branch of ["exit 0", "echo 'codex-cli 1'; exit 3"]
    ) {
      const scratch = await prepareScratchRepository("bakery-codex-nover-");
      const before = await head(scratch.dir);
      const fake = await fakeCodex(scratch.dir, branch);
      const outcome = await executorFor(scratch.dir, fake.executable).execute(
        await assignment(scratch.dir),
        new AbortController().signal,
      );
      const fault = faultOf(outcome);
      assertEquals(fault.code, "CODEX_HARNESS_EXIT_NONZERO");
      assertEquals(fault.retryable, false);
      assertFalse(await exists(fake.execMarker));
      assertEquals(await head(scratch.dir), before);
    }
  },
});

Deno.test({
  name: "Codex maps a hanging version probe to a retryable timeout",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-codex-hang-");
    const before = await head(scratch.dir);
    const fake = await fakeCodex(scratch.dir, "sleep 30");
    const outcome = await executorFor(scratch.dir, fake.executable).execute(
      await assignment(scratch.dir),
      new AbortController().signal,
    );
    const fault = faultOf(outcome);
    assertEquals(fault.code, "CODEX_HARNESS_TIMEOUT");
    assertEquals(fault.retryable, true);
    assertFalse(await exists(fake.execMarker));
    assertEquals(await head(scratch.dir), before);
  },
});

Deno.test({
  name: "Codex does not publish a patch holding a configured secret",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const canary = "canary-secret-Zq81xPLm47vN";
    const scratch = await prepareScratchRepository("bakery-codex-secret-");
    const before = await head(scratch.dir);
    const executable = `${scratch.dir}/fake-codex`;
    await Deno.writeTextFile(
      executable,
      `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo 'codex-cli 0.0.0-fake'; exit 0; fi
printf '%s\\n' '${canary}' > '${scratch.dir}/leak.txt'
exit 0
`,
    );
    await Deno.chmod(executable, 0o755);
    const publications = { count: 0 };
    const outcome = await executorFor(
      scratch.dir,
      executable,
      [canary],
      publications,
    ).execute(await assignment(scratch.dir), new AbortController().signal);
    const fault = faultOf(outcome);
    assertEquals(fault.code, "CODEX_HARNESS_PATCH_SECRET_DETECTED");
    assertEquals(fault.status, 422);
    assertEquals(fault.retryable, false);
    assertFalse(JSON.stringify(fault).includes(canary));
    assertEquals(publications.count, 0);
    assertEquals(await head(scratch.dir), before);
    const status = await new Deno.Command("git", {
      args: ["status", "--porcelain"],
      cwd: scratch.dir,
      stdout: "piped",
    }).output();
    assertEquals(new TextDecoder().decode(status.stdout), "");
  },
});

Deno.test({
  name: "Codex refuses a dirty worktree before executing",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-codex-dirty-");
    await Deno.writeTextFile(`${scratch.dir}/leftover-new.txt`, "leftover\n");
    const fake = await fakeCodex(
      scratch.dir,
      "echo 'codex-cli 0.0.0-fake'; exit 0",
    );
    const publications = { count: 0 };
    const before = await head(scratch.dir);
    const outcome = await executorFor(
      scratch.dir,
      fake.executable,
      undefined,
      publications,
    ).execute(await assignment(scratch.dir), new AbortController().signal);
    const fault = faultOf(outcome);
    assertEquals(fault.code, "CODEX_HARNESS_WORKTREE_DIRTY");
    assertEquals(fault.status, 409);
    assertEquals(fault.retryable, false);
    assertFalse(await exists(fake.execMarker));
    assertEquals(publications.count, 0);
    assertEquals(await head(scratch.dir), before);
  },
});

Deno.test("Codex maps invalid input and unsupported actions", async () => {
  const scratch = await prepareScratchRepository("bakery-codex-faults-");
  const fake = await fakeCodex(scratch.dir, "echo 'codex-cli 0'; exit 0");
  const executor = executorFor(scratch.dir, fake.executable);
  const invalid = faultOf(
    await executor.execute(
      { ...localAssignment(), input: {} } as JobAssignment,
      new AbortController().signal,
    ),
  );
  assertEquals(invalid.code, "CODEX_HARNESS_INPUT_INVALID");
  assertEquals(invalid.retryable, false);
  const unsupported = faultOf(
    await executor.execute(
      { ...localAssignment(), action: "quality.check" } as JobAssignment,
      new AbortController().signal,
    ),
  );
  assertEquals(unsupported.code, "CODEX_HARNESS_ACTION_UNSUPPORTED");
  assertEquals(unsupported.retryable, false);
});

Deno.test({
  name:
    "Codex restores the clone after a failed run so the next run starts clean",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-codex-restore-");
    const before = await head(scratch.dir);
    const executable = `${scratch.dir}/fake-codex`;
    // First exec edits a tracked file and adds an untracked one, then dies;
    // the second exec (marker present) leaves the tree alone and succeeds.
    await Deno.writeTextFile(
      executable,
      `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo 'codex-cli 0.0.0-fake'; exit 0; fi
if [ -e '${scratch.dir}/fake-second-run' ]; then exit 0; fi
printf 'half-edit\\n' >> '${scratch.notesPath}'
printf 'orphan\\n' > '${scratch.dir}/orphan-edit.txt'
touch '${scratch.dir}/fake-second-run'
exit 3
`,
    );
    await Deno.chmod(executable, 0o755);
    const executor = executorFor(scratch.dir, executable);
    const first = faultOf(
      await executor.execute(
        await assignment(scratch.dir),
        new AbortController().signal,
      ),
    );
    assertEquals(first.code, "CODEX_HARNESS_EXIT_NONZERO");
    const status = await new Deno.Command("git", {
      args: ["status", "--porcelain", "--untracked-files=all"],
      cwd: scratch.dir,
      stdout: "piped",
    }).output();
    assertEquals(new TextDecoder().decode(status.stdout), "");
    assertEquals(await head(scratch.dir), before);
    const second = await executor.execute(
      await assignment(scratch.dir),
      new AbortController().signal,
    );
    assertEquals(second.status, "completed");
  },
});

Deno.test({
  name:
    "Codex child sees only CODEX_HOME/auth.json, never the operator HOME (#418)",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-codex-home-");
    const operatorHome = await Deno.makeTempDir({ prefix: "bakery-op-home-" });
    const dump = await Deno.makeTempDir({ prefix: "bakery-codex-dump-" });
    const previous = Deno.env.get("HOME");
    try {
      await Deno.mkdir(`${operatorHome}/.codex`);
      await Deno.writeTextFile(
        `${operatorHome}/.codex/auth.json`,
        "OPERATOR_HOME_DECOY",
      );
      Deno.env.set("HOME", operatorHome);
      const executable = `${dump}/fake-codex`;
      await Deno.writeTextFile(
        executable,
        `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo 'codex-cli 0.0.0-fake'; exit 0; fi
printf '%s\\n' "$HOME" > '${dump}/home'
printf '%s\\n' "$CODEX_HOME" > '${dump}/codex-home'
( cd "$CODEX_HOME" && find . -mindepth 1 | sort ) > '${dump}/listing'
if [ -r "$HOME/.codex/auth.json" ]; then echo leaked > '${dump}/leaked'; fi
exit 0
`,
      );
      await Deno.chmod(executable, 0o755);
      const outcome = await executorFor(scratch.dir, executable).execute(
        await assignment(scratch.dir),
        new AbortController().signal,
      );
      assertEquals(outcome.status, "completed");
      const home = (await Deno.readTextFile(`${dump}/home`)).trim();
      const codexHome = (await Deno.readTextFile(`${dump}/codex-home`)).trim();
      assert(home !== operatorHome, "the child inherited the operator HOME");
      assert(codexHome !== `${operatorHome}/.codex`);
      assertEquals(
        (await Deno.readTextFile(`${dump}/listing`)).trim(),
        "./auth.json",
      );
      assertFalse(await exists(`${dump}/leaked`));
      assertFalse(await exists(home), "the isolated HOME survived the run");
      assertFalse(await exists(codexHome), "CODEX_HOME survived the run");
    } finally {
      if (previous === undefined) Deno.env.delete("HOME");
      else Deno.env.set("HOME", previous);
      await Deno.remove(operatorHome, { recursive: true });
      await Deno.remove(dump, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "Codex fails closed, before spawn, when its login is unavailable (#418)",
  ...RUN_PERMISSIONS,
  fn: async () => {
    const scratch = await prepareScratchRepository("bakery-codex-noauth-");
    const before = await head(scratch.dir);
    const fake = await fakeCodex(
      scratch.dir,
      "echo 'codex-cli 0.0.0-fake'; exit 0",
    );
    const empty = await Deno.makeTempDir({ prefix: "bakery-codex-noauth-" });
    try {
      for (
        const source of [`${empty}/missing-dir`, empty] as const
      ) {
        const outcome = await executorFor(
          scratch.dir,
          fake.executable,
          undefined,
          undefined,
          source,
        ).execute(await assignment(scratch.dir), new AbortController().signal);
        const fault = faultOf(outcome);
        assertEquals(fault.code, "CODEX_HARNESS_CREDENTIAL_UNAVAILABLE");
        assertEquals(fault.status, 503);
        assertEquals(fault.retryable, false);
        assertFalse(await exists(fake.execMarker));
        assertEquals(await head(scratch.dir), before);
      }
    } finally {
      await Deno.remove(empty, { recursive: true });
    }
  },
});
