import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectPolicyDiagnostic,
  createFixedBoundedReader,
  POLICY_PATHS,
} from "../../scripts/ci/runner-policy-diagnostic.mjs";

const observed = (value) => ({
  status: "observed",
  bytes: Buffer.from(value),
});

const fixtureReader = (values, calls = []) => (path, limit) => {
  calls.push({ path, limit });
  return Promise.resolve(values.get(path) ?? { status: "unavailable" });
};

const goodReads = () =>
  new Map([
    [
      POLICY_PATHS.status,
      observed(
        "Name:\tPRIVATE_TOKEN=never-print\nNoNewPrivs:\t1\nSeccomp:\t2\n",
      ),
    ],
    [
      POLICY_PATHS.cgroup,
      observed(
        "0::/system.slice/actions.runner.private-owned.service\n",
      ),
    ],
    [POLICY_PATHS.unprivilegedUsernsClone, observed("1\n")],
    [POLICY_PATHS.maxUserNamespaces, observed("65536\n")],
    [POLICY_PATHS.apparmorRestrictUnprivilegedUserns, observed("0\n")],
  ]);

test("emits only bounded numeric values and a private runner-unit status", async () => {
  const calls = [];
  const result = await collectPolicyDiagnostic(
    fixtureReader(goodReads(), calls),
  );
  assert.deepEqual(calls, [
    { path: POLICY_PATHS.status, limit: 4096 },
    { path: POLICY_PATHS.cgroup, limit: 4096 },
    { path: POLICY_PATHS.unprivilegedUsernsClone, limit: 32 },
    { path: POLICY_PATHS.maxUserNamespaces, limit: 32 },
    { path: POLICY_PATHS.apparmorRestrictUnprivilegedUserns, limit: 32 },
  ]);
  assert.deepEqual(result, {
    seccomp: 2,
    noNewPrivs: 1,
    unprivilegedUsernsClone: 1,
    maxUserNamespaces: 65536,
    apparmorRestrictUnprivilegedUserns: 0,
    currentRunnerUnit: "observed",
  });
  const output = JSON.stringify(result);
  assert(!output.includes("PRIVATE_TOKEN"));
  assert(!output.includes("private-owned"));
  assert(output.length < 512);
});

test("classifies denied and missing reads without exposing errors", async () => {
  const reads = goodReads();
  reads.set(POLICY_PATHS.status, { status: "denied" });
  reads.set(POLICY_PATHS.cgroup, { status: "missing" });
  reads.set(POLICY_PATHS.unprivilegedUsernsClone, { status: "denied" });
  reads.set(POLICY_PATHS.maxUserNamespaces, { status: "missing" });
  reads.set(POLICY_PATHS.apparmorRestrictUnprivilegedUserns, {
    status: "unavailable",
  });
  const result = await collectPolicyDiagnostic(fixtureReader(reads));
  assert.deepEqual(result, {
    seccomp: "denied",
    noNewPrivs: "denied",
    unprivilegedUsernsClone: "denied",
    maxUserNamespaces: "missing",
    apparmorRestrictUnprivilegedUserns: "unavailable",
    currentRunnerUnit: "missing",
  });
});

test("rejects invalid, overflow, ambiguous, and hostile fixture data", async () => {
  const reads = goodReads();
  reads.set(
    POLICY_PATHS.status,
    observed(
      "NoNewPrivs: 2\nSeccomp: 2\nSeccomp: PRIVATE_TOKEN=never-print\n",
    ),
  );
  reads.set(
    POLICY_PATHS.cgroup,
    observed(
      "0::/actions.runner.first.service/actions.runner.second.service/PRIVATE_TOKEN\n",
    ),
  );
  reads.set(POLICY_PATHS.unprivilegedUsernsClone, observed("-1\n"));
  reads.set(POLICY_PATHS.maxUserNamespaces, observed("4294967296\n"));
  reads.set(POLICY_PATHS.apparmorRestrictUnprivilegedUserns, {
    status: "overflow",
  });
  const result = await collectPolicyDiagnostic(fixtureReader(reads));
  assert.deepEqual(result, {
    seccomp: "invalid",
    noNewPrivs: "invalid",
    unprivilegedUsernsClone: "invalid",
    maxUserNamespaces: "invalid",
    apparmorRestrictUnprivilegedUserns: "overflow",
    currentRunnerUnit: "unavailable",
  });
  const output = JSON.stringify(result);
  assert(!output.includes("PRIVATE_TOKEN"));
  assert(!output.includes("first"));
  assert(!output.includes("second"));
});

