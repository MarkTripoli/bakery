import { assert, assertEquals, assertRejects } from "@std/assert";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GitRunner,
  healStaleShallow,
  runGit,
} from "../../scripts/ci/heal-stale-shallow.ts";

// Real throwaway repositories: the failure was a property of git's own state
// (a leftover .git/shallow entry), so a mock of git would prove nothing.

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
  const dir = await mkdtemp(join(tmpdir(), "bakery-shallow-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A repository on `main` with three commits. */
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

/** A commit no ref reaches, like the leftover from a recreated repository. */
async function danglingCommit(repo: string, message: string): Promise<string> {
  const tree = await git(repo, "rev-parse", "HEAD^{tree}");
  return await git(repo, "commit-tree", tree, "-m", message);
}

const shallowFile = (repo: string) => join(repo, ".git", "shallow");

async function readShallow(repo: string): Promise<string | null> {
  return await readFile(shallowFile(repo), "utf8").catch(() => null);
}

const isShallow = async (repo: string) =>
  await git(repo, "rev-parse", "--is-shallow-repository") === "true";

Deno.test("a complete repository is left alone", async () => {
  await withDir(async (dir) => {
    const repo = await makeRepo(dir);
    const result = await healStaleShallow(repo);
    assertEquals(result.shallowBefore, false);
    assertEquals(result.shallowAfter, false);
    assertEquals(result.dropped, []);
    assertEquals(await readShallow(repo), null);
  });
});

Deno.test("a stale entry whose commit no ref reaches is dropped and the repository becomes complete", async () => {
  await withDir(async (dir) => {
    const repo = await makeRepo(dir);
    const stale = await danglingCommit(repo, "docs: from the old repository");
    await writeFile(shallowFile(repo), `${stale}\n`);
    assert(await isShallow(repo), "precondition: the entry makes it shallow");

    const result = await healStaleShallow(repo);

    assertEquals(result.shallowBefore, true);
    assertEquals(result.shallowAfter, false);
    assertEquals(result.dropped.map((d) => d.sha), [stale]);
    assertEquals(result.dropped[0].reason, "no-ref-contains-it");
    assertEquals(result.dropped[0].subject, "docs: from the old repository");
    assertEquals(await readShallow(repo), null);
    assertEquals(await isShallow(repo), false);
    assertEquals(await git(repo, "rev-list", "--count", "HEAD"), "3");
  });
});

Deno.test("a stale entry whose commit is not in the repository at all is dropped", async () => {
  await withDir(async (dir) => {
    const repo = await makeRepo(dir);
    const absent = "38f398e8c80cd54ffe9a19f6b3807e076c8d2724";
    await writeFile(shallowFile(repo), `${absent}\n`);
    const result = await healStaleShallow(repo);
    assertEquals(result.dropped.map((d) => [d.sha, d.reason]), [
      [absent, "object-absent"],
    ]);
    assertEquals(result.dropped[0].subject, null);
    assertEquals(result.shallowAfter, false);
  });
});

Deno.test("a real boundary of a shallow clone is kept byte for byte and the repository stays shallow", async () => {
  await withDir(async (dir) => {
    const origin = await makeRepo(dir);
    const clone = join(dir, "clone");
    await git(dir, "clone", "-q", "--depth", "1", `file://${origin}`, clone);
    const before = await readShallow(clone);
    assert(before !== null && before.trim().length === 40);

    const result = await healStaleShallow(clone);

    assertEquals(result.dropped, []);
    assertEquals(result.kept, [before.trim()]);
    assertEquals(result.shallowAfter, true);
    assertEquals(await readShallow(clone), before);
  });
});

Deno.test("only the stale entry goes when a real boundary sits beside it", async () => {
  await withDir(async (dir) => {
    const origin = await makeRepo(dir);
    const clone = join(dir, "clone");
    await git(dir, "clone", "-q", "--depth", "1", `file://${origin}`, clone);
    const real = (await readShallow(clone))!.trim();
    const stale = await danglingCommit(clone, "leftover");
    await writeFile(shallowFile(clone), `${real}\n${stale}\n`);

    const result = await healStaleShallow(clone);

    assertEquals(result.dropped.map((d) => d.sha), [stale]);
    assertEquals(result.kept, [real]);
    assertEquals(result.shallowAfter, true);
    assertEquals(await readShallow(clone), `${real}\n`);
    assertEquals(await git(clone, "rev-list", "--count", "HEAD"), "1");
  });
});

Deno.test("a boundary that is an ancestor of a ref, not its tip, is real and kept", async () => {
  await withDir(async (dir) => {
    const repo = await makeRepo(dir);
    const middle = await git(repo, "rev-parse", "HEAD~1");
    await writeFile(shallowFile(repo), `${middle}\n`);
    const result = await healStaleShallow(repo);
    assertEquals(result.dropped, []);
    assertEquals(result.kept, [middle]);
    assertEquals(await readShallow(repo), `${middle}\n`);
  });
});

Deno.test("an entry reached only through a tag or a remote-tracking ref is kept", async () => {
  await withDir(async (dir) => {
    const repo = await makeRepo(dir);
    const side = await danglingCommit(repo, "only a tag reaches this");
    await git(repo, "tag", "keep-me", side);
    const remote = await danglingCommit(repo, "only a remote ref reaches this");
    await git(repo, "update-ref", "refs/remotes/origin/feature", remote);
    await writeFile(shallowFile(repo), `${side}\n${remote}\n`);
    const result = await healStaleShallow(repo);
    assertEquals(result.dropped, []);
    assertEquals([...result.kept].sort(), [side, remote].sort());
  });
});

Deno.test("a shallow file with nothing to drop is not rewritten at all", async () => {
  await withDir(async (dir) => {
    const repo = await makeRepo(dir);
    const middle = await git(repo, "rev-parse", "HEAD~1");
    // No trailing newline: git accepts it, and a rewrite would add one.
    await writeFile(shallowFile(repo), middle);
    const result = await healStaleShallow(repo);
    assertEquals(result.dropped, []);
    assertEquals(await readShallow(repo), middle);
  });
});

Deno.test("healing twice changes nothing the second time", async () => {
  await withDir(async (dir) => {
    const repo = await makeRepo(dir);
    await writeFile(
      shallowFile(repo),
      `${await danglingCommit(repo, "leftover")}\n`,
    );
    assertEquals((await healStaleShallow(repo)).dropped.length, 1);
    const again = await healStaleShallow(repo);
    assertEquals(again.shallowBefore, false);
    assertEquals(again.dropped, []);
  });
});

Deno.test("a shallow file git itself rejects is refused and left untouched", async () => {
  await withDir(async (dir) => {
    const repo = await makeRepo(dir);
    const garbage = "not-a-sha\n";
    await writeFile(shallowFile(repo), garbage);
    await assertRejects(
      () => healStaleShallow(repo),
      Error,
      "GIT_COMMAND_FAILED",
    );
    assertEquals(await readShallow(repo), garbage);
  });
});

Deno.test("an entry git accepts but this parser does not fully understand is refused, not rewritten", async () => {
  await withDir(async (dir) => {
    const repo = await makeRepo(dir);
    // git reads hex case-insensitively; this tool only rewrites what it can
    // account for exactly.
    const upper = `${await git(repo, "rev-parse", "HEAD~1")}\n`.toUpperCase();
    await writeFile(shallowFile(repo), upper);
    assert(await isShallow(repo), "precondition: git accepts the entry");
    await assertRejects(
      () => healStaleShallow(repo),
      Error,
      "SHALLOW_FILE_MALFORMED",
    );
    assertEquals(await readShallow(repo), upper);
  });
});

Deno.test("a directory that is not a repository is an error, never a repair", async () => {
  await withDir(async (dir) => {
    const empty = join(dir, "empty");
    await mkdir(empty);
    await assertRejects(
      () => healStaleShallow(empty),
      Error,
      "GIT_COMMAND_FAILED",
    );
    assertEquals(await readdir(empty), []);
  });
});

Deno.test("when git cannot answer the reachability question nothing is dropped", async () => {
  await withDir(async (dir) => {
    const repo = await makeRepo(dir);
    const stale = await danglingCommit(repo, "leftover");
    await writeFile(shallowFile(repo), `${stale}\n`);
    const before = await readShallow(repo);
    // `for-each-ref` fails (exit 129) instead of answering "no ref has it":
    // an unknown answer is not a "no", so the file must not be rewritten.
    const failing: GitRunner = async (cwd, args) =>
      args[0] === "for-each-ref"
        ? { code: 129, stdout: "", stderr: "boom" }
        : await runGit(cwd, args);
    await assertRejects(
      () => healStaleShallow(repo, { git: failing }),
      Error,
      "GIT_COMMAND_FAILED",
    );
    assertEquals(await readShallow(repo), before);
    assertEquals(await isShallow(repo), true);
  });
});

Deno.test("runGit reports git's own exit code, including a non-zero answer", async () => {
  await withDir(async (dir) => {
    const repo = await makeRepo(dir);
    const ok = await runGit(repo, ["rev-parse", "HEAD"]);
    assertEquals(ok.code, 0);
    assertEquals(ok.stdout.trim().length, 40);
    // `cat-file -e` exits 1 for a well-formed id that is not in the repository:
    // an answer, not a failure, and the heal logic depends on telling them apart.
    const absent = await runGit(repo, ["cat-file", "-e", "0".repeat(40)]);
    assertEquals(absent.code, 1);
    const notARepo = await runGit(dir, ["rev-parse", "HEAD"]);
    assertEquals(notARepo.code, 128);
  });
});

Deno.test("runGit reports a failure to start git as non-zero, never as success", async () => {
  await withDir(async (dir) => {
    const missing = join(dir, "no-such-directory");
    const result = await runGit(missing, ["--version"]);
    assert(
      result.code !== 0,
      "a git that could not start must not read as success",
    );
    assert(
      result.code !== 1,
      "and must not read as the 'absent object' answer",
    );
  });
});

Deno.test("a repository git calls shallow but with no shallow file is reported unchanged", async () => {
  await withDir(async (dir) => {
    const repo = await makeRepo(dir);
    // git says shallow, yet there is nothing to read: a race with another
    // process, or a file removed in between. Nothing to heal, and not an error.
    const saysShallow: GitRunner = async (cwd, args) =>
      args[0] === "rev-parse" && args[1] === "--is-shallow-repository"
        ? { code: 0, stdout: "true\n", stderr: "" }
        : await runGit(cwd, args);
    const result = await healStaleShallow(repo, { git: saysShallow });
    assertEquals(result, {
      shallowBefore: true,
      shallowAfter: true,
      dropped: [],
      kept: [],
    });
    assertEquals(await readShallow(repo), null);
  });
});

Deno.test("the error text never carries a path or a git message", async () => {
  await withDir(async (dir) => {
    const empty = join(dir, "SECRET-DIR-NAME");
    await mkdir(empty);
    try {
      await healStaleShallow(empty);
    } catch (error) {
      assert(error instanceof Error);
      assert(!error.message.includes("SECRET-DIR-NAME"), error.message);
      return;
    }
    throw new Error("expected a refusal");
  });
});
