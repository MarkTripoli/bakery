import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseDocument } from "yaml";
import {
  assertCandidateWorkflowLabels,
  assertWorkflowPolicy,
  parseRunnerLabelSets,
} from "../../scripts/ci/runner-label-policy.mjs";

const ROOT_DIR = fileURLToPath(new URL("../..", import.meta.url));
const WORKFLOW_DIR = join(ROOT_DIR, ".github/workflows");

const workflow = (source) => `name: fixture\non: push\n${source}`;
const candidateLabels = (source) =>
  assertCandidateWorkflowLabels("fixture.yml", workflow(source));
const rejectsCandidate = (source, expectedMessage) => {
  assert.throws(() => candidateLabels(source), (error) => {
    assert(error instanceof Error);
    assert.match(error.message, expectedMessage);
    return true;
  });
};
const rejectsCompleteCandidate = ({ source, expectedMessage }) => {
  assert.throws(
    () => assertCandidateWorkflowLabels("fixture.yml", source),
    (error) => {
      assert(error instanceof Error);
      assert.match(error.message, expectedMessage);
      return true;
    },
  );
};

const completeAstraFixtures = [
  {
    name: "Astra quoted job-name decoy",
    source: String.raw`name: probe
on: push
jobs:
  build:
    name: "example
      runs-on: ubuntu-latest
      "
    "\u0072uns-on": trusted-verifier
    steps:
      - run: echo ok
`,
    expectedMessage: /candidate workflow requests trusted-verifier/,
  },
  {
    name: "Astra quoted workflow-name decoy",
    source: String.raw`name: "example
  jobs:
    build:
      runs-on: ubuntu-latest
  "
on: push
jobs: {build: {"\u0072uns-on": trusted-verifier, steps: [{run: echo ok}]}}
`,
    expectedMessage: /candidate workflow requests trusted-verifier/,
  },
];

const fableFixtures = [
  {
    name: "Fable flow-map scalar decoy",
    source: String.raw`name: probe
on: push
jobs:
  build:
    {
      steps: [{run: echo ok}],
      "\u0072uns-on": trusted-verifier,
      name: "x
        runs-on: ubuntu-latest
        y"
    }
`,
    expectedMessage: /candidate workflow requests trusted-verifier/,
  },
  {
    name: "Fable explicit-key scalar decoy",
    source: String.raw`name: probe
on: push
jobs:
  build:
    env:
      A: "x
        runs-on: ubuntu-latest
        y"
    ? "\u0072uns-on"
    : trusted-verifier
    steps:
      - run: echo ok
`,
    expectedMessage: /candidate workflow requests trusted-verifier/,
  },
  {
    name: "Fable action-input scalar decoy",
    source: String.raw`name: probe
on: push
jobs:
  build:
    steps:
      - uses: example/action
        with:
          ref: "x
            runs-on: ubuntu-latest
            y"
    ? "\u0072uns-on"
    : trusted-verifier
`,
    expectedMessage: /candidate workflow requests trusted-verifier/,
  },
  {
    name: "Fable nested-flow scalar decoy",
    source: String.raw`name: probe
on: push
jobs:
  build:
    {
      steps: [{run: echo ok}],
      "\u0072uns-on": trusted-verifier,
      env: {
        runs-on: ubuntu-latest
      }
    }
`,
    expectedMessage: /candidate workflow requests trusted-verifier/,
  },
  {
    name: "Fable no-ovh selector",
    source: String.raw`name: probe
on: push
jobs:
  build:
    {
      steps: [{run: echo ok}],
      "\u0072uns-on": [self-hosted, linux, x64],
      name: "x
        runs-on: ubuntu-latest
        y"
    }
`,
    expectedMessage: /runner-label set/,
  },
];

test("rejects both complete Astra runner-selector fixtures for policy reasons", () => {
  for (const fixture of completeAstraFixtures) {
    rejectsCompleteCandidate(fixture);
  }
});

test("rejects all valid Fable flow, scalar, and explicit-key variants for policy reasons", () => {
  for (const fixture of fableFixtures) rejectsCompleteCandidate(fixture);
});

