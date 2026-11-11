import { assert, assertEquals, assertMatch } from "@std/assert";
import { parseDeployConfig } from "../../scripts/deploy/railway-deploy.ts";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const read = (path: string): Promise<string> =>
  Deno.readTextFile(`${root}${path}`);

const workflowPath = ".github/workflows/deploy-qa.yml";

Deno.test("deploy-qa runs only after green main CI or a main dispatch, serialised and bounded", async () => {
  const workflow = await read(workflowPath);
  assertMatch(
    workflow,
    /workflow_run:\n\s+workflows: \["Bakery CI"\]\n\s+types: \[completed\]\n\s+branches: \[main\]/,
  );
  assert(
    workflow.includes("github.event.workflow_run.conclusion == 'success'"),
  );
  assert(workflow.includes("github.event.workflow_run.event == 'push'"));
  assert(
    workflow.includes(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    ),
  );
  assert(workflow.includes("github.ref == 'refs/heads/main'"));
  assert(!/^\s+pull_request/m.test(workflow));
  assertMatch(
    workflow,
    /concurrency:\n\s+group: deploy-qa\n\s+cancel-in-progress: false/,
  );
  // Above railway-deploy.ts's rollout cap, so a stuck rollout fails with a
  // report instead of being killed mid-poll.
  assertMatch(workflow, /timeout-minutes: 150\b/);
  assertMatch(workflow, /runs-on: \[self-hosted, hetzner, linux, x64\]/);
});

// The job timeout and the script's own cap are two numbers that have to agree:
// if the job dies first, the rollout is killed mid-poll and reports nothing,
// which is how a deploy failure becomes invisible.
Deno.test("the job timeout outlasts the script's own rollout cap", async () => {
  const workflow = await read(workflowPath);
  const declared = workflow.match(/timeout-minutes: (\d+)\b/);
  assert(declared, "deploy-qa must declare timeout-minutes");
  const config = parseDeployConfig(["--sha", "a".repeat(40)], (name) =>
    ({
      GITHUB_REPOSITORY: "MarkTripoli/bakery",
      RAILWAY_TOKEN: "token",
      GITHUB_TOKEN: "token",
      QA_URL: "https://bakery.marktrip.dev",
      RAILWAY_QA_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
      RAILWAY_QA_ENVIRONMENT_ID: "22222222-2222-4222-8222-222222222222",
      RAILWAY_QA_API_SERVICE_ID: "44444444-4444-4444-8444-444444444444",
      RAILWAY_QA_DISPATCHER_SERVICE_ID: "55555555-5555-4555-8555-555555555555",
      RAILWAY_QA_WEB_SERVICE_ID: "66666666-6666-4666-8666-666666666666",
    })[name]);
  assert(
    Number(declared[1]) > config.rolloutTimeoutMs / 60_000,
    `timeout-minutes ${declared[1]} must exceed the ${
      config.rolloutTimeoutMs / 60_000
    } min rollout cap`,
  );
});

Deno.test("deploy-qa is read-only and takes one secret, the project token", async () => {
  const workflow = await read(workflowPath);
  assertMatch(workflow, /^permissions:\n {2}contents: read\n/m);
  assert(!/:\s*write\b/.test(workflow));
  const secrets = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) =>
    m[1]
  );
  assertEquals(secrets, ["RAILWAY_QA_TOKEN"]);
  // Untrusted dispatch inputs reach the shell only through env, never inline.
  const runBlocks = workflow.split(/^\s+run: /m).slice(1).join("\n");
  assert(!/\$\{\{\s*inputs\./.test(runBlocks));
  assert(!/\$\{\{\s*github\.event\./.test(runBlocks));
});

Deno.test("deploy-qa pins actions by commit and the Railway CLI by checksum", async () => {
  const workflow = await read(workflowPath);
  for (const match of workflow.matchAll(/uses: ([^\s@]+)@(\S+)/g)) {
    assertMatch(match[2], /^[0-9a-f]{40}$/, `${match[1]} must be pinned`);
  }
  assertMatch(workflow, /RAILWAY_CLI_VERSION: "5\.71\.0"/);
  assertMatch(workflow, /RAILWAY_CLI_SHA256: [0-9a-f]{64}\n/);
  assert(workflow.includes("sha256sum --check --status"));
  assert(!/curl[^\n]*\|\s*(ba)?sh/.test(workflow));
  // The Dockerfiles require the stamp; it must be written before the upload.
  assert(
    workflow.indexOf(".bakery-release-sha") <
      workflow.indexOf("deno run --no-prompt"),
  );
});

Deno.test("deploy-qa grants the script exactly the environment variables it reads", async () => {
  const workflow = await read(workflowPath);
  const script = await read("scripts/deploy/railway-deploy.ts");
  const flags = /--allow-env=(\S+)/.exec(workflow)?.[1] ?? "";
  const granted = flags.replace(/\\$/, "").split(",").sort();
  const read_ = new Set<string>();
  for (const match of script.matchAll(/\benv\("([A-Z0-9_]+)"\)/g)) {
    read_.add(match[1]);
  }
  for (const [, name] of script.matchAll(/SERVICE_ID_ENV[^]*?\{([^}]+)\}/g)) {
    for (const id of name.matchAll(/"(RAILWAY_QA_[A-Z_]+)"/g)) read_.add(id[1]);
  }
  assertEquals(granted, [...read_].sort());
  assert(workflow.includes("--allow-run=railway,curl "));
  assert(!/--allow-(all|run |net|write|read)/.test(workflow));
  // Every granted variable is supplied to the step.
  for (const name of granted) {
    assert(
      workflow.includes(`${name}: `),
      `${name} is not set in the workflow`,
    );
  }
});

Deno.test("deploy-qa skips a candidate that predates the deploy script instead of failing", async () => {
  const workflow = await read(workflowPath);
  // The check runs right after checkout and before anything that needs the script.
  const check = workflow.indexOf("id: script");
  assert(check > workflow.indexOf("actions/checkout@"));
  assert(check < workflow.indexOf("denoland/setup-deno@"));
  assert(workflow.includes("[ -f scripts/deploy/railway-deploy.ts ]"));
  // Every step after the check is conditioned on it, so none runs without the script.
  const [checkStep, ...after] = workflow.slice(check).split(/^ {6}- /m);
  assert(after.length >= 4, "expected the deno, stamp, CLI and deploy steps");
  // A real `if:` line at step level; a commented-out guard must not pass.
  const guardLine = /^ {8}if: steps\.script\.outputs\.present == 'true'$/m;
  for (const step of after) {
    assertMatch(step, guardLine, `step lacks the script guard:\n${step}`);
  }
  // A candidate without the script skips on a push-driven run and fails a dispatch.
  assert(checkStep.includes('echo "present=true" >> "$GITHUB_OUTPUT"'));
  assert(checkStep.includes('echo "present=false" >> "$GITHUB_OUTPUT"'));
  assert(checkStep.includes("EVENT_NAME: ${{ github.event_name }}"));
  const dispatch =
    /elif \[ "\$EVENT_NAME" = workflow_dispatch \]; then\n([^]*?)\n {10}else\n/
      .exec(checkStep)?.[1] ?? "";
  assert(
    dispatch.includes("::error::"),
    "dispatch branch must annotate an error",
  );
  assertMatch(dispatch, /^ {12}exit 1$/m);
});
