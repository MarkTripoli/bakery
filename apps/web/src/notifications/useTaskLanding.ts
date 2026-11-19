import { useEffect, useRef, useState } from "react";
import { landOn } from "./landed.ts";
import { type LandingSearch, parseLanding } from "./landing.ts";

/** How long to keep looking for the part, while the page's data arrives. */
const LOOK_MS = 4_000;

/** The element a landing names; the run section's heading when it names none. */
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
  const arrived = landing.at !== undefined || landing.n !== undefined;

  useEffect(() => {
    if (!enabled || done.current || landing.gone === true || !arrived) return;
    const selector = selectorFor(landing);
    if (selector === null) return;
    const started = performance.now();
    let frame = 0;
    const look = () => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element) {
        done.current = true;
        const heading = element.matches("h1,h2,h3,h4")
          ? element
          : element.querySelector<HTMLElement>("h1,h2,h3,h4");
        landOn(element, heading);
        setState({ settled: true, missing: false });
      } else if (performance.now() - started > LOOK_MS) {
        done.current = true;
        setState({ settled: true, missing: parseLanding(landing.at) !== null });
      } else frame = requestAnimationFrame(look);
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [arrived, enabled, landing]);

  return state;
}
