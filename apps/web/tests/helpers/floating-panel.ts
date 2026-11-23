import { expect, type Locator } from "@playwright/test";

/**
 * A panel that hangs from a control inside a clipping surface (the add menu on
 * the workflow canvas) must be seen whole: inside the surface that holds its
 * trigger and inside the window, on all four sides, and the thing a person
 * types in must be the thing a click at its centre reaches (a canvas edge or a
 * rail painted over the panel hides a field the box checks call fine).
 */
export async function expectPanelUsable(panel: Locator, boundary: Locator) {
  const edge = await boundary.boundingBox();
  const seen = await panel.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const field = element.querySelector("input");
    const at = field?.getBoundingClientRect();
    const hit = at === undefined ? null : document.elementFromPoint(
      at.left + at.width / 2,
      at.top + at.height / 2,
    );
    return {
      box: {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
      },
      window: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      fieldReachable: field !== null && hit !== null && field.contains(hit),
    };
  });
  expect(edge).not.toBeNull();
  const slack = 0.5;
  expect(seen.box.left, "panel starts inside the canvas")
    .toBeGreaterThanOrEqual(
      edge!.x - slack,
    );
  expect(seen.box.right, "panel ends inside the canvas").toBeLessThanOrEqual(
    edge!.x + edge!.width + slack,
  );
  expect(seen.box.top, "panel top is inside the canvas").toBeGreaterThanOrEqual(
    edge!.y - slack,
  );
  expect(seen.box.bottom, "panel bottom is inside the canvas")
    .toBeLessThanOrEqual(edge!.y + edge!.height + slack);
  expect(seen.box.bottom, "panel is inside the window").toBeLessThanOrEqual(
    seen.window.height + slack,
  );
  expect(
    seen.fieldReachable,
    "a click at the centre of the search field hits it",
  )
    .toBe(true);
}
