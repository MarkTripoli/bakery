import { assert, assertEquals } from "@std/assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// These cases drive scripts/ci/heal-stale-shallow.ts with `node` itself and
// deliberately do NOT import it. If the script ever runs its main() on import
// (a broken entry-point guard), a test file that imports it exits at load with
// zero tests registered and reports "ok | 0 passed": the bug silences the very
// file that would catch it. This file spawns the script instead, so it cannot
// be silenced that way.

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.test",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.test",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  LC_ALL: "C",
};

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, env: GIT_ENV, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`git ${args.join(" ")} failed: ${stderr}`));
        } else {
          resolve(String(stdout).trim());
        }
      },
    );
  });
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bakery-shallow-entry-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function makeRepo(dir: string): Promise<string> {
  const repo = join(dir, "repo");
  await mkdir(repo);
  await git(repo, "init", "-q", "-b", "main");
  for (const n of ["1", "2", "3"]) {
    await writeFile(join(repo, "f"), n);
    await git(repo, "add", "f");
    await git(repo, "commit", "-q", "-m", `c${n}`);
  }
  return repo;
}

const shallowFile = (repo: string) => join(repo, ".git", "shallow");

async function readShallow(repo: string): Promise<string | null> {
  return await readFile(shallowFile(repo), "utf8").catch(() => null);
}

// The script is meant to run under plain Node.js as well, so these two cases
// drive it with `node` itself and not through the Deno test process.
const SCRIPT = fileURLToPath(
  new URL("../../scripts/ci/heal-stale-shallow.ts", import.meta.url),
);
const STALE = "38f398e8c80cd54ffe9a19f6b3807e076c8d2724";

function node(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "node",
      args,
      {
        cwd,
        env: { PATH: process.env.PATH ?? "", RUNNER_NAME: "test-runner" },
      },
      (error, stdout, stderr) => {
        const code = error === null
          ? 0
          : typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : 127;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

Deno.test("run as the entry point under node, the script heals a stale entry and exits 0", async () => {
  await withDir(async (dir) => {
    const repo = await makeRepo(dir);
    await writeFile(shallowFile(repo), `${STALE}\n`);
    const result = await node(repo, [SCRIPT]);
    assertEquals(result.code, 0, result.stderr);
    assert(
      result.stdout.includes("dropped stale shallow entry"),
      result.stdout,
    );
    assertEquals(await readShallow(repo), null);
    assertEquals(
      await git(repo, "rev-parse", "--is-shallow-repository"),
      "false",
    );
  });
});

Deno.test("run as the entry point under node, a real boundary still exits 1 and is kept", async () => {
  await withDir(async (dir) => {
    const origin = await makeRepo(dir);
    const clone = join(dir, "clone");
    await git(dir, "clone", "-q", "--depth", "1", `file://${origin}`, clone);
    const before = await readShallow(clone);
    const result = await node(clone, [SCRIPT]);
    assertEquals(result.code, 1);
    assert(result.stderr.includes("real boundary"), result.stderr);
    assertEquals(await readShallow(clone), before);
  });
});

Deno.test("importing the script has no side effects: nothing runs and nothing is healed", async () => {
  await withDir(async (dir) => {
    const repo = await makeRepo(dir);
    await writeFile(shallowFile(repo), `${STALE}\n`);
    const result = await node(repo, [
      "--input-type=module",
      "-e",
      `await import(${
        JSON.stringify(SCRIPT)
      }); console.log("IMPORT RETURNED");`,
    ]);
    assertEquals(result.code, 0, result.stderr);
    assert(
      result.stdout.includes("IMPORT RETURNED"),
      "import must return control",
    );
    assert(!result.stdout.includes("history:"), result.stdout);
    assertEquals(await readShallow(repo), `${STALE}\n`);
  });
});
