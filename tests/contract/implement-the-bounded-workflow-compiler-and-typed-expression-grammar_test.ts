import { assert, assertEquals } from "@std/assert";
import {
  canonicalJson,
  compileWorkflowDocument,
  decodeWorkflowJson,
  expandStepKeys,
  isExactNumberText,
  sha256Hex,
  WORKFLOW_COMPILER_DIAGNOSTIC_CODES,
  WORKFLOW_COMPILER_MESSAGES,
  WorkflowCompilerDiagnosticSchema,
  WorkflowCompileResultSchema,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";
import {
  canonicalJson as serverCanonicalJson,
  sha256Hex as serverSha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { descriptionDefectKind } from "../../packages/contracts/src/description-quality.ts";
import { createDesignCatalog } from "../fixtures/workflow-compiler/design-catalog.ts";
import { specimenDefinition } from "../fixtures/workflow-compiler/specimen.ts";
import { z } from "zod";
import { isAlias, isScalar, parseAllDocuments, visit } from "yaml";

Deno.test("canonical JSON and digest helpers match the server byte for byte", async () => {
  const reordered = decodeWorkflowJson('{"b":{"y":1,"x":[2,1]},"a":true}');
  const sorted = decodeWorkflowJson('{"a":true,"b":{"x":[2,1],"y":1}}');
  assert(reordered.ok && sorted.ok);
  assertEquals(canonicalJson(reordered.value), canonicalJson(sorted.value));
  assertEquals(
    canonicalJson(reordered.value),
    serverCanonicalJson(reordered.value),
  );
  assertEquals(
    await sha256Hex(canonicalJson(reordered.value)),
    await serverSha256Hex(serverCanonicalJson(sorted.value)),
  );
});

Deno.test("diagnostic schema validates every code with its fixed message", () => {
  for (const code of WORKFLOW_COMPILER_DIAGNOSTIC_CODES) {
    const parsed = WorkflowCompilerDiagnosticSchema.safeParse({
      path: "/steps/0",
      code,
      message: WORKFLOW_COMPILER_MESSAGES[code],
    });
    assert(parsed.success, code);
  }
  assert(
    !WorkflowCompilerDiagnosticSchema.safeParse({
      path: "",
      code: "not_a_code",
      message: "x",
    }).success,
  );
  assert(
    !WorkflowCompilerDiagnosticSchema.safeParse({
      path: "",
      code: "field_invalid",
      message: "x",
      extra: 1,
    }).success,
  );
});

Deno.test("compile result schema separates success from failure", () => {
  const failure = WorkflowCompileResultSchema.safeParse({
    ok: false,
    diagnostics: [{
      path: "",
      code: "field_missing",
      message: WORKFLOW_COMPILER_MESSAGES.field_missing,
    }],
  });
  assert(failure.success);
  assert(
    !WorkflowCompileResultSchema.safeParse({ ok: false, diagnostics: [] })
      .success,
  );
});

Deno.test("every compiler schema carries a meaningful description", () => {
  const schemas = [
    WorkflowCompilerDiagnosticSchema,
    WorkflowCompileResultSchema,
  ];
  for (const schema of schemas) {
    const json = z.toJSONSchema(schema, {
      unrepresentable: "any",
      io: "input",
    }) as Record<string, unknown>;
    assertEquals(descriptionDefectKind(json.description, "root"), undefined);
  }
});

// ---------------------------------------------------------------------------
// Phase 4: digest equivalence and difference matrix.
// ---------------------------------------------------------------------------

type Def = Record<string, unknown>;

const REPO = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

/** Strict YAML 1.2 profile: no aliases, custom tags, merge keys or extra documents. */
function strictYaml(text: string): unknown {
  const documents = parseAllDocuments(text, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    merge: false,
    keepSourceTokens: true,
  });
  assertEquals(documents.length, 1, "multiple YAML documents");
  const [document] = documents;
  assert(document);
  assertEquals(document.errors.length, 0, "YAML errors");
  assertEquals(
    document.warnings.length,
    0,
    "YAML warnings such as unresolved tags",
  );
  visit(document, {
    Alias() {
      throw new Error("YAML alias rejected");
    },
    Node(_key, node) {
      const tag = (node as { tag?: string }).tag;
      if (tag && !tag.startsWith("tag:yaml.org,2002:")) {
        throw new Error("YAML custom tag rejected");
      }
    },
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === "<<") {
        throw new Error("YAML merge key rejected");
      }
    },
    Scalar(_key, node) {
      if (typeof node.value === "number") {
        const source = (node as unknown as { srcToken?: { source?: string } })
          .srcToken?.source;
        assert(
          isExactNumberText(source ?? String(node.value)),
          "YAML number is not exact",
        );
      }
    },
  });
  assert(!isAlias(document.contents));
  return document.toJS();
}

