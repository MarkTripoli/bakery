import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type ActionDispatch,
  cloneJson,
  nextStep,
  pinWorkflowRuntime,
  resolveWorkflowRuntime,
  WorkflowInterpreterError,
} from "../../packages/contracts/src/workflow-interpreter/mod.ts";
import {
  compiled,
  completed,
  noop,
  stateOf,
} from "../helpers/workflow-interpreter.ts";

// #211: the answer `nextStep` returns is a copy that shares nothing with the
// run state, so it must be able to copy whatever the run recorded and say so
// by name when it cannot. #213: a pin follows the document it was made from.

const code = (run: () => unknown) =>
  assertThrows(run, WorkflowInterpreterError).code;

/** A document whose one step reads a recorded output and a literal object. */
async function reading() {
  return await compiled([
    noop("xx"),
    noop("use", {
      needs: ["xx"],
      with: { whole: "$step.xx.payload", nested: { picked: "$step.xx.n" } },
    }),
  ]);
}

const stateWith = (output: unknown) =>
  stateOf({
    steps: new Map([["xx", completed(output as never)]]),
  });

// --- #211: what the copy accepts

Deno.test("the copy refuses a recorded value that is not plain JSON, by name", async () => {
  const document = await reading();
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  const deep = (levels: number) => {
    let value: unknown = 1;
    for (let i = 0; i < levels; i += 1) value = [value];
    return value;
  };
  const refused: [string, unknown][] = [
    ["a function", () => 1],
    ["undefined in a list", [1, undefined]],
    ["a bigint", 1n],
    ["a symbol", Symbol("s")],
    ["a Map", new Map([["a", 1]])],
    ["a Date", new Date(0)],
    [
      "a class instance",
      new (class Held {
        readonly a = 1;
      })(),
    ],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a cycle", circular],
    ["nesting deeper than the bound", deep(1_000)],
  ];
  for (const [name, bad] of refused) {
    // Nothing but a DataCloneError or a stack overflow would escape this
    // otherwise: the interpreter's own error is the contract.
    assertEquals(
      code(() => nextStep(document, stateWith({ payload: bad, n: 1 }))),
      "state_not_json",
      name,
    );
  }
});

Deno.test("the copy keeps ordinary JSON exactly, including an own __proto__ key", async () => {
  const document = await reading();
  // JSON.parse makes "__proto__" an own data property, as a stored jsonb
  // column read back does; assigning it would instead replace the prototype.
  const payload = JSON.parse(
    '{"__proto__":{"polluted":true},"list":[1,"two",null,{"deep":[]}],"n":3.5}',
  );
  const next = nextStep(document, stateWith({ payload, n: 7 }));
  assert(next.kind === "dispatch");
  const input = (next.step as ActionDispatch).input as {
    whole: Record<string, unknown>;
    nested: { picked: number };
  };
  assertEquals(Object.keys(input.whole), ["__proto__", "list", "n"]);
  assert(Object.hasOwn(input.whole, "__proto__"));
  assertEquals(
    Object.getOwnPropertyDescriptor(input.whole, "__proto__")!.value,
    { polluted: true },
  );
  assertEquals(Object.getPrototypeOf(input.whole), Object.prototype);
  assertEquals(({} as Record<string, unknown>)["polluted"], undefined);
  assertEquals(input.whole["list"], [1, "two", null, { deep: [] }]);
  assertEquals(input.whole["n"], 3.5);
  assertEquals(input.nested, { picked: 7 });
});

