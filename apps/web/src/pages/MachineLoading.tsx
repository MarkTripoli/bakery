import * as UI from "@bakery/ui";

export function MachineLoading({ label }: { label: string }) {
  return (
    <UI.Stack gap="compact" role="status" aria-label={label}>
      <UI.Skeleton shape="row" />
      <UI.Skeleton shape="row" />
      <UI.Skeleton shape="row" />
    </UI.Stack>
  );
}