test("AST decoding exposes escaped, explicit, and flow selector keys", () => {
  const fixtures = [
    {
      name: "escaped",
      source: String.raw`jobs:
  "\u0062uild":
    "\u0072uns-\u006fn": "\u006fvh"
`,
      expectedLabels: ["ovh"],
    },
    {
      name: "explicit",
      source: String.raw`jobs:
  build:
    ? "runs-on"
    : ubuntu-latest
`,
      expectedLabels: ["ubuntu-latest"],
    },
    {
      name: "flow",
      source: "jobs: {build: {runs-on: [self-hosted, ovh]}}\n",
      expectedLabels: ["self-hosted", "ovh"],
    },
  ];
  for (const fixture of fixtures) {
    const [labels] = parseRunnerLabelSets(
      fixture.source,
      `${fixture.name}.yml`,
    );
    assert.deepEqual([...labels], fixture.expectedLabels, fixture.name);
  }
});

test("accepts real flow, block, quoted, and sequence YAML keys", () => {
  const flow = candidateLabels(
    "jobs: {build: {runs-on: [SELF-HOSTED, OVH, linux, x64], steps: [{run: echo ok}]}}\n",
  );
  assert.deepEqual([...flow[0]], ["self-hosted", "ovh", "linux", "x64"]);

  const quotedKeys = candidateLabels(
    "jobs:\n  build:\n    'runs-on': 'ubuntu-latest'\n    steps: []\n",
  );
  assert.deepEqual([...quotedKeys[0]], ["ubuntu-latest"]);

  const blockSequence = candidateLabels(
    "jobs:\n  build:\n    runs-on:\n      - self-hosted\n      - ovh\n      - linux\n      - x64\n    steps: []\n",
  );
  assert.deepEqual([...blockSequence[0]], [
    "self-hosted",
    "ovh",
    "linux",
    "x64",
  ]);
});

test("normalizes labels and forbids trusted-verifier in candidate workflows", () => {
  assert.deepEqual(
    [
      ...candidateLabels(
        "jobs:\n  build:\n    runs-on: [SELF-HOSTED, OVH, Linux, X64]\n",
      )[0],
    ],
    ["self-hosted", "ovh", "linux", "x64"],
  );
  rejectsCandidate(
    "jobs:\n  build:\n    runs-on: TRUSTED-VERIFIER\n",
    /candidate workflow requests trusted-verifier/,
  );
  rejectsCandidate(
    "jobs:\n  build:\n    runs-on: trusted-verifier # dedicated runner\n",
    /candidate workflow requests trusted-verifier/,
  );
  assert.doesNotThrow(() =>
    candidateLabels(
      "jobs:\n  build:\n    runs-on: ubuntu-latest # this runs on ovh\n",
    )
  );
  rejectsCandidate(
    "jobs:\n  build:\n    runs-on: [self-hosted, OVH, TRUSTED-VERIFIER]\n",
    /candidate workflow requests trusted-verifier/,
  );
});

test("candidate Bakery CI has no trusted-verifier labels or reusable calls", () => {
  const source = readFileSync(
    join(WORKFLOW_DIR, "ci.yml"),
    "utf8",
  );
  assert.doesNotThrow(() =>
    assertCandidateWorkflowLabels(".github/workflows/ci.yml", source)
  );
  assert.equal(source.includes("trusted-verifier"), false);
});

test("rejects jobs without exactly one execution selector", () => {
  rejectsCandidate(
    "jobs:\n  acquire:\n    uses: example/workflow.yml\n    runs-on: ubuntu-latest\n",
    /must have exactly one execution selector \(runs-on or uses\)/,
  );
  rejectsCandidate(
    "jobs:\n  acquire:\n    steps: []\n",
    /must have exactly one execution selector \(runs-on or uses\)/,
  );
});

test("candidate trusted execution selectors remain forbidden", () => {
  for (
    const selector of [
      "[self-hosted, trusted-verifier]",
      "trusted-verifier",
    ]
  ) {
    rejectsCandidate(
      `jobs:\n  acquire:\n    runs-on: ${selector}\n`,
      /candidate workflow requests trusted-verifier/,
    );
  }
});

const workflowFileNames = (entries) =>
  entries.filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();

const assertWorkflowDirectory = (directory) => {
  for (const file of workflowFileNames(readdirSync(directory))) {
    const workflowPath = directory === WORKFLOW_DIR
      ? `.github/workflows/${file}`
      : join(directory, file);
    const source = readFileSync(join(directory, file), "utf8");
    assertCandidateWorkflowLabels(workflowPath, source);
  }
};