Deno.test("an own __proto__ key stays data where Object.prototype has the __proto__ accessor, as on Node", () => {
  // Deno deletes that accessor, so assigning a "__proto__" key quietly makes a
  // data property there; on Node the same assignment replaces the prototype.
  // Put the standard accessor back for this test so the copy is held to the
  // stricter behavior, which is the one the server will meet on Node 24.
  const shared = Object.prototype as unknown as Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "__proto__",
  );
  Object.defineProperty(Object.prototype, "__proto__", {
    configurable: true,
    get() {
      return Object.getPrototypeOf(this);
    },
    set(next: object | null) {
      Object.setPrototypeOf(this, next);
    },
  });
  try {
    const stored = JSON.parse('{"__proto__":{"polluted":true},"n":3}');
    const copy = cloneJson({ whole: stored }) as unknown as {
      whole: Record<string, unknown>;
    };
    assertEquals(Object.keys(copy.whole), ["__proto__", "n"]);
    assertEquals(Object.getPrototypeOf(copy.whole), Object.prototype);
    assertEquals(
      Object.getOwnPropertyDescriptor(copy.whole, "__proto__")!.value,
      { polluted: true },
    );
    assertEquals(shared["polluted"], undefined);
    // And a null-prototype object the interpreter built behaves the same way.
    const built = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(built, "__proto__", {
      value: { x: 1 },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const builtCopy = cloneJson(built) as unknown as Record<string, unknown>;
    assertEquals(Object.getPrototypeOf(builtCopy), null);
    assertEquals(Object.keys(builtCopy), ["__proto__"]);
  } finally {
    if (original) {
      Object.defineProperty(Object.prototype, "__proto__", original);
    } else delete shared["__proto__"];
  }
});

Deno.test("objects keep their prototype: an object the interpreter built stays null-prototype, a recorded one stays ordinary", async () => {
  const document = await reading();
  const next = nextStep(document, stateWith({ payload: { a: 1 }, n: 1 }));
  assert(next.kind === "dispatch");
  const input = (next.step as ActionDispatch).input as {
    whole: object;
    nested: object;
  };
  // `nested` is an object value node, which evaluateValue builds without a
  // prototype so a key named toString or constructor is only data.
  assertEquals(Object.getPrototypeOf(input.nested), null);
  assertEquals(Object.getPrototypeOf(input.whole), Object.prototype);
  assertEquals("toString" in input.nested, false);
});

Deno.test("cloneJson copies deeply, shares nothing and treats a missing property as absent", () => {
  type Shape = { a: [number, { b: number }]; c: string; gone?: undefined };
  const original: Shape = { a: [1, { b: 2 }], c: "d", gone: undefined };
  const copy = cloneJson(original) as unknown as Shape;
  assertEquals(copy, { a: [1, { b: 2 }], c: "d" });
  assert(!Object.hasOwn(copy, "gone"));
  assert(copy !== original);
  assert(copy.a !== original.a && copy.a[1] !== original.a[1]);
  // The same object referenced twice is copied twice, not shared.
  const shared = { x: 1 };
  const twice = cloneJson({ p: shared, q: shared }) as unknown as {
    p: object;
    q: object;
  };
  assert(twice.p !== twice.q);
  assertEquals(cloneJson(null), null);
  assertEquals(cloneJson(0), 0);
  assertEquals(cloneJson(""), "");
  assertEquals(code(() => cloneJson(undefined)), "state_not_json");
});

Deno.test("a refused value is not echoed in the error", async () => {
  const document = await reading();
  const error = assertThrows(
    () =>
      nextStep(
        document,
        stateWith({ payload: new Map([["secret-value", 1]]), n: 1 }),
      ),
    WorkflowInterpreterError,
  );
  assert(!error.message.includes("secret-value"));
});

// --- #213: a pin follows its document

Deno.test("a pin records the document's own compiler version, and resolves against it unchanged", async () => {
  const document = await reading();
  const pin = await pinWorkflowRuntime(document);
  assertEquals(pin.compilerVersion, String(document.compilerVersion));
  assert((await resolveWorkflowRuntime(pin, document)) !== undefined);

  // A document stamped by another compiler version: the schema accepts only
  // version 2 today, but published versions can still carry another stored pin.
  const stamped = { ...document, compilerVersion: 3 } as never;
  const otherPin = await pinWorkflowRuntime(stamped);
  assertEquals(otherPin.compilerVersion, "3");
  // It resolves against its own pin, and not against a pin for another version.
  assert((await resolveWorkflowRuntime(otherPin, stamped)) !== undefined);
  await assertRejects(
    () =>
      resolveWorkflowRuntime({ ...otherPin, compilerVersion: "2" }, stamped),
    WorkflowInterpreterError,
  );
});