test("the production reader requests one overflow byte and closes handles", async () => {
  for (const limit of [4096, 32]) {
    const calls = [];
    let closeCalls = 0;
    const reader = createFixedBoundedReader((path, flags) => {
      calls.push({ path, flags });
      return {
        read(buffer, offset, length, position) {
          calls.push({ bufferLength: buffer.length, offset, length, position });
          buffer.fill(65);
          return Promise.resolve({ bytesRead: length, buffer });
        },
        close() {
          closeCalls += 1;
          return Promise.reject(new Error("PRIVATE_TOKEN close failure"));
        },
      };
    });

    const result = await reader(POLICY_PATHS.status, limit);
    assert.deepEqual(result, { status: "overflow" });
    assert.deepEqual(calls, [
      { path: POLICY_PATHS.status, flags: "r" },
      {
        bufferLength: limit + 1,
        offset: 0,
        length: limit + 1,
        position: null,
      },
    ]);
    assert.equal(closeCalls, 1);
    assert(!JSON.stringify(result).includes("PRIVATE_TOKEN"));
  }
});

test("the production reader times out delayed reads and sanitizes errors", async () => {
  let closeCalls = 0;
  const delayedReader = createFixedBoundedReader(() => ({
    read: () => new Promise(() => undefined),
    close: () => {
      closeCalls += 1;
      return Promise.resolve();
    },
  }));
  const started = performance.now();
  assert.deepEqual(await delayedReader(POLICY_PATHS.status, 32), {
    status: "unavailable",
  });
  const elapsed = performance.now() - started;
  assert(elapsed >= 200, `reader returned before 250 ms timeout: ${elapsed}`);
  assert(elapsed < 1_000, `reader exceeded bounded timeout: ${elapsed}`);
  assert.equal(closeCalls, 1);

  for (
    const [code, status] of [
      ["ENOENT", "missing"],
      ["EACCES", "denied"],
      ["EPERM", "denied"],
      ["PRIVATE_TOKEN", "unavailable"],
    ]
  ) {
    const reader = createFixedBoundedReader(() => {
      throw Object.assign(new Error("PRIVATE_TOKEN raw error"), { code });
    });
    const result = await reader(POLICY_PATHS.status, 32);
    assert.deepEqual(result, { status });
    assert(!JSON.stringify(result).includes("PRIVATE_TOKEN"));
  }
});

test("the existing security job runs the diagnostic after its gate", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const workflow = readFileSync(`${root}/.github/workflows/ci.yml`, "utf8");
  const security = workflow.slice(
    workflow.indexOf("  security:\n"),
    workflow.indexOf("  browser:\n"),
  );
  const gate = security.indexOf("      - run: pnpm test:security\n");
  const diagnostic = security.indexOf(
    "      - name: Observe bounded runner namespace policy\n",
  );
  const evidence = security.indexOf(
    "      - name: Write security_tests evidence\n",
  );
  assert(gate >= 0);
  assert(diagnostic > gate);
  assert(evidence > diagnostic);
  assert.match(
    security.slice(diagnostic, evidence),
    /if: always\(\)[\s\S]*timeout-minutes: 1[\s\S]*run: node scripts\/ci\/runner-policy-diagnostic\.mjs/,
  );
  assert(!security.slice(diagnostic, evidence).includes("continue-on-error"));
});