const permissionWriteScopes = (permissions) => {
  if (permissions === "write-all") return new Set(["*"]);
  if (
    permissions == null ||
    typeof permissions !== "object" ||
    Array.isArray(permissions)
  ) {
    return new Set();
  }
  return new Set(
    Object.entries(permissions)
      .filter(([, value]) => value === "write")
      .map(([scope]) => scope),
  );
};

const workflowWriteScopes = (source, workflowPath) => {
  const document = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    version: "1.2",
  });
  assert.equal(
    document.errors.length,
    0,
    `${workflowPath}: invalid YAML: ${
      document.errors.map((error) => error.message).join("; ")
    }`,
  );
  const root = document.toJS();
  const scopes = permissionWriteScopes(root?.permissions);
  const jobs = root?.jobs;
  if (jobs == null || typeof jobs !== "object" || Array.isArray(jobs)) {
    return scopes;
  }
  for (const job of Object.values(jobs)) {
    for (const scope of permissionWriteScopes(job?.permissions)) {
      scopes.add(scope);
    }
  }
  return scopes;
};
test("requires an approved self-hosted pool for custom runner labels", () => {
  for (
    const fixture of [
      {
        selector: "linux",
        expectedMessage: /runner-label set/,
      },
      {
        selector: "[linux, x64]",
        expectedMessage: /runner-label set/,
      },
      {
        selector: "[self-hosted, linux, x64]",
        expectedMessage: /runner-label set/,
      },
      {
        selector: "[custom-runner]",
        expectedMessage: /runner-label set/,
      },
      {
        selector: "[ubuntu-24.04-arm, linux]",
        expectedMessage: /runner-label set/,
      },
      {
        selector: "[self-hosted, ubuntu-24.04-arm]",
        expectedMessage: /runner-label set/,
      },
    ]
  ) {
    rejectsCandidate(
      `jobs:\n  build:\n    runs-on: ${fixture.selector}\n`,
      fixture.expectedMessage,
    );
  }
  for (
    const selector of [
      "ubuntu-24.04",
      "ubuntu-24.04-arm",
      "ubuntu-latest",
      "WINDOWS-2025",
      "[self-hosted, OVH, linux, x64]",
      "[self-hosted, hetzner, linux, x64]",
      "[self-hosted, hetzner, amd, linux, x64]",
    ]
  ) {
    assert.doesNotThrow(() =>
      candidateLabels(`jobs:\n  build:\n    runs-on: ${selector}\n`)
    );
  }
});

test("rejects unapproved GitHub-hosted-looking runner labels", () => {
  rejectsCandidate(
    String.raw`jobs:
  build:
    runs-on: ubuntu-candidate-persistent
`,
    /runner-label set/,
  );
});

test("requires explicit effective workflow and job permissions", () => {
  assert.throws(
    () =>
      assertWorkflowPolicy(
        "omitted-permissions.yml",
        workflow(
          String.raw`jobs:
  build:
    runs-on: [self-hosted, ovh]
`,
        ),
      ),
    /job build permissions must be explicitly declared/,
  );
  assert.doesNotThrow(() =>
    assertWorkflowPolicy(
      "inherited-permissions.yml",
      workflow(
        String.raw`permissions:
  contents: read
jobs:
  build:
    runs-on: [self-hosted, ovh]
`,
      ),
    )
  );
  assert.doesNotThrow(() =>
    assertWorkflowPolicy(
      "no-write-permissions.yml",
      workflow(
        String.raw`permissions: {}
jobs:
  build:
    runs-on: [self-hosted, ovh]
`,
      ),
    )
  );
});

test("workflow permissions remain explicit and read-only", () => {
  for (const file of workflowFileNames(readdirSync(WORKFLOW_DIR))) {
    const workflowPath = `.github/workflows/${file}`;
    const source = readFileSync(join(WORKFLOW_DIR, file), "utf8");
    assert.doesNotThrow(() => assertWorkflowPolicy(workflowPath, source));
    const writeScopes = [...workflowWriteScopes(source, workflowPath)].sort();
    assert.deepEqual(
      writeScopes,
      [],
      `${workflowPath} write scopes changed`,
    );
  }
});

