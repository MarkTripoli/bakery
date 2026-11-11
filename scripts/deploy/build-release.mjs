import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { commit, digest, manifest } from "./release.mjs";

const run = promisify(execFile);

async function githubApi(path) {
  const response = await run("gh", ["api", path], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(response.stdout);
}

export async function authorizeCandidate(sha, repository, api = githubApi) {
  commit(sha);
  if (
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
    repository.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("DEPLOY_REPOSITORY_INVALID");
  }
  const runs = await api(
    `repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=100`,
  );
  const successful = runs.workflow_runs?.find((candidate) =>
    candidate.head_sha === sha && candidate.head_branch === "main" &&
    candidate.event === "push" && candidate.status === "completed" &&
    candidate.conclusion === "success" &&
    candidate.repository?.full_name === repository &&
    candidate.head_repository?.full_name === repository
  );
  if (!successful) throw new Error("TRUSTED_MAIN_CI_REQUIRED");
  const main = await api(`repos/${repository}/git/ref/heads/main`);
  if (main.object?.sha !== sha) throw new Error("MAIN_CANDIDATE_SUPERSEDED");
  return successful.id;
}

export async function promoteUploadedRelease(sha, repository, operations) {
  await authorizeCandidate(sha, repository, operations.api);
  // Final metadata authorization point; GitHub main is not locked across SSH/host execution.
  await operations.deploy();
}

async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (entry.isFile()) output.push(path);
  }
  return output.sort();
}

export async function buildRelease(root, sha, destination) {
  commit(sha);
  if (process.platform !== "linux" || process.arch !== "arm64") {
    throw new Error("ARM64_BUILD_REQUIRED");
  }
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout
    .trim();
  if (head !== sha) throw new Error("BUILD_CHECKOUT_MISMATCH");
  await run("git", ["diff", "--quiet", "HEAD", "--"], { cwd: root });
  for (
    const name of [
      "SENTRY_AUTH_TOKEN",
      "SENTRY_ORG",
      "SENTRY_PROJECT",
      "VITE_SENTRY_DSN",
    ]
  ) {
    if (!process.env[name]?.trim()) throw new Error(`BUILD_REQUIRES_${name}`);
  }
  const scratch = await mkdtemp(join(tmpdir(), "bakery-release-"));
  try {
    const source = join(scratch, "source");
    await mkdir(source);
    await run(
      "git",
      ["archive", "--output", join(scratch, "source.tar"), sha],
      { cwd: root },
    );
    await run("tar", ["-xf", join(scratch, "source.tar"), "-C", source]);
    // The actual Vite build owns upload; no second build or standalone SDK smoke.
    await run("pnpm", ["--filter", "@bakery/web", "build"], {
      cwd: root,
      env: {
        ...process.env,
        BAKERY_ENV: "production",
        VITE_SENTRY_ENABLED: "true",
        VITE_SENTRY_ENVIRONMENT: "production",
        VITE_SENTRY_RELEASE: `bakery@${sha}`,
        // Upload is declared here, not inferred: this path already refuses to
        // run without the token above, so a production release always uploads
        // and its frames always resolve to TypeScript.
        SENTRY_UPLOAD_SOURCEMAPS: "true",
      },
      maxBuffer: 8 * 1024 * 1024,
    });
    await cp(join(root, "apps/web/dist"), join(source, "apps/web/dist"), {
      recursive: true,
    });
    // Preserve pnpm's relative workspace links; every native dependency is ARM64.
    for (
      const workspace of [
        "",
        ...await workspaceDirectories(root, "apps"),
        ...await workspaceDirectories(root, "packages"),
      ]
    ) {
      const modules = join(root, workspace, "node_modules");
      try {
        await cp(modules, join(source, workspace, "node_modules"), {
          recursive: true,
          verbatimSymlinks: true,
        });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const migrations = {};
    for (const path of await files(join(source, "apps/server/src"))) {
      const rel = relative(source, path);
      if (rel.includes("/migrations/") && /\.(sql|ts)$/.test(rel)) {
        migrations[rel] = digest(await readFile(path));
      }
    }
    const assets = {};
    for (const path of await files(join(source, "apps/web/dist"))) {
      if (path.endsWith(".map")) throw new Error("PUBLIC_SOURCE_MAP_PRESENT");
      const rel = relative(join(source, "apps/web/dist"), path);
      if (rel.startsWith("assets/")) assets[rel] = digest(await readFile(path));
    }
    const policy = JSON.parse(
      await readFile(
        join(source, "infra/production/migration-policy.json"),
        "utf8",
      ),
    );
    const release = manifest({
      format: 1,
      sha,
      architecture: "arm64",
      release: `bakery@${sha}`,
      migrations,
      assets,
      expand: policy.expand,
    }, sha);
    await writeFile(
      join(source, "release.json"),
      `${JSON.stringify(release, null, 2)}\n`,
    );
    await writeFile(
      join(source, "apps/web/dist/_release.json"),
      `${JSON.stringify({ sha })}\n`,
    );
    await mkdir(destination, { recursive: true });
    const archive = join(destination, `${sha}.tar.gz`);
    await run("tar", ["-czf", archive, "-C", source, "."]);
    await writeFile(
      `${archive}.sha256`,
      `${digest(await readFile(archive))}  ${sha}.tar.gz\n`,
    );
    return archive;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function workspaceDirectories(root, parent) {
  return (await readdir(join(root, parent), { withFileTypes: true }))
    .filter((e) => e.isDirectory()).map((e) => `${parent}/${e.name}`);
}

if (
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, ...args] = process.argv.slice(2);
  const operation = command === "authorize"
    ? authorizeCandidate(args[0], args[1])
    : command === "promote"
    ? promote(args)
    : buildRelease(process.cwd(), command, args[0]);
  operation.catch(
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}

async function promote([sha, repository, checksum, host, key, knownHosts]) {
  commit(sha);
  if (
    !/^[a-f0-9]{64}$/.test(checksum) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)
  ) {
    throw new Error("DEPLOY_ARGUMENTS_INVALID");
  }
  await promoteUploadedRelease(sha, repository, {
    api: githubApi,
    deploy: () =>
      run("ssh", [
        "-i",
        key,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${knownHosts}`,
        `bakery-deploy@${host}`,
        `deploy ${sha} ${checksum}`,
      ], { timeout: 35 * 60_000, maxBuffer: 1024 * 1024 }),
  });
}
