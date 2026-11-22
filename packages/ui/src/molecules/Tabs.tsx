import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
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
  const listRef = useRef<HTMLDivElement>(null);
  const firstScroll = useRef(true);
  // Which edges of the list have more tabs beyond them. Physical sides, read
  // from the real scroll position and the reading direction, so a fade shows
  // only while tabs are hidden past that edge, and never when all fit.
  const [fade, setFade] = useState({ left: false, right: false });
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const rtl = getComputedStyle(list).direction === "rtl";
      const away = rtl ? -list.scrollLeft : list.scrollLeft;
      const hidden = list.scrollWidth - list.clientWidth;
      const before = away > 1;
      const after = hidden - away > 1;
      const next = { left: rtl ? after : before, right: rtl ? before : after };
      setFade((current) =>
        current.left === next.left && current.right === next.right
          ? current
          : next
      );
    };
    measure();
    list.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => {
      list.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [tabs.length]);
  // The selected tab is brought fully into view when the page opens and when
  // the selection changes: sideways only (the page itself never moves), clear
  // of the fade, and without animation for someone who asked for less motion.
  const selectedKey = selected?.id;
  useEffect(() => {
    const list = listRef.current;
    const tab = selectedKey === undefined
      ? null
      : document.getElementById(tabDomId(selectedKey));
    if (!list || !tab) return;
    const inset = Number.parseFloat(
      getComputedStyle(list).getPropertyValue("--space-6"),
    ) || 0;
    const box = list.getBoundingClientRect();
    const at = tab.getBoundingClientRect();
    const delta = at.left < box.left + inset
      ? at.left - box.left - inset
      : at.right > box.right - inset
      ? at.right - box.right + inset
      : 0;
    const calm = firstScroll.current ||
      globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
    firstScroll.current = false;
    if (delta !== 0) {
      list.scrollBy({ left: delta, behavior: calm ? "auto" : "smooth" });
    }
  }, [selectedKey]);
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
        <div
          aria-label={ariaLabel}
          className="ui-tabs__list"
          data-fade-left={fade.left ? "true" : undefined}
          data-fade-right={fade.right ? "true" : undefined}
          ref={listRef}
          role="tablist"
        >
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
