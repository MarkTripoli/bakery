import { useNavigate, useSearch } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useShellViewport } from "../../app/responsive.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";

/**
 * How a workflow's steps are drawn (#67): the diagram, or the same workflow as
 * an outline list. The choice is in the address as `?view=outline` so a link,
 * a reload and the back button keep it; the diagram is the default.
 */
export type DiagramView = "diagram" | "outline";

export function useDiagramView(): readonly [
  DiagramView,
  (next: DiagramView) => void,
] {
  const search = useSearch({ strict: false }) as { view?: string };
  const navigate = useNavigate();
  const view: DiagramView = search.view === "outline" ? "outline" : "diagram";
  return [view, (next) => {
    void navigate({
      replace: true,
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        view: next === "outline" ? "outline" : undefined,
      }),
    } as never);
  }];
}

/**
 * The Diagram / Outline switch. A phone only ever has the outline, so there it
 * is not drawn and nothing is left to choose.
 */
export function DiagramViewSwitch(
  { onChange, view }: Readonly<
    { onChange: (next: DiagramView) => void; view: DiagramView }
  >,
) {
  const { translate } = useI18n();
  if (useShellViewport() === "phone") return null;
  return (
    <UI.SegmentedControl
      aria-label={translate("library.editor.view.label" as never)}
      name="workflow-view"
      onChange={(next) => onChange(next === "outline" ? "outline" : "diagram")}
      options={[
        {
          label: translate("library.editor.view.diagram" as never),
          value: "diagram",
        },
        {
          label: translate("library.editor.view.outline" as never),
          value: "outline",
        },
      ]}
      value={view}
      variant="inline"
    />
  );
}
