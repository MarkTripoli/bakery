import { expect, type Locator } from "@playwright/test";

/**
 * A Reference card must be seen whole and be usable: inside the window and
 * inside every ancestor that clips it, sideways and up and down, and its Copy
 * button must be the thing a click at its centre reaches (a composer or a rail
 * painted over the card hides a card the box checks call fine).
 */
export async function expectReferenceCardUsable(card: Locator) {
  const seen = await card.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const root = document.documentElement;
    let left = 0;
    let right = root.clientWidth;
    let top = 0;
    let bottom = root.clientHeight;
    // The phone sheet is fixed to the window, so no ancestor's overflow clips it.
    const fixed = getComputedStyle(element).position === "fixed";
    for (
      let node = fixed ? null : element.parentElement;
      node;
      node = node.parentElement
    ) {
      const style = getComputedStyle(node);
      const clip = node.getBoundingClientRect();
      if (style.overflowX !== "visible") {
        left = Math.max(left, clip.left);
        right = Math.min(right, clip.right);
      }
      if (style.overflowY !== "visible") {
        top = Math.max(top, clip.top);
        bottom = Math.min(bottom, clip.bottom);
      }
    }
    const copy = element.querySelector("button");
    const at = copy?.getBoundingClientRect();
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
      clip: { left, right, top, bottom },
      copyReachable: copy !== null && hit !== null && copy.contains(hit),
    };
  });
  const slack = 0.5;
  expect(seen.box.left, "card starts inside what clips it")
    .toBeGreaterThanOrEqual(
      seen.clip.left - slack,
    );
  expect(seen.box.right, "card ends inside what clips it").toBeLessThanOrEqual(
    seen.clip.right + slack,
  );
  expect(seen.box.top, "card top is inside what clips it")
    .toBeGreaterThanOrEqual(
      seen.clip.top - slack,
    );
  expect(seen.box.bottom, "card bottom is inside what clips it")
    .toBeLessThanOrEqual(seen.clip.bottom + slack);
  expect(seen.copyReachable, "a click at the centre of Copy reaches Copy")
    .toBe(true);
}
