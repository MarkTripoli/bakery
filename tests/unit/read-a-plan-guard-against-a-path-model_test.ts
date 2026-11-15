import { assert, assertEquals } from "@std/assert";
import type { RepositoryRuleStageRequirement } from "../../packages/contracts/src/repository-rules.ts";
import type { WorkflowNode } from "../../packages/contracts/src/workflow-compiler/mod.ts";
import { planRuleViolations } from "../../apps/server/src/modules/workflows/plan-rule-guard.ts";

// Reference model written by QA (qa3) while testing #476: an INDEPENDENT reference model of "a required check runs after the last revision on EVERY path".
// The model enumerates concrete execution traces (guards skip, branch arms, repeat 0..max passes, ALL parallel
// interleavings) and asks the plain question of each trace. The guard's dataflow answer is compared with it over
// random nested plans. Categories: FALSE ADMIT (guard admits, some path leaves the command uncovered: a rule bypass),
// FALSE REFUSE (guard refuses a plan every path of which is covered: AC2 says admit it), REASON (both refuse, the
// reason differs: `stage_missing` = no always-running check covers it, `stage_before_revision` = one does).

const req = (commandId: string): RepositoryRuleStageRequirement => ({
  ruleKey: "magic-numbers" as RepositoryRuleStageRequirement["ruleKey"],
  commandId,
});
const CMDS = ["x", "y"];
const REQS = CMDS.map(req);

let counter = 0;
const base = () => ({
  id: `step_${++counter}`,
  needs: [] as string[],
  requires: [] as string[],
  timeoutMs: 60_000,
  retry: { maxAttempts: 1, backoffMs: 0, on: [] as string[] },
});
const GUARD = {
  kind: "compare",
  op: "eq",
  left: { kind: "ref", root: "input", path: ["go"] },
  right: { kind: "literal", value: true },
};
const guardIf = (g: boolean) => (g ? { if: GUARD } : {});

type Leaf = "R" | "Cx" | "Cy" | "C*" | "Cxy" | "N";
type M =
  | { k: "leaf"; leaf: Leaf; g: boolean }
  | { k: "seq"; steps: M[]; g: boolean }
  | { k: "branch"; then: M[]; else: M[]; g: boolean }
  | { k: "repeat"; max: number; seed: M[] | null; body: M[]; g: boolean }
  | { k: "par"; lanes: M[][]; g: boolean };

// ---- build the real compiled nodes --------------------------------------------------------------------------
function leafNode(leaf: Leaf, g: boolean): WorkflowNode {
  const action = leaf === "R"
    ? "harness.implement"
    : leaf === "N"
    ? "workflow.noop"
    : "quality.check";
  const checks = leaf === "C*"
    ? { kind: "ref", root: "delivery", path: ["checkIds"] }
    : leaf === "Cx"
    ? { kind: "literal", value: ["x"] }
    : leaf === "Cy"
    ? { kind: "list", items: [{ kind: "literal", value: "y" }] }
    : leaf === "Cxy"
    ? { kind: "literal", value: ["x", "y"] }
    : undefined;
  return {
    kind: "action",
    ...base(),
    ...guardIf(g),
    action,
    with: { kind: "object", fields: checks === undefined ? {} : { checks } },
  } as unknown as WorkflowNode;
}
const build = (m: M): WorkflowNode => {
  switch (m.k) {
    case "leaf":
      return leafNode(m.leaf, m.g);
    case "seq":
      return {
        kind: "sequence",
        ...base(),
        ...guardIf(m.g),
        steps: m.steps.map(build),
      } as unknown as WorkflowNode;
    case "branch":
      return {
        kind: "branch",
        ...base(),
        ...guardIf(m.g),
        when: GUARD,
        then: m.then.map(build),
        else: m.else.map(build),
        outputs: {},
      } as unknown as WorkflowNode;
    case "repeat":
      return {
        kind: "repeat",
        ...base(),
        ...guardIf(m.g),
        max: m.max,
        seed: m.seed === null
          ? {
            form: "mapping",
            currentCandidate: { kind: "literal", value: null },
          }
          : {
            form: "sequence",
            steps: m.seed.map(build),
            currentCandidate: { kind: "literal", value: null },
          },
        until: GUARD,
        steps: m.body.map(build),
        currentCandidate: { kind: "literal", value: null },
      } as unknown as WorkflowNode;
    case "par":
      return {
        kind: "parallel",
        ...base(),
        ...guardIf(m.g),
        maxConcurrency: 2,
        join: "all-required",
        failurePolicy: "stop-dependent",
        lanes: m.lanes.map((steps, index) => ({
          id: `lane_${index}`,
          needs: [],
          repository: "main",
          steps: steps.map(build),
        })),
        outputs: {},
      } as unknown as WorkflowNode;
  }
};

