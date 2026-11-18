// Run only by the temp hygiene rail (it is not a *_test.ts file, so no lane
// collects it): makes a temp dir inside a Worker. A Worker has its own global,
// so the preload's wrappers are not in it; the lane runner's sweep is what
// catches the directory (#253).

Deno.test("a Worker makes a temp dir the preload cannot see", async () => {
  const worker = new Worker(
    new URL("./temp-in-worker.worker.ts", import.meta.url),
    { type: "module" },
  );
  await new Promise<void>((resolve, reject) => {
    worker.onmessage = () => resolve();
    worker.onerror = (event) => reject(new Error(event.message));
  });
  worker.terminate();
});
