import { type KeyboardEvent, type ReactNode, useId } from "react";
import "../controls.css";

export type Tab = {
  content: ReactNode;
  disabled?: boolean;
  id: string;
  label: string;
};
export type TabsProps = {
  "aria-label": string;
  onSelect: (id: string) => void;
  selectedId: string;
  state?: "default" | "selected" | "focus" | "disabled";
  tabs: readonly Tab[];
  /** Control placed after the tab list in the same row (outside `tablist`). */
  trailing?: ReactNode;
  variant?: "route" | "view";
};

export function Tabs(
  {
    "aria-label": ariaLabel,
    onSelect,
    selectedId,
    state,
    tabs,
    trailing,
    variant = "view",
  }: TabsProps,
) {
  const instanceId = useId();
  const selected = tabs.find((tab) => tab.id === selectedId && !tab.disabled) ??
    tabs.find((tab) => !tab.disabled);
  const tabDomId = (id: string) => `${instanceId}-tab-${id}`;
  const panelDomId = (id: string) => `${instanceId}-panel-${id}`;
  const moveFocus = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (
      !selected ||
      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    ) return;
    event.preventDefault();
    let next = index;
    if (event.key === "Home") {
      next = tabs.findIndex((tab) => !tab.disabled);
    } else if (event.key === "End") {
      next = tabs.length - 1;
      while (next >= 0 && tabs[next]?.disabled) next -= 1;
    } else {
      const step = event.key === "ArrowRight" ? 1 : tabs.length - 1;
      do next = (next + step) % tabs.length; while (tabs[next]?.disabled);
    }
    const tab = tabs[next];
    if (!tab || tab.disabled) return;
    onSelect(tab.id);
    document.getElementById(tabDomId(tab.id))?.focus();
  };
  if (!selected) return null;
  return (
    <div
      className={`ui-tabs ui-tabs--${variant}`}
      data-ui-component="tabs"
      data-state={state ?? "selected"}
      data-variant={variant}
    >
      <div className="ui-tabs__bar">
        <div aria-label={ariaLabel} className="ui-tabs__list" role="tablist">
          {tabs.map((tab, index) => (
            <button
              aria-controls={panelDomId(tab.id)}
              aria-selected={tab.id === selected.id}
              className="ui-tabs__tab"
              id={tabDomId(tab.id)}
              key={tab.id}
              disabled={tab.disabled}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(event) => moveFocus(event, index)}
              role="tab"
              tabIndex={tab.id === selected.id ? 0 : -1}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
        {trailing}
      </div>
      <div
        aria-labelledby={tabDomId(selected.id)}
        className="ui-tabs__panel"
        id={panelDomId(selected.id)}
        role="tabpanel"
      >
        {selected.content}
      </div>
    </div>
  );
}