function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)]),
    );
  }
  return value;
}

function noop(id: string, extra: Def = {}): Def {
  return { id, uses: "workflow.noop", ...extra };
}

function base(): Def {
  return {
    apiVersion: "bakery.dev/v1",
    kind: "workflow",
    inputs: {
      repositoryId: { type: "uuid", required: true },
      target: { type: "string", required: true },
      retries: { type: "integer", required: true },
    },
    limits: {
      wallClock: "24h",
      maxCostUsd: 12,
      maxAttempts: 24,
      maxRepairCycles: 2,
    },
    cancel: "stop-started-actions",
    steps: [
      noop("research", { timeout: "30m" }),
      {
        id: "design",
        needs: ["research"],
        uses: "integration.action",
        with: {
          integrationId: "$input.repositoryId",
          arguments: { description: "a", name: "x" },
          note: { $literal: "$input.target" },
        },
        requires: ["shell", "git"],
        effectKey: ["design", "$input.repositoryId"],
      },
      {
        id: "choose",
        branch: {
          when: '$input.target == "prod" && $input.retries < 3',
          then: [noop("on_prod")],
          else: [noop("on_dev")],
          outputs: {
            picked: {
              then: "$step.choose.on_prod.value",
              else: "$step.choose.on_dev.value",
            },
          },
        },
      },
      {
        id: "fix",
        repeat: {
          max: 2,
          seed: {
            currentCandidate: { value: "$input.target", count: 1, done: false },
          },
          until: "$repeat.currentCandidate.done == true",
          steps: [noop("try_one")],
          outputs: { currentCandidate: "$step.fix.try_one.out" },
        },
      },
      { id: "pause", wait: { duration: "5m" } },
      {
        id: "fan",
        parallel: {
          maxConcurrency: 2,
          join: "all-required",
          failurePolicy: "stop-dependent",
          branches: [
            { id: "lane_a", repository: "main", steps: [noop("work_a")] },
            {
              id: "lane_b",
              needs: ["lane_a"],
              repository: "main",
              steps: [noop("work_b")],
            },
          ],
          outputs: { lane_a: { result: "$step.fan.lane_a.work_a.out" } },
        },
      },
      {
        id: "verify",
        uses: "quality.check",
        with: {
          repositoryId: "$input.repositoryId",
          revision: "$step.fix.currentCandidate.value",
        },
        checks: ["lint", "test"],
        retry: { maxAttempts: 2, backoff: "30s", on: ["DEPENDENCY_TIMEOUT"] },
        timeout: "45m",
      },
    ],
  };
}

