import assert from "node:assert/strict";
import test from "node:test";
import { browserCore } from "../../scripts/ci/browser-core.mjs";

async function configuration(mode) {
  const priorMode = process.env.BAKERY_BROWSER_MODE;
  const priorSpecs = process.env.BAKERY_BROWSER_SPECS;
  process.env.BAKERY_BROWSER_MODE = mode;
  process.env.BAKERY_BROWSER_SPECS = JSON.stringify(["tasks.spec.ts"]);
  try {
    return (await import(
      `../../apps/web/playwright.config.ts?ordering=${mode}`
    )).default;
  } finally {
    if (priorMode === undefined) delete process.env.BAKERY_BROWSER_MODE;
    else process.env.BAKERY_BROWSER_MODE = priorMode;
    if (priorSpecs === undefined) delete process.env.BAKERY_BROWSER_SPECS;
    else process.env.BAKERY_BROWSER_SPECS = priorSpecs;
  }
}

for (const mode of ["core", "full"]) {
  test(`${mode} has an exclusive auth bootstrap dependency before other seeders`, async () => {
    const config = await configuration(mode);
    const auth = config.projects.find((project) =>
      project.testMatch?.length === 1 &&
      project.testMatch[0] === "**/auth-journey.spec.ts"
    );
    assert.ok(
      auth,
      "auth must own exclusive project; filename matching cannot impose order",
    );
    assert.equal(auth.workers, 1);
    assert.equal(auth.fullyParallel, false);
    for (
      const spec of [
        "account-security-journey.spec.ts",
        "settings-journey.spec.ts",
        "repository-profile-real-api.spec.ts",
        "organization-access-real-api.spec.ts",
        "browser-artifact-core.spec.ts",
      ]
    ) {
      const seeders = config.projects.filter((project) =>
        project.testMatch?.includes(`**/${spec}`)
      );
      assert.equal(seeders.length, 1, `${spec} must have one serial owner`);
      assert.ok(
        seeders[0].dependencies?.includes(auth.name),
        `${spec} can seed only after auth succeeds`,
      );
      assert.equal(seeders[0].workers, 1);
      assert.equal(seeders[0].fullyParallel, false);
    }
    for (
      const [project, file] of browserCore.filter(([, file]) =>
        file === "auth-journey.spec.ts"
      )
    ) {
      assert.equal(file, "auth-journey.spec.ts");
      assert.equal(project, auth.name);
    }
    for (
      const project of config.projects.filter((project) =>
        ["desktop", "mobile"].includes(project.name)
      )
    ) {
      assert.ok(project.testIgnore.includes("**/auth-journey.spec.ts"));
      assert.ok(
        project.testIgnore.includes("**/account-security-journey.spec.ts"),
      );
    }
  });
}

test("affected pass cannot repeat first-install auth on already seeded core database", async () => {
  const config = await configuration("affected");
  assert.ok(
    config.projects.every((project) =>
      !project.testMatch?.includes("**/auth-journey.spec.ts")
    ),
  );
});
