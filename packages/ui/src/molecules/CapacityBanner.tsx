import type { ReactNode } from "react";
import "../artifacts.css";

export type CapacityBannerProps = {
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly actions?: ReactNode;
  readonly state: "warning" | "paused";
};
export function CapacityBanner(
  { title, description, actions, state }: CapacityBannerProps,
) {
  return (
    <section
      className="ui-capacity-banner"
      role="status"
      data-ui-component="capacityBanner"
      data-variant="storage"
      data-state={state}
    >
      <h2>{title}</h2>
      <p>{description}</p>
      {actions ? <div className="ui-artifact-actions">{actions}</div> : null}
    </section>
  );
}
