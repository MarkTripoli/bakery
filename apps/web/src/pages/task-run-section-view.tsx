import type { ReactNode } from "react";
import * as UI from "@bakery/ui";

export function TaskRunSectionView(
  { title, overview, execution, revision, artifacts, delivery, details }: {
    readonly title: string;
    readonly overview?: ReactNode;
    readonly execution: ReactNode;
    readonly revision?: ReactNode;
    readonly artifacts?: ReactNode;
    readonly delivery?: ReactNode;
    readonly details?: ReactNode;
  },
) {
  return (
    <UI.Stack>
      {overview}
      <UI.RunOutputView variant="section" title={title}>
        {execution}
        {revision}
        {artifacts}
      </UI.RunOutputView>
      {delivery}
      {details}
    </UI.Stack>
  );
}
