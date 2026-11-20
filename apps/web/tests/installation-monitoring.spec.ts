import { expect, test } from "@playwright/test";
import { registerPageHealth } from "./helpers/page-health.ts";
import { still } from "./helpers/stills.ts";
import { monitoringFixture } from "./helpers/monitoring-fixture.ts";

registerPageHealth(test);

const problem = (
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
) => ({
  type: `https://bakery.example/problems/${code.toLowerCase()}`,
  title: code,
  status,
  detail: code,
  code,
  requestId: "00000000-0000-4000-8000-0000000000e1",
  traceId: "00000000-0000-4000-8000-0000000000e2",
  retryable: false,
  ...extra,
});

/** The Monitoring page (#739): where Bakery sends its measurements. */
for (
  const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]
) {
  test.describe(`${viewport.name}: monitoring`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("each destination says its state and what it lost", async ({ page }) => {
      await monitoringFixture(page);
      await page.goto("/installation/monitoring");
      await expect(page.getByRole("heading", { name: "Monitoring", level: 1 }))
        .toBeVisible();
      await expect(page.getByText("Grafana Cloud", { exact: true }))
        .toBeVisible();
      await expect(page.getByText("Working", { exact: true })).toBeVisible();
      await expect(page.getByText("Failing", { exact: true })).toBeVisible();
      await expect(page.getByText("Off", { exact: true })).toBeVisible();
      // The failing banner quotes the server's reason and what was lost.
      await expect(page.getByText("Honeycomb is not accepting measurements."))
        .toBeVisible();
      await expect(page.getByText(/The destination answered 401\./).first())
        .toBeVisible();
      await expect(page.getByText(/14 records were dropped since/))
        .toBeVisible();
      await expect(page.getByText("Work in Bakery is not affected."))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "monitoring-list");
    });

    test("with nothing set up, the one kind is offered by name and opens its form", async ({ page }) => {
      await monitoringFixture(page, { empty: true });
      await page.goto("/installation/monitoring");
      await expect(page.getByText("Measurements stay in Bakery for now"))
        .toBeVisible();
      await page.getByRole("button", { name: "Add OpenTelemetry" }).click();
      const dialog = page.getByRole("dialog");
      // The form is built from what the server lists.
      await expect(dialog.getByText("Address", { exact: true })).toBeVisible();
      await expect(dialog.getByText("Sign-in header name")).toBeVisible();
      await expect(dialog.getByText("Sign-in header value")).toBeVisible();
      // A measurement the kind cannot take is disabled and says why.
      await expect(dialog.getByRole("checkbox", { name: "Cost and token use" }))
        .toBeDisabled();
      await expect(dialog.getByText("Bakery does not send this yet.").first())
        .toBeVisible();
      await expect(dialog.getByRole("checkbox", { name: "Workflow results" }))
        .toBeChecked();
      await expect(dialog.getByRole("button", { name: "Save and turn on" }))
        .toBeDisabled();
      await page.mouse.move(700, 700);
      await still(page, "monitoring-add");
    });

    test("adding sends the form's values and lists the new destination", async ({ page }) => {
      const seen = await monitoringFixture(page, { empty: true });
      await page.goto("/installation/monitoring");
      await page.getByRole("button", { name: "Add OpenTelemetry" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name", { exact: true }).fill("Grafana");
      await dialog.getByLabel("Address", { exact: true }).fill(
        "https://otel.example.com",
      );
      await dialog.getByRole("button", { name: "Save and turn on" }).click();
      await expect(page.getByText("Grafana", { exact: true })).toBeVisible();
      const create = seen.seen.find((s) =>
        s.method === "POST" && s.path.endsWith("telemetry-destinations")
      );
      expect(create?.body).toMatchObject({
        kind: "otlp",
        name: "Grafana",
        measurements: ["results", "health"],
        values: {
          address: "https://otel.example.com",
          headerName: "",
          headerValue: "",
        },
        enabled: true,
      });
      await expect(page.getByText("Nothing sent yet", { exact: true }))
        .toBeVisible();
    });

    test("a saved secret is never shown, and a new address asks for it again", async ({ page }) => {
      await monitoringFixture(page);
      await page.goto("/installation/monitoring");
      await page.getByRole("button", { name: "Manage" }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText(/^Saved /)).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Replace" }))
        .toBeVisible();
      await dialog.getByLabel("Address", { exact: true }).fill(
        "https://elsewhere.example.com",
      );
      await expect(
        dialog.getByText(
          "Enter the value again. A saved value is never sent to a different address.",
        ),
      ).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Save", exact: true }))
        .toBeDisabled();
      await page.mouse.move(700, 700);
      await still(page, "monitoring-manage");
    });

    test("a test shows the destination's own answer", async ({ page }) => {
      await monitoringFixture(page, {
        testResult: {
          ok: false,
          status: 401,
          reason: "The destination answered 401.",
          answer: "invalid token",
          tookMs: 120,
        },
      });
      await page.goto("/installation/monitoring");
      await page.getByRole("button", { name: "Manage" }).first().click();
      await page.getByRole("dialog").getByRole("button", {
        name: "Send a test",
      }).click();
      await expect(page.getByText("Test failed.")).toBeVisible();
      await expect(page.getByText("invalid token")).toBeVisible();
      await expect(page.getByText(/It took 120 ms\./)).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "monitoring-test-failed");
    });

    test("the server's field messages and refusals show where they belong", async ({ page }) => {
      await monitoringFixture(page, {
        empty: true,
        createProblem: {
          status: 422,
          body: problem(422, "UNPROCESSABLE", {
            issues: [{
              path: ["values", "address"],
              code: "invalid",
              message:
                "Give the base address only, without /v1/traces or /v1/metrics.",
            }],
          }),
        },
      });
      await page.goto("/installation/monitoring");
      await page.getByRole("button", { name: "Add OpenTelemetry" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name", { exact: true }).fill("Grafana");
      await dialog.getByLabel("Address", { exact: true }).fill(
        "https://otel.example.com/v1/traces",
      );
      await dialog.getByRole("button", { name: "Save and turn on" }).click();
      await expect(
        dialog.getByText(
          "Give the base address only, without /v1/traces or /v1/metrics.",
        ),
      ).toBeVisible();
    });

    test("turning a destination off and removing one send the version", async ({ page }) => {
      const seen = await monitoringFixture(page);
      await page.goto("/installation/monitoring");
      // The switch is controlled by the server's answer, so click it rather than wait for it to flip.
      await page.getByLabel("Grafana Cloud: sending on").click();
      await expect.poll(() => seen.seen.some((s) => s.method === "PATCH")).toBe(
        true,
      );
      const patch = seen.seen.find((s) => s.method === "PATCH")!;
      expect(patch.ifMatch).toBe('"v2"');
      expect(patch.body).toMatchObject({ enabled: false });
      expect(patch.body).not.toHaveProperty("values");
      await page.getByRole("button", { name: "Manage" }).nth(1).click();
      // The saved secret also has a Remove; the destination's own is named in full.
      await page.getByRole("dialog").getByRole("button", {
        name: "Remove destination",
      }).click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Remove",
      }).click();
      await expect.poll(() => seen.seen.some((s) => s.method === "DELETE"))
        .toBe(true);
      expect(seen.seen.find((s) => s.method === "DELETE")!.ifMatch).toBe(
        '"v2"',
      );
    });
  });
}
