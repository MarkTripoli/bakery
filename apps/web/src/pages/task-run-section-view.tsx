import type { ReactNode } from "react";
import * as UI from "@bakery/ui";

export function TaskRunSectionView(
  { title, overview, execution, revision, artifacts, details }: {
    readonly title: string;
    readonly overview?: ReactNode;
    readonly execution: ReactNode;
    readonly revision?: ReactNode;
    readonly artifacts?: ReactNode;
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
      {details}
    </UI.Stack>
  );
}
