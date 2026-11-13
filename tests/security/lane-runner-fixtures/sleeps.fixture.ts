// Not a test of the security lane: a fixture the lane-home rail
// (tests/rails/lane-home-isolation_test.ts) runs through the real lane runner so
// it can terminate the runner mid-run. The `.fixture.ts` name keeps the lane
// from picking it up; the rail names it explicitly.
Deno.test("sleeps until the runner is terminated", async () => {
  await Deno.writeTextFile(
    Deno.env.get("BAKERY_LANE_RUNNER_MARKER")!,
    "running",
  );
  await new Promise((resolve) => setTimeout(resolve, 120_000));
});
