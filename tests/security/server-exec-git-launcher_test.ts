// The server runs git only through infra/server-exec/git.sh. These tests pin
// that every git command the server issues maps onto a launcher operation,
// that the launcher runs it, and that nothing else gets through: no `-c`, no
// alias, no upload-pack, no other transport, no environment.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  gitLauncherArgs,
  SERVER_GIT_LAUNCHER,
  UnsupportedGitInvocationError,
} from "../../apps/server/src/platform/server-exec.ts";

const decoder = new TextDecoder();

async function launch(
  args: string[],
  options: { env?: Record<string, string>; stdin?: string } = {},
) {
  const child = new Deno.Command(SERVER_GIT_LAUNCHER, {
    args,
    clearEnv: true,
    env: options.env ?? {},
    stdin: options.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (options.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.stdin));
    await writer.close();
  }
  const output = await child.output();
  return { code: output.code, stdout: decoder.decode(output.stdout).trim() };
}

async function git(cwd: string, ...args: string[]) {
  const output = await new Deno.Command("/usr/bin/git", {
    args,
    cwd,
    env: {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
    },
  }).output();
  assertEquals(output.code, 0, decoder.decode(output.stderr));
  return decoder.decode(output.stdout).trim();
}

/** A bare repository with one commit holding `f` = "hi\n". */
async function bareRepository() {
  const root = await Deno.makeTempDir({ prefix: "bakery-git-launcher-" });
  await Deno.mkdir(`${root}/w`);
  await git(`${root}/w`, "init", "-q", "-b", "main");
  await Deno.writeTextFile(`${root}/w/f`, "hi\n");
  await git(`${root}/w`, "add", "f");
  await git(`${root}/w`, "commit", "-qm", "m");
  await git(root, "clone", "-q", "--bare", "w", "r.git");
  return {
    root,
    dir: `${root}/r.git`,
    commit: await git(`${root}/w`, "rev-parse", "HEAD"),
    blob: await git(`${root}/w`, "rev-parse", "HEAD:f"),
  };
}

Deno.test("every git command the server issues maps onto a launcher operation", () => {
  const dir = "/srv/r.git";
  const oid = "a".repeat(40);
  const cases: [string[], string[]][] = [
    [["cat-file", "-t", oid], ["cat-file-type", dir, oid]],
    [["cat-file", "-s", oid], ["cat-file-size", dir, oid]],
    [["cat-file", "blob", oid], ["cat-file", dir, "blob", oid]],
    [["rev-parse", "--is-bare-repository"], ["is-bare", dir]],
    [["rev-parse", "--is-shallow-repository"], ["is-shallow", dir]],
    [
      ["rev-parse", "--verify", "--end-of-options", `${oid}^{commit}`],
      ["verify-commit", dir, oid],
    ],
    [
      ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
      ["verify-commit", dir, "FETCH_HEAD"],
    ],
    [
      ["hash-object", "-t", "blob", "--stdin", "--no-filters"],
      ["hash-object", dir, "blob"],
    ],
    [["init", "--bare"], ["init-bare", dir]],
    [
      ["ls-tree", "-r", "-z", "--full-tree", "FETCH_HEAD", "--"],
      ["ls-tree", dir],
    ],
    [
      ["ls-tree", "-r", "-z", "--full-tree", "FETCH_HEAD", "--", "skills/a"],
      ["ls-tree", dir, "skills/a"],
    ],
    [
      [
        "-c",
        "credential.helper=",
        "-c",
        "core.askPass=",
        "-c",
        "http.followRedirects=false",
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "--depth=1",
        "--filter=blob:none",
        "--",
        "https://example.test/r.git",
        "main",
      ],
      ["fetch", dir, "https://example.test/r.git", "main"],
    ],
  ];
  for (const [args, expected] of cases) {
    assertEquals(gitLauncherArgs(dir, args), expected, args.join(" "));
  }
  for (
    const args of [
      ["-c", "alias.x=!sh", "x"],
      ["log"],
      ["cat-file", "--batch"],
      ["fetch", "--upload-pack=sh", "https://example.test/r.git"],
      ["rev-parse", "HEAD"],
      ["ls-tree", "-r", "HEAD"],
    ]
  ) {
    assertThrows(
      () => gitLauncherArgs(dir, args),
      UnsupportedGitInvocationError,
      undefined,
      args.join(" "),
    );
  }
});