test("rejects write permissions on candidate runners and approves read-only policy", () => {
  for (
    const source of [
      "permissions: write-all\njobs:\n  build:\n    runs-on: ubuntu-latest\n",
      "jobs:\n  build:\n    permissions: write-all\n    runs-on: ubuntu-latest\n",
    ]
  ) {
    assert.throws(
      () => assertWorkflowPolicy("forbidden.yml", workflow(source)),
      /workflows must not grant write-all/,
    );
  }
  assert.throws(
    () =>
      assertWorkflowPolicy(
        ".github/workflows/description-policy.yml",
        workflow(
          "jobs:\n  issue:\n    permissions:\n      issues: write\n    runs-on: [self-hosted, hetzner]\n",
        ),
      ),
    /must use a single GitHub-hosted image/,
  );
  assert.throws(
    () =>
      assertWorkflowPolicy(
        "unrelated.yml",
        workflow(
          "jobs:\n  build:\n    permissions:\n      statuses: write\n    runs-on: ubuntu-24.04\n",
        ),
      ),
    /source workflows must not publish statuses/,
  );
  assert.throws(
    () =>
      assertWorkflowPolicy(
        ".github/workflows/prune-actions-artifacts.yml",
        workflow(
          "permissions:\n  actions: write\njobs:\n  prune:\n    runs-on: [self-hosted, ovh]\n",
        ),
      ),
    /must use a single GitHub-hosted image/,
  );
  const approved = readFileSync(
    join(WORKFLOW_DIR, "description-policy.yml"),
    "utf8",
  );
  assert.doesNotThrow(() =>
    assertWorkflowPolicy(
      ".github/workflows/description-policy.yml",
      approved,
    )
  );
});
test("rejects trusted workflow selectors, references, and reusable calls", () => {
  assert.throws(
    () =>
      assertWorkflowPolicy(
        "forbidden.yml",
        workflow(
          "jobs:\n  trusted:\n    uses: owner/repo/.github/workflows/trusted-verifier.yml@abc123\n",
        ),
      ),
    /candidate workflows must not call a trusted reusable workflow/,
  );
  for (const reference of ["trusted-verifier", "Bakery / trusted verifier"]) {
    assert.throws(
      () =>
        assertWorkflowPolicy(
          "forbidden.yml",
          workflow(
            `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ${reference}
`,
          ),
        ),
      /workflow references the removed trusted verifier/,
    );
  }
});
test("rejects escaped trusted-verifier references in decoded workflow scalars", () => {
  const fixtures = [
    {
      name: "workflow name",
      full: true,
      source: String.raw`name: "\u0042akery / \u0074rusted \u0076erifier"
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps: []`,
    },
    {
      name: "job name",
      source: String.raw`jobs:
  build:
    name: "\u0042akery / \u0074rusted \u0076erifier"
    runs-on: ubuntu-latest
    steps: []`,
    },
    {
      name: "step input",
      source: String.raw`jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: example/action
        with:
          publisher: "\u0042akery / \u0074rusted \u0076erifier"`,
    },
    {
      name: "step environment",
      source: String.raw`jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
        env:
          PUBLISHER: "\u0042akery / \u0074rusted \u0076erifier"`,
    },
    {
      name: "step command",
      source: String.raw`jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: "echo \u0074rusted-\u0076erifier"`,
    },
  ];
  for (const fixture of fixtures) {
    const source = fixture.full ? fixture.source : workflow(fixture.source);
    assert.throws(
      () => assertWorkflowPolicy("escaped.yml", source),
      (error) => {
        assert(error instanceof Error);
        assert.match(
          error.message,
          /workflow references the removed trusted verifier/,
        );
        return true;
      },
      fixture.name,
    );
  }
});
test("active workflows never grant write permissions", () => {
  for (const file of workflowFileNames(readdirSync(WORKFLOW_DIR))) {
    const workflowPath = `.github/workflows/${file}`;
    const source = readFileSync(join(WORKFLOW_DIR, file), "utf8");
    assert.deepEqual(
      [...workflowWriteScopes(source, workflowPath)],
      [],
      `${workflowPath} grants write permissions`,
    );
  }
});

test("rejects escaped artifact transport references in decoded workflow scalars", () => {
  const fixtures = [
    {
      name: "escaped upload action",
      source: String.raw`permissions: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: "actions/\u0075pload-artifact@deadbeef"`,
    },
    {
      name: "escaped download command",
      source: String.raw`permissions: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: "echo actions/\u0064ownload-artifact@deadbeef"`,
    },
  ];
  for (const fixture of fixtures) {
    assert.throws(
      () =>
        assertWorkflowPolicy("escaped-artifact.yml", workflow(fixture.source)),
      (error) => {
        assert(error instanceof Error);
        assert.match(
          error.message,
          /workflow uses a forbidden Actions artifact transport/,
        );
        return true;
      },
      fixture.name,
    );
  }
});

