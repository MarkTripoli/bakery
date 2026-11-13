// Not a test of the security lane: a fixture the lane-home rail
// (tests/rails/lane-home-isolation_test.ts) runs through the real lane runner to
// see the runner report what a lane wrote into its isolated HOME. Two entries
// at the top of HOME, one of them a directory.
Deno.test("writes two entries into the isolated HOME", async () => {
  const home = Deno.env.get("HOME")!;
  await Deno.writeTextFile(`${home}/written-a`, "x");
  await Deno.mkdir(`${home}/.written-dir`);
  await Deno.writeTextFile(`${home}/.written-dir/b`, "x");
});