// ---- the reference model: concrete traces ----------------------------------------------------------------------
type Trace = string[];
const LIMIT = 4000;
class TooBig extends Error {}
const dedup = (ts: Trace[]): Trace[] => {
  const seen = new Map<string, Trace>();
  for (const t of ts) seen.set(t.join(","), t);
  return [...seen.values()];
};
const cross = (a: Trace[], b: Trace[]): Trace[] => {
  if (a.length * b.length > LIMIT) throw new TooBig();
  const out: Trace[] = [];
  for (const x of a) for (const y of b) out.push([...x, ...y]);
  return dedup(out);
};
const seqT = (steps: M[]): Trace[] =>
  steps.reduce((acc, s) => cross(acc, tracesOf(s)), [[]] as Trace[]);
function interleavings(a: Trace, b: Trace): Trace[] {
  if (a.length === 0) return [b];
  if (b.length === 0) return [a];
  return [
    ...interleavings(a.slice(1), b).map((t) => [a[0], ...t]),
    ...interleavings(a, b.slice(1)).map((t) => [b[0], ...t]),
  ];
}
function tracesOf(m: M): Trace[] {
  let ts: Trace[];
  switch (m.k) {
    case "leaf":
      ts = [[m.leaf]];
      break;
    case "seq":
      ts = seqT(m.steps);
      break;
    case "branch":
      ts = dedup([...seqT(m.then), ...seqT(m.else)]);
      break;
    case "repeat": {
      const seed = m.seed === null ? [[]] : seqT(m.seed);
      const body = seqT(m.body);
      const all = [...seed];
      let cur = seed;
      for (let pass = 1; pass <= m.max; pass += 1) {
        cur = cross(cur, body);
        all.push(...cur);
      }
      ts = dedup(all);
      break;
    }
    case "par": {
      const lanes = m.lanes.map(seqT);
      let acc = lanes[0];
      for (const lane of lanes.slice(1)) {
        const next: Trace[] = [];
        for (const a of acc) {
          for (const b of lane) {
            if (a.length + b.length > 12) throw new TooBig();
            next.push(...interleavings(a, b));
            if (next.length > LIMIT) throw new TooBig();
          }
        }
        acc = dedup(next);
      }
      ts = acc;
      break;
    }
  }
  return m.g ? dedup([[], ...ts]) : ts;
}
const covers = (event: string, command: string) =>
  event === "C*" || event === "Cxy" || event === `C${command}`;
const coveredAfterLastRevision = (trace: Trace, command: string) =>
  trace.slice(trace.lastIndexOf("R") + 1).some((event) =>
    covers(event, command)
  );

type Verdict = Map<string, "ok" | "stage_missing" | "stage_before_revision">;
function oracle(top: M[]): Verdict {
  const traces = seqT(top);
  const verdict: Verdict = new Map();
  const bound = traces.some((t) => t.includes("R"));
  for (const command of CMDS) {
    if (!bound || traces.every((t) => coveredAfterLastRevision(t, command))) {
      verdict.set(command, "ok");
    } else {
      verdict.set(
        command,
        traces.every((t) => t.some((event) => covers(event, command)))
          ? "stage_before_revision"
          : "stage_missing",
      );
    }
  }
  return verdict;
}
function guardVerdict(top: M[]): Verdict {
  const violations = planRuleViolations(REQS, top.map(build));
  const verdict: Verdict = new Map();
  for (const command of CMDS) {
    verdict.set(
      command,
      violations.find((v) => v.commandId === command)?.reason === undefined
        ? "ok"
        : (violations.find((v) => v.commandId === command)!.reason as
          | "stage_missing"
          | "stage_before_revision"),
    );
  }
  return verdict;
}

