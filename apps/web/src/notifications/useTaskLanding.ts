import { useEffect, useRef, useState } from "react";
import { LANDED_MS, landOn } from "./landed.ts";
import { type LandingSearch, parseLanding } from "./landing.ts";

/** How long to keep looking for the part, while the page's data arrives. */
const LOOK_MS = 4_000;
/**
 * The part must stay the same element this long before it is landed on: a
 * section that mounts while its data loads is often replaced when the data
 * arrives, which would drop the focus the landing just set.
 */
const STABLE_MS = 400;

/**
 * The element a landing names; the run section's heading when it names none.
 */
function selectorFor(landing: LandingSearch): string | null {
  const target = parseLanding(landing.at);
  if (target === null) {
    return landing.at === undefined ? "#task-run-heading" : null;
  }
  switch (target.kind) {
    case "step":
      return `[data-landing-step="${target.id}"]`;
    case "question":
      return `[data-question-id="${target.id}"]`;
    case "approval":
      return `[data-approval-id="${target.id}"]`;
    case "message":
      return `[data-message-id="${target.id}"]`;
    default:
      return null;
  }
}

/**
 * Brings the part of the task page a notification was about into view: the
 * step's thread, an approval or question card, or the "Current run" section
 * when the notification names none. The part may still be loading, so it is
 * looked for for a few seconds; when it never appears, `missing` is true and
 * the page says so. A plain visit (no landing in the address) does nothing.
 */
export function useTaskLanding(
  landing: LandingSearch,
  enabled: boolean,
): { settled: boolean; missing: boolean } {
  const [state, setState] = useState<{ settled: boolean; missing: boolean }>({
    settled: false,
    missing: false,
  });
  const done = useRef(false);
  const at = landing.at;
  const gone = landing.gone === true;
  const arrived = at !== undefined || landing.n !== undefined;

  useEffect(() => {
    if (!enabled || done.current || gone || !arrived) return;
    const selector = selectorFor({ at });
    if (selector === null) {
      done.current = true;
      setState({ settled: true, missing: false });
      return;
    }
    const started = performance.now();
    let frame = 0;
    let candidate: HTMLElement | null = null;
    let since = 0;
    const look = () => {
      // The same part can be on the page twice (a card and the panel it opens,
      // the panel inside a closed sheet): land on the one that can be seen.
      const element = Array.from(
        document.querySelectorAll<HTMLElement>(selector),
      ).find((candidateElement) =>
        candidateElement.getClientRects().length > 0
      ) ??
        null;
      if (element !== candidate) {
        candidate = element;
        since = performance.now();
      }
      if (element && performance.now() - since >= STABLE_MS) {
        done.current = true;
        const heading = element.matches("h1,h2,h3,h4")
          ? element
          : element.querySelector<HTMLElement>("h1,h2,h3,h4");
        landOn(element, heading);
        setState({ settled: true, missing: false });
        // The part can be re-rendered while its outline shows (the data
        // arrives again): keep the outline on whichever element is current.
        let current = element;
        const until = performance.now() + LANDED_MS;
        const keep = () => {
          const now = Array.from(
            document.querySelectorAll<HTMLElement>(selector),
          ).find((found) => found.getClientRects().length > 0);
          if (now && now !== current) {
            current = now;
            landOn(
              now,
              now.matches("h1,h2,h3,h4")
                ? now
                : now.querySelector<HTMLElement>("h1,h2,h3,h4"),
            );
          }
          if (performance.now() < until) frame = requestAnimationFrame(keep);
        };
        frame = requestAnimationFrame(keep);
      } else if (!element && performance.now() - started > LOOK_MS) {
        done.current = true;
        // On the page but not on screen (inside a closed sheet): it is not
        // gone, so say nothing and stay at the top.
        const hidden = document.querySelector(selector) !== null;
        setState({
          settled: true,
          missing: !hidden && parseLanding(at) !== null,
        });
      } else frame = requestAnimationFrame(look);
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [arrived, at, enabled, gone]);

  return state;
}
