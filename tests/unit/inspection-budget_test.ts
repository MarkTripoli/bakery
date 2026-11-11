import { assert, assertEquals } from "@std/assert";
import {
  encodedByteLength,
  INSPECTION_DERIVED_CHECK_ALLOWANCE,
  INSPECTION_FIXED_CHECKS,
  INSPECTION_MAX_CHECKS,
  INSPECTION_MAX_PATH_LENGTH,
  INSPECTION_PUBLISH_CHECK_COUNT,
  INSPECTION_PUBLISH_OVERHEAD_BYTES,
  INSPECTION_RESULT_BYTES_MAX,
  inspectionInputWithinBudget,
  maxPublishableConfigBytes,
  profileConfigFitsInspectionBudget,
} from "../../apps/server/src/modules/projects/inspection-budget.ts";
import { deriveRepositoryInspectionConfig } from "../../apps/server/src/modules/projects/repository-inspect.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { WORKER_RESULT_MAX_BYTES } from "../../apps/worker/src/types.ts";
import {
  RepositoryInspectionCheckPolicySchema,
  RepositoryInspectionJobInputSchema,
  RepositoryInspectionPathSchema,
} from "../../packages/contracts/src/repository-inspection.ts";
import { RepositoryProfileConfigSchema } from "../../packages/contracts/src/repository-profile-config.ts";
import {
  ballastRules,
  baseProfileConfig,
  configBytesWithRules,
  maxFillerChars,
} from "../helpers/repository-rule-entries.ts";

Deno.test("the reserved schema bounds are the schema's own", () => {
  const check = (id: number) => ({
    id: `c${id}`,
    template: "unsupported.v1",
    tool: null,
    paths: [],
    required: true,
  });
  const policy = (count: number) => ({
    schemaVersion: 1,
    platform: "linux",
    tools: [{ tool: "git", required: true }],
    checks: Array.from({ length: count }, (_, id) => check(id)),
  });
  assertEquals(
    RepositoryInspectionCheckPolicySchema.safeParse(
      policy(INSPECTION_MAX_CHECKS),
    ).success,
    true,
  );
  assertEquals(
    RepositoryInspectionCheckPolicySchema.safeParse(
      policy(INSPECTION_MAX_CHECKS + 1),
    ).success,
    false,
  );
  assertEquals(
    RepositoryInspectionPathSchema.safeParse(
      "a".repeat(INSPECTION_MAX_PATH_LENGTH),
    ).success,
    true,
  );
  assertEquals(
    RepositoryInspectionPathSchema.safeParse(
      "a".repeat(INSPECTION_MAX_PATH_LENGTH + 1),
    ).success,
    false,
  );
  // The inspection result the server accepts is the worker's result cap.
  assertEquals(INSPECTION_RESULT_BYTES_MAX, WORKER_RESULT_MAX_BYTES);
  assertEquals(
    INSPECTION_PUBLISH_CHECK_COUNT,
    INSPECTION_FIXED_CHECKS + INSPECTION_DERIVED_CHECK_ALLOWANCE,
  );
});

Deno.test("boundary arithmetic of the publish bound", () => {
  const ceiling = maxPublishableConfigBytes();
  assert(profileConfigFitsInspectionBudget(ceiling));
  assert(!profileConfigFitsInspectionBudget(ceiling + 1));
  assertEquals(
    ceiling,
    INSPECTION_RESULT_BYTES_MAX - 8192 -
      INSPECTION_PUBLISH_CHECK_COUNT * 512 -
      INSPECTION_PUBLISH_OVERHEAD_BYTES,
  );
  // Without the reservation the same config would still have fit.
  assert(
    inspectionInputWithinBudget(ceiling + 1, 0, INSPECTION_RESULT_BYTES_MAX),
  );
  // Onboarding's own rule is unchanged (64 KiB report).
  assert(inspectionInputWithinBudget(50_000, 4));
  assert(!inspectionInputWithinBudget(100_001, 0));
  assert(!inspectionInputWithinBudget(60_000, 8));
});

async function envelope(manifests: number) {
  const entries: Array<{
    path: string;
    mode: "100644";
    sha256: string;
    contentBase64: string;
  }> = [];
  const add = async (path: string, content: string) => {
    entries.push({
      path,
      mode: "100644",
      sha256: await sha256Hex(content),
      contentBase64: btoa(content),
    });
  };
  for (let index = 0; index < manifests; index++) {
    // 511-byte paths: the longest the path schema admits, one per check.
    const directory = `${index}${"d".repeat(INSPECTION_MAX_PATH_LENGTH - 10)}`;
    await add(
      `${directory}/package.json`,
      JSON.stringify({ scripts: { c: "node --check x.js" } }),
    );
    await add(`${directory}/x.js`, "const a = 1;");
  }
  entries.sort((a, b) => a.path < b.path ? -1 : 1);
  return {
    organizationId: "00000000-0000-4000-8000-000000000001",
    applicationId: "00000000-0000-4000-8000-000000000002",
    repositoryId: "00000000-0000-4000-8000-000000000003",
    source: {
      mappingRevision: "x".repeat(128),
      mappingDigest: "a".repeat(64),
      baseSha: "b".repeat(40),
      manifestDigest: await sha256Hex(canonicalJson(entries.map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        sha256: entry.sha256,
        size: atob(entry.contentBase64).length,
      })))),
    },
    entries,
  };
}

Deno.test("a config at the ceiling onboards with the allowance of maximal derived checks", async () => {
  const ceiling = maxPublishableConfigBytes();
  const rules = ballastRules(maxFillerChars(ceiling));
  const config = RepositoryProfileConfigSchema.parse({
    ...baseProfileConfig,
    repositoryRules: { entries: rules },
  });
  const configBytes = configBytesWithRules(rules);
  assert(configBytes <= ceiling);
  const source = await envelope(INSPECTION_DERIVED_CHECK_ALLOWANCE);
  const observed = deriveRepositoryInspectionConfig(config, source);
  assertEquals(
    observed.checkPolicy.checks.length,
    INSPECTION_PUBLISH_CHECK_COUNT,
  );
  const uuid = "00000000-0000-4000-8000-000000000009";
  const input = RepositoryInspectionJobInputSchema.parse({
    inspectionId: uuid,
    jobId: uuid,
    organizationId: source.organizationId,
    applicationId: source.applicationId,
    repositoryId: source.repositoryId,
    baseline: {
      profileId: uuid,
      revision: 2_147_483_647,
      digest: "c".repeat(64),
      repositoryVersion: 2_147_483_647,
      defaultBranch: "字".repeat(255),
    },
    profile: {
      id: uuid,
      revision: 2_147_483_647,
      digest: "d".repeat(64),
      config: observed,
    },
    source: {
      ...source.source,
      envelopeDigest: "e".repeat(64),
      envelopeBytes: 8 * 1024 * 1024,
      decodedBytes: 4 * 1024 * 1024,
      entryCount: 1024,
    },
  });
  const inputBytes = encodedByteLength(canonicalJson(input));
  // The reservation covers what onboarding really adds to the config...
  assert(inputBytes - configBytes <= INSPECTION_PUBLISH_OVERHEAD_BYTES);
  // ...so the real input passes onboarding's own rule and the result cap.
  assert(
    inspectionInputWithinBudget(inputBytes, observed.checkPolicy.checks.length),
  );
  assert(
    inspectionInputWithinBudget(
      inputBytes,
      observed.checkPolicy.checks.length,
      INSPECTION_RESULT_BYTES_MAX,
    ),
  );
});
