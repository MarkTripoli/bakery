// The Worker half of temp-in-worker.fixture.ts.
Deno.makeTempDirSync({ prefix: "bakery-fixture-worker-" });
self.postMessage("made");