const BASE_YAML = `
apiVersion: bakery.dev/v1
kind: workflow
inputs:
  repositoryId: {type: uuid, required: true}
  target: {type: string, required: true}
  retries: {type: integer, required: true}
limits:
  wallClock: 24h
  maxCostUsd: 12
  maxAttempts: 24
  maxRepairCycles: 2
cancel: stop-started-actions
steps:
  - id: research
    uses: workflow.noop
    timeout: 30m
  - id: design
    needs: [research]
    uses: integration.action
    with:
      integrationId: $input.repositoryId
      arguments: {description: a, name: x}
      note: {$literal: $input.target}
    requires: [shell, git]
    effectKey: [design, $input.repositoryId]
  - id: choose
    branch:
      when: $input.target == "prod" && $input.retries < 3
      then:
        - {id: on_prod, uses: workflow.noop}
      else:
        - {id: on_dev, uses: workflow.noop}
      outputs:
        picked:
          then: $step.choose.on_prod.value
          else: $step.choose.on_dev.value
  - id: fix
    repeat:
      max: 2
      seed:
        currentCandidate:
          value: $input.target
          count: 1
          done: false
      until: $repeat.currentCandidate.done == true
      steps:
        - {id: try_one, uses: workflow.noop}
      outputs:
        currentCandidate: $step.fix.try_one.out
  - id: pause
    wait: {duration: 5m}
  - id: fan
    parallel:
      maxConcurrency: 2
      join: all-required
      failurePolicy: stop-dependent
      branches:
        - id: lane_a
          repository: main
          steps:
            - {id: work_a, uses: workflow.noop}
        - id: lane_b
          needs: [lane_a]
          repository: main
          steps:
            - {id: work_b, uses: workflow.noop}
      outputs:
        lane_a:
          result: $step.fan.lane_a.work_a.out
  - id: verify
    uses: quality.check
    with: {repositoryId: $input.repositoryId, revision: $step.fix.currentCandidate.value}
    checks: [lint, test]
    retry: {maxAttempts: 2, backoff: 30s, on: [DEPENDENCY_TIMEOUT]}
    timeout: 45m
`;

const PINNED_BASE_DIGEST =
  "c7c1e23e9b65230a5383a7d6924ac0116e76be792fa07ab36a6bc8405f12f4fc";

async function digestOf(definition: unknown): Promise<string> {
  const result = await compileWorkflowDocument(
    typeof definition === "string"
      ? definition
      : JSON.parse(JSON.stringify(definition)),
  );
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  return result.digest;
}

type Mutator = (definition: Def) => void;

function steps(definition: Def): Def[] {
  return definition["steps"] as Def[];
}

function step(definition: Def, id: string): Def {
  const found = steps(definition).find((entry) => entry["id"] === id);
  assert(found, id);
  return found;
}

Deno.test("JSON, strict YAML 1.2, reordered and layout-only forms share one digest", async () => {
  const expected = await digestOf(base());
  assertEquals(expected, PINNED_BASE_DIGEST);

  assertEquals(await digestOf(JSON.stringify(base())), expected, "JSON text");
  assertEquals(
    await digestOf(JSON.stringify(base(), null, 4)),
    expected,
    "indented JSON text",
  );
  assertEquals(await digestOf(strictYaml(BASE_YAML)), expected, "YAML");
  assertEquals(await digestOf(reorder(base())), expected, "reordered keys");

  const layoutOnly: Mutator[] = [
    (d) => {
      d["name"] = "Anything";
      d["description"] = "Whatever";
      d["layout"] = { zoom: 2 };
      d["ui"] = { color: "red" };
    },
    (d) => {
      for (const node of steps(d)) {
        node["name"] = "n";
        node["label"] = "l";
        node["position"] = { x: 1, y: 2 };
        node["layout"] = { w: 3 };
        node["ui"] = {};
        node["description"] = "d";
      }
      const lanes = (step(d, "fan")["parallel"] as Def)["branches"] as Def[];
      for (const lane of lanes) {
        lane["label"] = "lane";
        lane["position"] = { x: 0 };
        lane["name"] = "n";
      }
    },
    (d) => {
      (step(d, "choose")["branch"] as Def)["when"] =
        '  ( $input.target   ==  "prod" )&&( $input.retries<3 ) ';
      (step(d, "fix")["repeat"] as Def)["until"] =
        "(($repeat.currentCandidate.done==true))";
    },
    (d) => {
      step(d, "verify")["timeout"] = "2700s";
      (step(d, "verify")["retry"] as Def)["backoff"] = "30000ms";
      step(d, "research")["timeout"] = "1800s";
      (d["limits"] as Def)["wallClock"] = "1d";
    },
    (d) => {
      // Omitting a timeout equal to the default.
      delete step(d, "research")["timeout"];
    },
    (d) => {
      step(d, "design")["requires"] = ["git", "shell"];
      step(d, "verify")["checks"] = ["test", "lint"];
      ((step(d, "verify")["retry"]) as Def)["on"] = ["DEPENDENCY_TIMEOUT"];
    },
    (d) => {
      // `$literal` of an equal plain object, and the reverse.
      const withBlock = step(d, "design")["with"] as Def;
      withBlock["arguments"] = { $literal: { name: "x", description: "a" } };
      withBlock["note"] = "plain text that is no reference";
      withBlock["note"] = { $literal: "$input.target" };
    },
  ];
  for (const [index, mutate] of layoutOnly.entries()) {
    const definition = base();
    mutate(definition);
    assertEquals(await digestOf(definition), expected, `layout-only ${index}`);
  }

  // Numerically equal tokens in JSON text.
  const withNumbers = JSON.stringify(base())
    .replace('"maxCostUsd":12', '"maxCostUsd":12.0')
    .replace('"max":2', '"max":2e0');
  assertEquals(await digestOf(withNumbers), expected, "number spellings");
});

