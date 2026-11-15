import { assert, assertEquals } from "@std/assert";

// #397. The engine learns `$delivery` and a recorded stop through an injected
// `PlanHostReader`, so the kernel imports nothing from the delivery module and
// the server composes the two once, where it builds the engine. These rails
// read source text: a kernel file that starts importing delivery fails here,
// and so does a server root that stops handing the reader to an engine
// function (a plan that reads `$delivery` would then fail in production while
// every test that composes the reader by hand stayed green).

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walk(path);
    else if (entry.isFile) yield path;
  }
}

const KERNEL_DIRS = [
  "apps/server/src/modules/workflow-adapter",
  "packages/contracts/src/workflow-compiler",
  "packages/contracts/src/workflow-interpreter",
];

/** An import or re-export whose specifier names the delivery module. */
const DELIVERY_IMPORT = /(?:from\s*|import\s*\(\s*)["'][^"']*\/delivery\//;

Deno.test("no kernel file imports the delivery module", async () => {
  const offenders: string[] = [];
  for (const dir of KERNEL_DIRS) {
    for await (const path of walk(`${ROOT}/${dir}`)) {
      if (!path.endsWith(".ts") || path.endsWith("_test.ts")) continue;
      const text = await Deno.readTextFile(path);
      if (DELIVERY_IMPORT.test(text)) {
        offenders.push(path.slice(ROOT.length + 1));
      }
    }
  }
  assertEquals(offenders, []);
});

Deno.test("the server root hands the plan host to both engine functions", async () => {
  const text = await Deno.readTextFile(
    `${ROOT}/apps/server/src/modules/execution/inngest-http.ts`,
  );
  assert(
    /import \{ readPlanHost \} from "\.\.\/delivery\/plan-host\.ts";/.test(
      text,
    ),
    "the root must import the delivery plan host",
  );
  const composed = [...text.matchAll(/planHost:\s*readPlanHost/g)].length;
  assertEquals(composed, 2, "workflow and recovery both need the reader");
  for (
    const factory of [
      "createBakeryFixedWorkflow",
      "createBakeryWorkflowRecovery",
    ]
  ) {
    const call = text.slice(text.indexOf(`${factory}({`));
    const body = call.slice(0, call.indexOf("}),"));
    assert(
      /planHost:\s*readPlanHost/.test(body),
      `${factory} lacks the reader`,
    );
  }
});
