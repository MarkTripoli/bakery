import type { ReactNode } from "react";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import { ShellActiveNavigation } from "../../shell/shell-slots.tsx";

export function SharedFrame(
  { title, notice, testId, children }: {
    title: ReactNode | null;
    notice: ReactNode;
    testId: string;
    children: ReactNode;
  },
) {
  return (
    <>
      <ShellActiveNavigation id="work" />
      <UI.Stack gap="spacious" data-testid={testId}>
        {title === null
          ? null
          : <UI.PageHeader variant="list" flush title={title} />}
        <UI.InlineNotice tone="information">{notice}</UI.InlineNotice>
        {children}
      </UI.Stack>
    </>
  );
}

export function SharedLoading() {
  const { translate } = useI18n();
  return (
    <UI.Stack
      aria-busy="true"
      aria-label={translate("notifications.loading")}
      gap="compact"
    >
      {Array.from({ length: 3 }).map((_, index) => (
        <UI.Skeleton key={index} shape="text" />
      ))}
    </UI.Stack>
  );
}