// ---- show + size -------------------------------------------------------------------------------------------------
const show = (m: M): string => {
  const q = m.g ? "?" : "";
  switch (m.k) {
    case "leaf":
      return m.leaf + q;
    case "seq":
      return `(${m.steps.map(show).join("; ")})${q}`;
    case "branch":
      return `if{${m.then.map(show).join("; ")}}else{${
        m.else.map(show).join("; ")
      }}${q}`;
    case "repeat":
      return `rep${m.max}[${
        m.seed ? "seed:" + m.seed.map(show).join("; ") + " | " : ""
      }body:${m.body.map(show).join("; ")}]${q}`;
    case "par":
      return `par[${
        m.lanes.map((l) => l.map(show).join("; ")).join(" || ")
      }]${q}`;
  }
};
const size = (m: M): number => {
  switch (m.k) {
    case "leaf":
      return 1;
    case "seq":
      return 1 + m.steps.reduce((n, s) => n + size(s), 0);
    case "branch":
      return 1 + [...m.then, ...m.else].reduce((n, s) => n + size(s), 0);
    case "repeat":
      return 1 +
        [...(m.seed ?? []), ...m.body].reduce((n, s) => n + size(s), 0);
    case "par":
      return 1 + m.lanes.flat().reduce((n, s) => n + size(s), 0);
  }
};

const kindsOf = (m: M, out = new Set<string>()): Set<string> => {
  out.add(m.k);
  if (m.g) out.add("guard");
  switch (m.k) {
    case "seq":
      m.steps.forEach((s) => kindsOf(s, out));
      break;
    case "branch":
      [...m.then, ...m.else].forEach((s) => kindsOf(s, out));
      break;
    case "repeat":
      [...(m.seed ?? []), ...m.body].forEach((s) => kindsOf(s, out));
      break;
    case "par":
      m.lanes.flat().forEach((s) => kindsOf(s, out));
      break;
  }
  return out;
};

// ---- random plans --------------------------------------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const LEAVES: Leaf[] = [
  "R",
  "R",
  "R",
  "Cx",
  "Cx",
  "Cy",
  "Cy",
  "C*",
  "C*",
  "Cxy",
  "N",
];
const list = (r: () => number, depth: number, min: number, max: number): M[] =>
  Array.from(
    { length: min + Math.floor(r() * (max - min + 1)) },
    () => gen(r, depth),
  );
function gen(r: () => number, depth: number): M {
  const g = r() < 0.15;
  const roll = r();
  if (depth <= 0 || roll < 0.5) {
    return { k: "leaf", leaf: LEAVES[Math.floor(r() * LEAVES.length)], g };
  }
  if (roll < 0.62) return { k: "seq", steps: list(r, depth - 1, 1, 3), g };
  if (roll < 0.76) {
    return {
      k: "branch",
      then: list(r, depth - 1, 0, 2),
      else: list(r, depth - 1, 0, 2),
      g,
    };
  }
  if (roll < 0.88) {
    return {
      k: "repeat",
      max: 1 + Math.floor(r() * 3),
      seed: r() < 0.4 ? list(r, depth - 1, 1, 2) : null,
      body: list(r, depth - 1, 1, 2),
      g,
    };
  }
  return {
    k: "par",
    lanes: [list(r, depth - 1, 1, 2), list(r, depth - 1, 1, 2)],
    g,
  };
}

Deno.test("the plan guard agrees with a path-enumerating reference model over random nested plans: it never admits a plan with an uncovered path, and it names the reason as the model does", () => {
  const r = mulberry32(0x476);
  const SAMPLES = 20_000;
  let compared = 0;
  const found: Record<
    "falseAdmit" | "falseRefuse" | "reason",
    Array<{ plan: string; command: string; guard: string; model: string }>
  > = { falseAdmit: [], falseRefuse: [], reason: [] };
  for (let i = 0; i < SAMPLES; i += 1) {
    const top = list(r, 3, 1, 4);
    let model: Verdict;
    try {
      model = oracle(top);
    } catch (error) {
      if (error instanceof TooBig) continue;
      throw error;
    }
    const guard = guardVerdict(top);
    compared += 1;
    for (const command of CMDS) {
      const g = guard.get(command)!;
      const m = model.get(command)!;
      if (g === m) continue;
      const category = g === "ok"
        ? "falseAdmit"
        : m === "ok"
        ? "falseRefuse"
        : "reason";
      found[category].push({
        plan: top.map(show).join(" ; "),
        command,
        guard: g,
        model: m,
      });
    }
  }
  // The comparison is not vacuous.
  assert(compared > 10_000, `only ${compared} plans were small enough`);
  // A rule bypass: the guard admitted a plan with a path that leaves a required check uncovered.
  assertEquals(found.falseAdmit, []);
  // The guard and the model name the same reason (no always-running check covers, or one does but a revision can follow).
  assertEquals(found.reason, []);
  // The guard is conservative in one place only: a parallel group whose covering
  // check lives in another lane than a revising repeat that may run zero times.
  assertEquals(
    found.falseRefuse.filter((example) => !example.plan.includes("par[")),
    [],
  );
});
