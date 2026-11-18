import { expect, test } from "@playwright/test";
import { baseURL } from "./storybook-harness.ts";

// The card's choosing behaviour: a click or Enter/Space on the card chooses it,
// a button inside keeps its own press, and a card with no onSelect is not a tab
// stop. Each assertion fails if the handlers are removed from SuggestionCard.
test.describe("SuggestionCard selection", () => {
  test("a click, Enter or Space chooses the card; its buttons keep their own press", async ({ page }) => {
    await page.goto(
      `${baseURL}/iframe.html?id=bakery-molecules-suggestioncard--contract&viewMode=story`,
    );
    const demo = page.getByTestId("selection-demo");
    await expect(demo).toBeVisible();
    const counts = demo.getByTestId("selection-counts");
    const one = demo.getByRole("article", { name: /Suggestion one/ });
    const two = demo.getByRole("article", { name: /Suggestion two/ });
    const fixed = demo.getByRole("article", { name: /Suggestion fixed/ });

    await expect(one).not.toHaveAttribute("aria-current");
    await expect(one).toHaveAttribute("tabindex", "0");
    await expect(fixed).not.toHaveAttribute("tabindex");

    await demo.getByText("What one does.").click();
    await expect(one).toHaveAttribute("aria-current", "true");
    await expect(two).not.toHaveAttribute("aria-current");
    await expect(counts).toHaveText("selects 1, accepts 0");

    await demo.getByRole("button", { name: "Accept two" }).click();
    await expect(counts).toHaveText("selects 1, accepts 1");
    await expect(two).not.toHaveAttribute("aria-current");

    await two.focus();
    await page.keyboard.press("Enter");
    await expect(two).toHaveAttribute("aria-current", "true");
    await expect(one).not.toHaveAttribute("aria-current");

    await one.focus();
    await page.keyboard.press("Space");
    await expect(one).toHaveAttribute("aria-current", "true");
    await expect(counts).toHaveText("selects 3, accepts 1");

    await demo.getByRole("button", { name: "Reject one" }).focus();
    await page.keyboard.press("Enter");
    await expect(counts).toHaveText("selects 3, accepts 1");
  });
});
