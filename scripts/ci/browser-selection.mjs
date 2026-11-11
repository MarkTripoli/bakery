import { execFileSync } from "node:child_process";
import { parseNameStatusZ } from "./classify-changes.ts";

const pageConsumers = [
  [
    /^apps\/web\/src\/pages\/(TasksPage|TaskArtifactPane|TaskStartRun|TaskRunSection|TaskRunControls|NewTaskComposer|task-timeline|task-session-view|task-read-sync|task-composer-labels|task-composer-intent|run-admission-refusal|artifact-media)\.(ts|tsx)$/,
    ["tasks.spec.ts", "task-composer.spec.ts", "artifact-retrieval.spec.ts"],
  ],
  [/^apps\/web\/src\/pages\/ArtifactRetrievalPage\.tsx$/, [
    "artifact-retrieval.spec.ts",
    "tasks.spec.ts",
  ]],
  [
    /^apps\/web\/src\/pages\/(ProjectsOnboardingPage\.tsx|projects-onboarding\/)/,
    [
      "projects-onboarding.spec.ts",
      "projects-onboarding-recovery.spec.ts",
      "repository-profile-real-api.spec.ts",
      "task-composer.spec.ts",
    ],
  ],
];

// Only known non-runtime inputs can avoid broad consumer coverage.
const independentInput =
  /^(docs\/|learnings\/|\.reports\/)|^scripts\/ci\/(annotate-semantic|validate-semantic|validate-docs)\.ts$/;

export function selectBrowserChecks(entries) {
  const webSpecs = new Set();
  if (entries.length === 0) {
    return {
      full: true,
      webSpecs: [],
      storybook: true,
      reason: "empty or unavailable diff",
    };
  }
  if (
    entries.some((entry) =>
      entry.status !== "M" &&
      entry.paths.some((path) => path.startsWith("apps/web/tests/"))
    )
  ) {
    return {
      full: true,
      webSpecs: [],
      storybook: true,
      reason: "added/renamed/deleted or unknown-status browser test",
    };
  }
  const paths = entries.flatMap((entry) => entry.paths);
  for (const path of paths) {
    if (
      path.startsWith("docs/technical-design/") ||
      path.startsWith("packages/ui/") ||
      path.startsWith("packages/i18n/")
    ) {
      return {
        full: true,
        webSpecs: [],
        storybook: true,
        reason: `shared UI input: ${path}`,
      };
    }
    if (independentInput.test(path)) continue;
    if (
      /^apps\/web\/tests\/(auth-journey|settings-journey|account-security-journey|repository-profile-real-api|organization-access-real-api|installation-integrations-real-api|organization-integrations-fake-github|browser-artifact-core)\.spec\.ts$/
        .test(path)
    ) {
      return {
        full: true,
        webSpecs: [],
        storybook: true,
        reason: `shared-admin fixture ordering: ${path}`,
      };
    }
    if (/^apps\/web\/tests\/[^/]+\.spec\.ts$/.test(path)) {
      webSpecs.add(path.split("/").at(-1));
      continue;
    }
    const consumers = pageConsumers.find(([pattern]) => pattern.test(path));
    if (consumers) {
      for (const spec of consumers[1]) webSpecs.add(spec);
      if (
        path === "apps/web/src/pages/task-session-view.tsx" ||
        path === "apps/web/src/pages/TasksPage.tsx"
      ) {
        webSpecs.add("shell.spec.ts");
      }
      continue;
    }
    // Shared auth/cache/router, backend authority/storage, test helpers,
    // toolchain and unknown ownership all retain the exhaustive oracle.
    return {
      full: true,
      webSpecs: [],
      storybook: true,
      reason: `shared or unknown input: ${path}`,
    };
  }
  return {
    full: false,
    webSpecs: [...webSpecs].sort(),
    storybook: false,
    reason: "known consumer ownership",
  };
}

export function readBrowserSelection(env = process.env, git = execFileSync) {
  const selected = readRawSelection(env, git);
  // Main pushes cap the exhaustive web oracle at the required core consumers:
  // the unknown/shared-ownership fallback would otherwise run the ~930-test
  // matrix on every push, while the nightly schedule and manual dispatch keep
  // full coverage. Only selections that fell back to full are capped; a
  // genuinely narrow consumer selection keeps its affected specs.
  return env.BAKERY_BROWSER_MAX_MODE === "core" && selected.full
    ? {
      full: false,
      webSpecs: [],
      storybook: selected.storybook,
      reason: `push capped to core consumers (was: ${selected.reason})`,
    }
    : selected;
}

function readRawSelection(env = process.env, git = execFileSync) {
  if (env.BAKERY_BROWSER_COVERAGE === "full") {
    return {
      full: true,
      webSpecs: [],
      storybook: true,
      reason: "explicit full coverage",
    };
  }
  if (env.BAKERY_BROWSER_COVERAGE !== "affected") {
    throw new Error("BAKERY_BROWSER_COVERAGE must be affected or full");
  }
  try {
    if (
      !/^[0-9a-f]{40}$/.test(env.BASE_SHA ?? "") ||
      !/^[0-9a-f]{40}$/.test(env.CANDIDATE_SHA ?? "")
    ) {
      throw new Error("immutable diff SHAs unavailable");
    }
    const output = git("git", [
      "diff",
      "--no-ext-diff",
      "--name-status",
      "--find-renames",
      "-z",
      env.BASE_SHA,
      env.CANDIDATE_SHA,
    ], { encoding: "utf8" });
    const entries = parseNameStatusZ(output);
    return entries === null
      ? {
        full: true,
        webSpecs: [],
        storybook: true,
        reason: "malformed git change statuses",
      }
      : selectBrowserChecks(entries);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return {
      full: true,
      webSpecs: [],
      storybook: true,
      reason: `diff fallback: ${error.message}`,
    };
  }
}

export function retainExistingConsumers(selection, testExists) {
  return selection.webSpecs.some((spec) => !testExists(spec))
    ? {
      full: true,
      webSpecs: [],
      storybook: true,
      reason: "removed/renamed consumer test: full fallback",
    }
    : selection;
}