Deno.test("execution-affecting edits change the digest, pairwise distinct", async () => {
  const expected = await digestOf(base());
  const variants: [string, Mutator][] = [
    ["swap two sequence steps", (d) => {
      const list = steps(d);
      [list[3], list[4]] = [list[4]!, list[3]!];
    }],
    ["move a node into a branch arm", (d) => {
      const moved = steps(d).splice(4, 1)[0]!;
      ((step(d, "choose")["branch"] as Def)["then"] as Def[]).push(moved);
    }],
    ["move a node into the repeat body", (d) => {
      const moved = steps(d).splice(4, 1)[0]!;
      ((step(d, "fix")["repeat"] as Def)["steps"] as Def[]).push(moved);
    }],
    ["sequence seed instead of mapping seed", (d) => {
      (step(d, "fix")["repeat"] as Def)["seed"] = {
        steps: [noop("seed_one")],
        outputs: {
          currentCandidate: { value: "$input.target", count: 1, done: false },
        },
      };
    }],
    ["change an operator literal", (d) => {
      (step(d, "choose")["branch"] as Def)["when"] =
        '$input.target == "prod" && $input.retries < 4';
    }],
    ["swap && for ||", (d) => {
      (step(d, "choose")["branch"] as Def)["when"] =
        '$input.target == "prod" || $input.retries < 3';
    }],
    ["change a comparison operator", (d) => {
      (step(d, "fix")["repeat"] as Def)["until"] =
        "$repeat.currentCandidate.done != true";
    }],
    ["change a timeout", (d) => {
      step(d, "verify")["timeout"] = "46m";
    }],
    ["change repeat.max", (d) => {
      (step(d, "fix")["repeat"] as Def)["max"] = 1;
    }],
    ["change a literal in a value position", (d) => {
      ((step(d, "fix")["repeat"] as Def)["seed"] as Def)["currentCandidate"] = {
        value: "$input.target",
        count: 2,
        done: false,
      };
    }],
    ["$literal escape instead of reference", (d) => {
      (step(d, "design")["with"] as Def)["note"] = "$input.target";
    }],
    ["arguments description edited", (d) => {
      ((step(d, "design")["with"] as Def)["arguments"] as Def)["description"] =
        "b";
    }],
    ["arguments name edited", (d) => {
      ((step(d, "design")["with"] as Def)["arguments"] as Def)["name"] = "y";
    }],
    ["arguments name removed", (d) => {
      delete ((step(d, "design")["with"] as Def)["arguments"] as Def)["name"];
    }],
    ["$literal containing layout", (d) => {
      (step(d, "design")["with"] as Def)["note"] = {
        $literal: { layout: 1 },
      };
    }],
    ["$literal containing different layout", (d) => {
      (step(d, "design")["with"] as Def)["note"] = {
        $literal: { layout: 2 },
      };
    }],
    ["$literal containing no layout", (d) => {
      (step(d, "design")["with"] as Def)["note"] = { $literal: {} };
    }],
    ["add an agent binding", (d) => {
      d["agents"] = { "rpi.research": AGENT };
    }],
    ["change an agent binding", (d) => {
      d["agents"] = { "rpi.research": REPO };
    }],
    ["add a needs edge", (d) => {
      step(d, "verify")["needs"] = ["fan"];
    }],
    ["change a check", (d) => {
      step(d, "verify")["checks"] = ["lint", "build"];
    }],
    ["change retry attempts", (d) => {
      (step(d, "verify")["retry"] as Def)["maxAttempts"] = 1;
    }],
    ["change a wait duration", (d) => {
      (step(d, "pause")["wait"] as Def)["duration"] = "6m";
    }],
    ["change a workflow limit", (d) => {
      (d["limits"] as Def)["maxCostUsd"] = 13;
    }],
    ["add an if condition", (d) => {
      step(d, "research")["if"] = "$input.retries > 0";
    }],
    ["change the effect key", (d) => {
      step(d, "design")["effectKey"] = ["design", "$input.retries"];
    }],
    ["change a lane repository", (d) => {
      const lanes = (step(d, "fan")["parallel"] as Def)["branches"] as Def[];
      lanes[0]!["repository"] = "other";
    }],
    ["rename a step id", (d) => {
      step(d, "research")["id"] = "discover";
      step(d, "design")["needs"] = ["discover"];
    }],
    ["change an input type", (d) => {
      (d["inputs"] as Def)["retries"] = { type: "number", required: true };
    }],
  ];
  const seen = new Map<string, string>([[expected, "base"]]);
  for (const [name, mutate] of variants) {
    const definition = base();
    mutate(definition);
    const digest = await digestOf(definition);
    const clash = seen.get(digest);
    assert(!clash, `${name} shares a digest with ${clash}`);
    seen.set(digest, name);
  }
  assertEquals(seen.size, variants.length + 1);
});

