import type { ReactNode } from "react";
import * as UI from "@bakery/ui";

export function TaskRunStreamView(
  { identity, output, selection, pagination }: {
    readonly identity: UI.RunIdentityProps;
    readonly output: UI.RunOutputPanelProps;
    readonly selection?: ReactNode;
    readonly pagination?: ReactNode;
  },
) {
  return (
    <UI.Stack>
      {selection}
      <UI.RunIdentity {...identity} />
      <UI.RunOutputPanel {...output} />
      {pagination}
    </UI.Stack>
  );
}