Deno.test("the git launcher runs the server's reads against a real repository", async () => {
  const repo = await bareRepository();
  try {
    assertEquals(await launch(["is-bare", repo.dir]), {
      code: 0,
      stdout: "true",
    });
    assertEquals(await launch(["is-shallow", repo.dir]), {
      code: 0,
      stdout: "false",
    });
    assertEquals(
      (await launch(["verify-commit", repo.dir, repo.commit])).stdout,
      repo.commit,
    );
    assertEquals(
      (await launch(["cat-file-type", repo.dir, repo.blob])).stdout,
      "blob",
    );
    assertEquals(
      (await launch(["cat-file-size", repo.dir, repo.blob])).stdout,
      "3",
    );
    assertEquals(
      (await launch(["cat-file", repo.dir, "blob", repo.blob])).stdout,
      "hi",
    );
    assertEquals(
      (await launch(["hash-object", repo.dir, "blob"], { stdin: "hi\n" }))
        .stdout,
      repo.blob,
    );
    const fresh = `${repo.root}/fresh.git`;
    assertEquals((await launch(["init-bare", fresh])).code, 0);
    assertEquals((await launch(["is-bare", fresh])).stdout, "true");
  } finally {
    await Deno.remove(repo.root, { recursive: true });
  }
});

Deno.test("the git launcher refuses every argument list it does not define", async () => {
  const repo = await bareRepository();
  try {
    const { dir, blob } = repo;
    for (
      const args of [
        [],
        ["is-bare"],
        ["nope", dir],
        ["is-bare", "relative/r.git"],
        ["is-bare", `${dir}/../r.git`],
        ["is-bare", `${dir} -c alias.x=!sh`],
        ["is-bare", dir, "extra"],
        ["cat-file", dir, "blob", "--batch"],
        ["cat-file", dir, "-p", blob],
        ["cat-file-type", dir, "-c"],
        ["cat-file-type", dir, blob.toUpperCase()],
        ["cat-file", dir, "blob", blob, "extra"],
        ["verify-commit", dir, "HEAD"],
        ["verify-commit", dir, "--all"],
        ["hash-object", dir, "-w"],
        ["ls-tree", dir, "-x"],
        ["ls-tree", dir, "../up"],
        ["ls-tree", dir, "/etc"],
        ["ls-tree", dir, "a", "b"],
        ["fetch", dir, "ext::sh -c id", "main"],
        ["fetch", dir, "file:///etc", "main"],
        ["fetch", dir, "ssh://example.test/r.git", "main"],
        ["fetch", dir, "http://example.test/r.git", "main"],
        ["fetch", dir, "https://example.test/r.git", "--upload-pack=sh"],
        ["fetch", dir, "https://example.test/r.git", "a..b"],
        ["fetch", dir, "https://example.test/r .git", "main"],
        ["fetch", dir, "https://example.test/r.git"],
      ]
    ) {
      assertEquals((await launch(args)).code, 64, JSON.stringify(args));
    }
  } finally {
    await Deno.remove(repo.root, { recursive: true });
  }
});

Deno.test("neither the caller's environment nor the repository's config can run a command", async () => {
  const repo = await bareRepository();
  try {
    const marker = `${repo.root}/ran`;
    // Repository config that would run a command if git honoured it here.
    await Deno.writeTextFile(
      `${repo.dir}/config`,
      `\n[core]\n\tpager = touch ${marker}-pager\n\tfsmonitor = touch ${marker}-fsmonitor\n` +
        `\thooksPath = ${repo.root}\n[alias]\n\tx = !touch ${marker}-alias\n`,
      { append: true },
    );
    const result = await launch(["cat-file", repo.dir, "blob", repo.blob], {
      env: {
        GIT_DIR: "/etc",
        GIT_CONFIG_PARAMETERS: `'core.pager'='touch ${marker}-env'`,
        GIT_SSH_COMMAND: `touch ${marker}-ssh`,
        GIT_EXTERNAL_DIFF: `touch ${marker}-diff`,
        PAGER: `touch ${marker}-pager-env`,
      },
    });
    assertEquals(result, { code: 0, stdout: "hi" });
    const ran: string[] = [];
    for await (const entry of Deno.readDir(repo.root)) {
      if (entry.name.startsWith("ran")) ran.push(entry.name);
    }
    assertEquals(ran, []);
  } finally {
    await Deno.remove(repo.root, { recursive: true });
  }
});

Deno.test("the git launcher is an executable file with no caller-chosen command", async () => {
  const script = await Deno.readTextFile(SERVER_GIT_LAUNCHER);
  assert(((await Deno.stat(SERVER_GIT_LAUNCHER)).mode! & 0o111) !== 0);
  // Every exec is env -i with a fixed command; no "$@" reaches git except
  // through local_git, whose arguments are fixed per operation.
  const commands = script.split("\n").filter((line) =>
    !line.trimStart().startsWith("#")
  ).join("\n");
  assertEquals(commands.match(/\bexec\b/g)?.length, 2);
  assertEquals(
    commands.match(/exec \/usr\/bin\/env -i \$ENVIRONMENT/g)?.length,
    2,
  );
  assert(!/--upload-pack|alias\.|sshCommand=|eval /.test(commands));
});