Deno.test("digest equals sha256 of the canonical document under the server helper", async () => {
  const result = await compileWorkflowDocument(
    JSON.parse(JSON.stringify(base())),
  );
  assert(result.ok);
  assertEquals(
    result.digest,
    await serverSha256Hex(serverCanonicalJson(result.document)),
  );
  assertEquals(result.digest, await sha256Hex(canonicalJson(result.document)));
});

Deno.test("the strict YAML helper rejects aliases, tags, merge keys and extra documents", () => {
  for (
    const text of [
      "a: &x 1\nb: *x\n",
      "a: !custom 1\n",
      "base: &b {x: 1}\nuse: {<<: *b}\n",
      "a: 1\n---\nb: 2\n",
      "a: 1\na: 2\n",
      "n: 1.00000000000000001\n",
    ]
  ) {
    let failed = false;
    try {
      strictYaml(text);
    } catch {
      failed = true;
    }
    assert(failed, text);
  }
});

Deno.test("catalog resolution leaves the semantic digest unchanged", async () => {
  const definition = JSON.parse(JSON.stringify(await specimenDefinition()));
  const bare = await compileWorkflowDocument(definition);
  const resolved = await compileWorkflowDocument(definition, {
    catalog: createDesignCatalog(),
  });
  assert(bare.ok, bare.ok ? "" : JSON.stringify(bare.diagnostics));
  assert(resolved.ok, resolved.ok ? "" : JSON.stringify(resolved.diagnostics));
  assertEquals(resolved.digest, bare.digest);
  assertEquals(resolved.document, bare.document);
});

type SpecimenStep = Record<string, unknown> & { id: string };

async function specimenCopy(): Promise<
  { definition: Record<string, unknown>; steps: SpecimenStep[] }
