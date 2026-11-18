import { assert } from "@std/assert";

// #527: the check executor refuses any assignment that pins context inputs
// when it was built without a reader, and that refusal is correct - but it is
// indistinguishable from a working system until an assignment actually pins
// something. The unit tests inject the reader directly, so they stay green
// whether or not production wires one, which means they cannot be the proof
// that seeding works. This rail reads the one production construction site
// instead.
//
// It is textual on purpose: it asks whether the call names `readAttemptContext`
// at all. A stronger rail would run the worker, which this lane cannot do.

const MAIN = new URL("../../apps/worker/src/main.ts", import.meta.url);

Deno.test("the production check executor is built with an attempt-context reader", async () => {
  const source = await Deno.readTextFile(MAIN);
  assert(
    source.includes("createCheckExecutor("),
    "apps/worker/src/main.ts no longer builds a check executor; this rail needs rewriting rather than deleting if that moved",
  );
  assert(
    source.includes("readAttemptContext"),
    "the check executor is built without readAttemptContext, so every assignment that pins context inputs is refused with CHECK_CONTEXT_READER_MISSING; injected-reader unit tests cannot see this",
  );
  // A reader that returns a constant would satisfy the name check and still
  // never fetch anything, so the rail also requires the call to reach the
  // client's attempt-context route.
  assert(
    source.includes("attemptContext("),
    "the injected reader must call the client's attemptContext route; a reader that returns a literal serves nothing",
  );
});