test("rejects duplicate keys, aliases, merges, dynamics, and unsupported values", () => {
  for (
    const fixture of [
      {
        source: String.raw`jobs:
  build:
    runs-on: ubuntu-latest
    "runs-\u006fn": ubuntu-latest
`,
        expectedMessage: /invalid YAML: .*Map keys must be unique/,
      },
      {
        source: String.raw`jobs:
  build:
    runs-on: &runner ubuntu-latest
`,
        expectedMessage: /unsupported YAML anchor/,
      },
      {
        source: String.raw`jobs:
  build:
    runs-on: *runner
`,
        expectedMessage: /unsupported YAML alias/,
      },
      {
        source: String.raw`defaults: {runs-on: ubuntu-latest}
jobs:
  build:
    <<: {runs-on: ubuntu-latest}
`,
        expectedMessage: /unsupported YAML merge key/,
      },
      {
        source: 'jobs:\n  build:\n    runs-on: "${{ matrix.runner }}"\n',
        expectedMessage: /runs-on\[0\] is unsupported/,
      },
      {
        source:
          'jobs:\n  build:\n    runs-on: ["ubuntu-latest", "${{ matrix.runner }}"]\n',
        expectedMessage: /runs-on\[1\] is unsupported/,
      },
      {
        source: "jobs:\n  build:\n    runs-on: [ubuntu-latest, 42]\n",
        expectedMessage: /runs-on\[1\] must be a string/,
      },
      {
        source: "jobs:\n  build:\n    runs-on: {label: ubuntu-latest}\n",
        expectedMessage: /runs-on\[0\] must be a string/,
      },
      {
        source: "jobs:\n  build:\n    runs-on:\n",
        expectedMessage: /runs-on\[0\] must be a string/,
      },
      {
        source: "jobs:\n  build:\n    runs-on: []\n",
        expectedMessage: /runs-on must not be empty/,
      },
      {
        source:
          "jobs:\n  build:\n    runs-on:\n      - ubuntu-latest\n      - {label: ubuntu-latest}\n",
        expectedMessage: /runs-on\[1\] must be a string/,
      },
      {
        source: "jobs:\n  build:\n    steps: []\n",
        expectedMessage:
          /must have exactly one execution selector \(runs-on or uses\)/,
      },
      {
        source:
          "jobs:\n  build:\n    runs-on: ubuntu-latest\n    runs-on: ovh\n",
        expectedMessage: /invalid YAML: .*Map keys must be unique/,
      },
      {
        source:
          "jobs:\n  build:\n    runs-on: ubuntu-latest\njobs:\n  other:\n    runs-on: ubuntu-latest\n",
        expectedMessage: /invalid YAML: .*Map keys must be unique/,
      },
    ]
  ) {
    rejectsCandidate(fixture.source, fixture.expectedMessage);
  }
});

test("every committed workflow obeys the runner-label policy", () => {
  const workflowFiles = workflowFileNames(readdirSync(WORKFLOW_DIR));
  assert.ok(workflowFiles.length > 0);
  assert.doesNotThrow(() => assertWorkflowDirectory(WORKFLOW_DIR));
});

test("workflow inventory scans both .yml and .yaml files", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-label-policy-"));
  try {
    writeFileSync(
      join(directory, "allowed.yml"),
      "permissions: {}\njobs:\n  build:\n    runs-on: ubuntu-latest\n",
    );
    writeFileSync(
      join(directory, "forbidden.yaml"),
      "permissions: {}\njobs:\n  build:\n    runs-on: trusted-verifier\n",
    );
    assert.deepEqual(
      workflowFileNames(readdirSync(directory)),
      ["allowed.yml", "forbidden.yaml"],
    );
    assert.throws(
      () => assertWorkflowDirectory(directory),
      (error) => {
        assert(error instanceof Error);
        assert.match(
          error.message,
          /forbidden\.yaml: candidate workflow requests trusted-verifier/,
        );
        return true;
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runner policy exposes actual decoded job selectors", () => {
  const sets = parseRunnerLabelSets(
    String.raw`jobs:
  "\u0062uild":
    "\u0072uns-on": "\u006fvh"
`,
    "decoded.yml",
  );
  assert.deepEqual([...sets[0]], ["ovh"]);
});