> {
  const definition = JSON.parse(
    JSON.stringify(await specimenDefinition()),
  ) as Record<string, unknown>;
  return { definition, steps: definition["steps"] as SpecimenStep[] };
}

Deno.test("the doc 06 specimen compiles against the design catalog", async () => {
  const { definition } = await specimenCopy();
  const result = await compileWorkflowDocument(definition, {
    catalog: createDesignCatalog(),
  });
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  assertEquals(result.diagnostics, []);
  assertEquals(
    result.digest,
    "4970b2af726d1b7f2db8a49d39d83e976f5afee9270b33981358ad37ed5ad4e4",
  );
});

Deno.test("flow and type checks reject broken specimens", async () => {
  const catalog = createDesignCatalog();
  const reject = async (definition: Record<string, unknown>) => {
    const result = await compileWorkflowDocument(definition, { catalog });
    assert(!result.ok, "expected the mutated specimen to be rejected");
    return result.diagnostics.map(({ path, code }) => ({ path, code }));
  };
  const indexOf = (steps: SpecimenStep[], id: string): number =>
    steps.findIndex((step) => step.id === id);

  // Reading a step that has not run yet.
  {
    const { definition, steps } = await specimenCopy();
    const [merge] = steps.splice(indexOf(steps, "merge"), 1);
    steps.splice(indexOf(steps, "repair"), 0, merge!);
    const found = await reject(definition);
    assert(
      found.some((entry) => entry.code === "reference_future"),
      JSON.stringify(found),
    );
  }
  // A conditional step read by a step that does not need it.
  {
    const { definition, steps } = await specimenCopy();
    delete steps[indexOf(steps, "prepare")]!["needs"];
    const found = await reject(definition);
    assert(
      found.some((entry) => entry.code === "reference_skipped_step"),
      JSON.stringify(found),
    );
  }
  // A candidate whose seed type no longer matches what the body produces.
  {
    const { definition, steps } = await specimenCopy();
    const repair = steps[indexOf(steps, "repair")]!;
    const seed = (repair["repeat"] as Record<string, unknown>)["seed"] as {
      currentCandidate: Record<string, unknown>;
    };
    seed.currentCandidate["checksPassed"] = "$step.test.headSha";
    const found = await reject(definition);
    assert(
      found.some((entry) =>
        entry.code === "type_mismatch" &&
        entry.path === "/steps/6/repeat/outputs/currentCandidate"
      ),
      JSON.stringify(found),
    );
  }
  // An effect key part without a declared minimum length.
  {
    const { definition, steps } = await specimenCopy();
    steps[indexOf(steps, "merge")]!["effectKey"] = [
      "merge",
      "$step.repair.currentCandidate.findings",
    ];
    const found = await reject(definition);
    assertEquals(
      found.filter((entry) => entry.code === "effect_key_invalid"),
      [{ path: "/steps/7/effectKey", code: "effect_key_invalid" }],
    );
  }
});

Deno.test("the specimen worst case is pinned and its plan is schema-valid", async () => {
  const { definition } = await specimenCopy();
  const result = await compileWorkflowDocument(definition, {
    catalog: createDesignCatalog(),
  });
  assert(result.ok, result.ok ? "" : JSON.stringify(result.diagnostics));
  assertEquals(result.plan.worstCase, {
    steps: 18,
    attempts: 21,
    timeMs: 49_350_000,
    costUsd: 0,
  });
  assertEquals(result.plan.steps.length, 14);
  const parsed = WorkflowCompileResultSchema.safeParse(result, {
    jitless: true,
  });
  assert(parsed.success, parsed.success ? "" : "plan violates its schema");
  const keys = expandStepKeys(result.plan);
  assertEquals(keys.length, 18);
  assertEquals(new Set(keys).size, 18);
  for (const iteration of [1, 2]) {
    assert(keys.includes(`repair@${iteration}.repair_test`));
  }
  assert(!keys.includes("repair@0.repair_test"));
});
