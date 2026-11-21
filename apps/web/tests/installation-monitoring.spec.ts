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

const LIST = "/installation/monitoring";

/** The Monitoring list and a destination's own page (#739, UX revision 3). */
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
      await page.goto(LIST);
      await expect(page.getByRole("heading", { name: "Monitoring", level: 1 }))
        .toBeVisible();
      await expect(page.getByText("Grafana Cloud", { exact: true }))
        .toBeVisible();
      await expect(page.getByText("Working", { exact: true }).first())
        .toBeVisible();
      await expect(page.getByText("Failing", { exact: true }).first())
        .toBeVisible();
      await expect(page.getByText("Off", { exact: true }).first())
        .toBeVisible();
      await expect(page.getByText("4 destinations")).toBeVisible();
      // Each row leads with its provider's mark: a vendor's own file where
      // Bakery may show it, a letter tile where not, never a guess.
      await expect(
        page.locator('[data-provider="sentry"] .ui-provider-mark__art').first(),
      )
        .toBeVisible();
      await expect(
        page.locator('[data-provider="grafana"] .ui-provider-mark__tile')
          .first(),
      ).toHaveText("G");
      // The provider is named in plain text beside its mark: a column on a
      // wide screen, the start of the detail line on a phone.
      await expect(page.getByText(/^Sentry(?: ·|$)/).first()).toBeVisible();
      // The failing banner quotes the server's reason and what was lost.
      await expect(page.getByText("Honeycomb is not accepting measurements."))
        .toBeVisible();
      await expect(page.getByText(/14 records were dropped since/))
        .toBeVisible();
      await expect(page.getByText("Work in Bakery is not affected."))
        .toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "monitoring-list");
    });

    test("the search and the state filter narrow the list and live in the address", async ({ page }) => {
      await monitoringFixture(page);
      await page.goto(LIST);
      await page.getByRole("searchbox", { name: "Search destinations" }).fill(
        "honey",
      );
      await expect(page.getByText("1 destination", { exact: true }))
        .toBeVisible();
      await expect(page.getByText("Grafana Cloud", { exact: true }))
        .toHaveCount(0);
      await expect(page).toHaveURL(/q=honey/);
      await page.getByRole("searchbox", { name: "Search destinations" }).fill(
        "nothing like this",
      );
      await expect(page.getByText("No destinations match.")).toBeVisible();
      await page.getByRole("button", { name: "Clear filters" }).click();
      await expect(page.getByText("4 destinations")).toBeVisible();
      await page.goto(`${LIST}?provider=sentry`);
      await expect(page.getByText("1 destination", { exact: true }))
        .toBeVisible();
      await expect(page.getByText("Errors, production", { exact: true }))
        .toBeVisible();
      await page.goto(`${LIST}?state=off`);
      await expect(page.getByText("1 destination", { exact: true }))
        .toBeVisible();
      await expect(page.getByText("Old collector", { exact: true }))
        .toBeVisible();
    });

    test("with nothing set up, Add destination opens a chooser of providers", async ({ page }) => {
      await monitoringFixture(page, { empty: true });
      await page.goto(LIST);
      await expect(page.getByText("No destinations yet")).toBeVisible();
      await page.getByRole("button", { name: "Add destination" }).click();
      await expect(page).toHaveURL(/\/installation\/monitoring\/new$/);
      await expect(
        page.getByRole("heading", { name: "Add destination", level: 1 }),
      ).toBeVisible();
      for (
        const name of [
          "OpenTelemetry",
          "Grafana",
          "Datadog",
          "Honeycomb",
          "Sentry",
        ]
      ) {
        await expect(page.getByRole("link", { name: new RegExp(`^${name}`) }))
          .toBeVisible();
      }
      await expect(
        page.getByText(
          "Names and marks belong to their owners. Bakery is not affiliated with them or endorsed by them.",
        ),
      ).toBeVisible();
      // Vendors with a mark come first, then the lettered tiles.
      const order = await page.locator('[role="listitem"][data-provider]')
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-provider"))
        );
      expect(order).toEqual([
        "opentelemetry",
        "sentry",
        "grafana",
        "datadog",
        "honeycomb",
      ]);
      await page.mouse.move(700, 700);
      await still(page, "monitoring-chooser");
      await page.getByRole("link", { name: /^OpenTelemetry/ }).click();
      await expect(page).toHaveURL(/\/installation\/monitoring\/new/);
      await expect(
        page.getByRole("heading", {
          name: "Add OpenTelemetry destination",
          level: 1,
        }),
      ).toBeVisible();
      // The form is built from what the server lists.
      await expect(page.getByText("Address", { exact: true })).toBeVisible();
      await expect(page.getByText("Sign-in header name")).toBeVisible();
      await expect(page.getByText("Sign-in header value")).toBeVisible();
      // A measurement the kind cannot take is disabled and says why.
      await expect(page.getByRole("checkbox", { name: "Cost and token use" }))
        .toBeDisabled();
      await expect(page.getByText("Bakery does not send this yet.").first())
        .toBeVisible();
      await expect(page.getByRole("checkbox", { name: "Workflow results" }))
        .toBeChecked();
      await expect(page.getByRole("button", { name: "Save and turn on" }))
        .toBeDisabled();
      await page.mouse.move(700, 700);
      await still(page, "monitoring-add");
    });

    test("adding sends the form's values and lists the new destination", async ({ page }) => {
      const seen = await monitoringFixture(page, { empty: true });
      await page.goto(LIST);
      await page.getByRole("button", { name: "Add destination" }).click();
      await page.getByRole("link", { name: /^OpenTelemetry/ }).click();
      // Nothing to test until the required settings are in.
      await expect(page.getByRole("button", { name: "Send a test" }))
        .toBeDisabled();
      if (viewport.width < 1280) {
        // Narrow: fill the form, test it, then save, so Test sits between
        // "What to send" and the save row.
        const send = await page.getByRole("heading", { name: "What to send" })
          .boundingBox();
        const test = await page.getByRole("heading", {
          name: "Test",
          exact: true,
        }).boundingBox();
        const save = await page.getByRole("button", {
          name: "Save and turn on",
        }).boundingBox();
        expect(send !== null && test !== null && save !== null).toBe(true);
        expect(test!.y).toBeGreaterThan(send!.y);
        expect(test!.y).toBeLessThan(save!.y);
      }
      await expect(
        page.getByText("Fill in the connection fields to send a test."),
      ).toBeVisible();
      await page.getByLabel("Name", { exact: true }).fill("Grafana");
      await page.getByLabel("Address", { exact: true }).fill(
        "https://otel.example.com",
      );
      await expect(page.getByRole("button", { name: "Send a test" }))
        .toBeEnabled();
      await page.getByRole("button", { name: "Save and turn on" }).click();
      await expect(page).toHaveURL(/\/installation\/monitoring$/);
      await expect(page.getByText("Grafana", { exact: true })).toBeVisible();
      const create = seen.seen.find((s) =>
        s.method === "POST" && s.path.endsWith("telemetry-destinations")
      );
      expect(create?.body).toMatchObject({
        kind: "otlp",
        provider: "opentelemetry",
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

    test("a provider's own values are filled in, and one provider skips the chooser", async ({ page }) => {
      await monitoringFixture(page);
      await page.goto(LIST);
      await page.getByRole("button", { name: "Add destination" }).click();
      await page.getByRole("link", { name: /^Honeycomb/ }).click();
      await expect(page).toHaveURL(/new\?provider=honeycomb/);
      await expect(
        page.getByRole("heading", {
          name: "Add Honeycomb destination",
          level: 1,
        }),
      ).toBeVisible();
      await expect(page.getByLabel("Address", { exact: true })).toHaveValue(
        "https://api.honeycomb.io",
      );
      await expect(page.getByLabel("Sign-in header name")).toHaveValue(
        "x-honeycomb-team",
      );
      // Where the server offers one provider there is nothing to choose.
      await monitoringFixture(page, { providers: 1 });
      await page.goto(`${LIST}/new`);
      await expect(
        page.getByRole("heading", {
          name: "Add OpenTelemetry destination",
          level: 1,
        }),
      ).toBeVisible();
    });

    test("a long list shows a page and loads more", async ({ page }) => {
      await monitoringFixture(page, { extra: 30 });
      await page.goto(LIST);
      await expect(page.getByText("34 destinations")).toBeVisible();
      await expect(page.getByText("Showing 25 of 34")).toBeVisible();
      await page.getByRole("button", { name: "Load more" }).click();
      await expect(page.getByText("Collector 30", { exact: true }))
        .toBeVisible();
      await expect(page.getByRole("button", { name: "Load more" }))
        .toHaveCount(0);
    });

    test("Reload after a conflict shows what the other change left, not the old values", async ({ page }) => {
      await monitoringFixture(page, { conflictOnce: true });
      await page.goto(LIST);
      await page.getByRole("link", { name: "Grafana Cloud", exact: true })
        .click();
      await page.getByLabel("Name", { exact: true }).fill("My edit");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByRole("button", { name: "Reload" }).click();
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
        "Changed elsewhere",
      );
    });

    test("a count of lost records shows even when no first-lost time is known", async ({ page }) => {
      await monitoringFixture(page, { droppedWithoutTime: true });
      await page.goto(LIST);
      await page.getByRole("link", { name: "Grafana Cloud", exact: true })
        .click();
      await expect(page.getByText("3 records", { exact: true }))
        .toBeVisible();
    });

    test("a saved secret is never shown, and a new address asks for it again", async ({ page }) => {
      await monitoringFixture(page);
      await page.goto(LIST);
      await page.getByRole("link", { name: "Grafana Cloud", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Grafana Cloud", level: 1 }),
      ).toBeVisible();
      await expect(page.getByText(/^Saved /)).toBeVisible();
      await expect(page.getByRole("button", { name: "Replace" }))
        .toBeVisible();
      await page.getByLabel("Address", { exact: true }).fill(
        "https://elsewhere.example.com",
      );
      await expect(
        page.getByText(
          "Enter the value again. A saved value is never sent to a different address.",
        ),
      ).toBeVisible();
      // The test waits for the sign-in value, and the page says so.
      await expect(page.getByRole("button", { name: "Send a test" }))
        .toBeDisabled();
      await expect(
        page.getByText("Enter the sign-in header value to send a test."),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Save", exact: true }))
        .toBeDisabled();
      await expect(page.getByRole("button", { name: "Send a test" }))
        .toBeDisabled();
      await page.mouse.move(700, 700);
      await still(page, "monitoring-destination");
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
      await page.goto(LIST);
      await page.getByRole("link", { name: "Grafana Cloud", exact: true })
        .click();
      await page.getByRole("button", { name: "Send a test" }).click();
      await expect(page.getByText("Test failed.")).toBeVisible();
      await expect(page.getByText("invalid token")).toBeVisible();
      await expect(page.getByText(/It took 120 ms\./)).toBeVisible();
      await page.mouse.move(700, 700);
      await still(page, "monitoring-test-failed");
    });

    test("the server's field messages show where they belong", async ({ page }) => {
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
      await page.goto(LIST);
      await page.getByRole("button", { name: "Add destination" }).click();
      await page.getByRole("link", { name: /^OpenTelemetry/ }).click();
      await page.getByLabel("Name", { exact: true }).fill("Grafana");
      await page.getByLabel("Address", { exact: true }).fill(
        "https://otel.example.com/v1/traces",
      );
      await page.getByRole("button", { name: "Save and turn on" }).click();
      await expect(
        page.getByText(
          "Give the base address only, without /v1/traces or /v1/metrics.",
        ),
      ).toBeVisible();
    });

    test("the switch in the list sends the version", async ({ page }) => {
      const seen = await monitoringFixture(page);
      await page.goto(LIST);
      // The switch is controlled by the server's answer, so click it rather than wait for it to flip.
      await page.getByLabel("Send to Grafana Cloud").click();
      await expect.poll(() => seen.seen.some((s) => s.method === "PATCH")).toBe(
        true,
      );
      const patch = seen.seen.find((s) => s.method === "PATCH")!;
      expect(patch.ifMatch).toBe('"v2"');
      expect(patch.body).toMatchObject({ enabled: false });
      expect(patch.body).not.toHaveProperty("values");
    });

    test("removing a destination asks, sends the version and returns to the list", async ({ page }) => {
      const seen = await monitoringFixture(page);
      await page.goto(LIST);
      await page.getByRole("link", { name: "Old collector", exact: true })
        .click();
      await page.getByRole("button", { name: "Remove destination" }).click();
      await page.getByRole("alertdialog").getByRole("button", {
        name: "Remove",
      }).click();
      await expect.poll(() => seen.seen.some((s) => s.method === "DELETE"))
        .toBe(true);
      expect(seen.seen.find((s) => s.method === "DELETE")!.ifMatch).toBe(
        '"v2"',
      );
      await expect(page).toHaveURL(/\/installation\/monitoring$/);
    });

    test("the remove confirm is disabled while the delete runs", async ({ page }) => {
      const seen = await monitoringFixture(page, { holdDelete: true });
      await page.goto(LIST);
      await page.getByRole("link", { name: "Old collector", exact: true })
        .click();
      await page.getByRole("button", { name: "Remove destination" }).click();
      const confirm = page.getByRole("alertdialog").getByRole("button", {
        name: "Remove",
      });
      await confirm.click();
      await expect.poll(() => seen.seen.some((s) => s.method === "DELETE"))
        .toBe(true);
      // The answer is still held: a second press must not send a second delete.
      await expect(confirm).toBeDisabled();
      expect(seen.seen.filter((s) => s.method === "DELETE")).toHaveLength(1);
      seen.releaseDelete();
      await expect(page).toHaveURL(/\/installation\/monitoring$/);
    });

    test("leaving with unsaved changes asks first", async ({ page }) => {
      await monitoringFixture(page);
      await page.goto(LIST);
      await page.getByRole("link", { name: "Grafana Cloud", exact: true })
        .click();
      await page.getByLabel("Name", { exact: true }).fill("Grafana EU");
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByText("Leave without saving?").first())
        .toBeVisible();
      await page.getByRole("button", { name: "Keep editing" }).click();
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
        "Grafana EU",
      );
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "Leave" }).click();
      await expect(page).toHaveURL(/\/installation\/monitoring$/);
    });
  });
}
