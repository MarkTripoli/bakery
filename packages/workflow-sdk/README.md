# @bakery/workflow-sdk

Builds a Bakery workflow as **data**. The builder emits the same JSON document
the REST API, the YAML importer and the compiler read; it runs no workflow and
holds no callback. A TypeScript loop or helper may assemble a document on the
author's machine, but what it returns is plain JSON (`toJSON()`), so the result
serializes, validates and publishes exactly like a document written by hand or
imported from YAML.

```ts
const taskBrief = defineAction<
  { brief: unknown; repositoryId: string },
  { artifact: { versionId: string } }
>("task.brief");
const implement = defineAction<
  { repositoryId: string; planArtifact: string; instructions: string },
  { candidate: { headSha: string } }
>("harness.implement");

const w = defineWorkflow({
  name: "fixed-coding",
  description: "Freeze the task brief, then implement it.",
  inputs: {
    repositoryId: uuidInput(),
    brief: { type: "TaskBrief", required: true },
    instructions: stringInput(),
  },
});

const brief = w.action("brief", taskBrief, {
  brief: w.input("brief"),
  repositoryId: w.input("repositoryId"),
});
w.action("implement", implement, {
  repositoryId: w.input("repositoryId"),
  planArtifact: brief.output("artifact.versionId"),
  instructions: w.input("instructions"),
});

w.toJSON(); // the document: validate it, publish it, or export it as YAML
```

## A bounded loop over a list

`forEach` runs its steps once per item, one item at a time, in list order
(interpreter revision 3). The body callback runs once, while the document is
built; what it declares becomes the loop's steps. `item` reads the current item
as `$each.<as>`, typed by the list it walks.

```ts
const cases = w.forEach(
  "cases",
  prepare.output("cases"),
  { max: 12, as: "case" }, // a longer list halts the run; null runs nothing
  (steps, item) => {
    steps.action("run_case", runCase, { prompt: item.field("prompt") });
  },
);
w.action("report", "workflow.noop", { ran: cases.iterations() });
```

A failed iteration stops the loop; `cases.outcome()` says how it ended.

Two options arrive with interpreter revision 5. `maxConcurrency` lets that many
iterations run at once (the worst case in time shrinks; steps, attempts and cost
still count every iteration). Iterations that run together may not write a
shared area, so the compiler refuses a body with a git or shell step, or an
agent step whose `files` section writes beyond `outputs`. A body that returns
`{ collect }` has that value read from each completed iteration, after its last
step, and gathered in item order as `cases.results()`:

```ts
const cases = w.forEach(
  "cases",
  prepare.output("cases"),
  { max: 6, as: "case", maxConcurrency: 3 },
  (steps, item) => {
    const check = steps.action("check", checkCase, { id: item.field("id") });
    return { collect: { id: item.field("id"), ok: check.output("ok") } };
  },
);
w.action("report", "workflow.noop", { all: cases.results() });
```

## What is checked, and where

- **At compile time** (for an action declared with `defineAction`): a binding
  must be a value of the input's type or a reference to one, so wiring a string
  output into an artifact input is a type error; `w.input("x")` only accepts a
  declared input; `step.output("a.b")` only accepts a path the action's output
  type has.
- **At build time**: step ids are unique, `needs` handles belong to this
  workflow, and every `$step.<id>` reference names a step declared earlier.
  Dependencies are derived from the references, so ordering cannot disagree with
  the data.
- **At validate time**: everything else, by the server's compiler. The builder
  does not duplicate it, and an action known only at runtime is typed `unknown`:
  no compile-time guarantee is claimed for one.
