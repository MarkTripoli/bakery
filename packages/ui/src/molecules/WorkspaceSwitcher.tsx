import type { ReactNode } from "react";
import { useState } from "react";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import { Menu, type MenuItem } from "./Menu.tsx";
import { Popover } from "./Popover.tsx";
import "../navigation.css";

export type WorkspaceSwitcherProps = {
  /** Accessible name of the menu the trigger opens, e.g. "Switch workspace". */
  label: string;
  /** Visible name of the active workspace. */
  workspace: ReactNode;
  items: MenuItem[];
  onSelect?: (id: string) => void;
  state?: "default" | "open";
  variant?: "full" | "compact";
};

/**
 * Names the active workspace (organization) under the brand and opens its
 * switch actions. Paper 5J-0 sidebar: 14/20 medium name with a 16px chevron;
 * `compact` (pane rail) shows a building glyph and keeps the name for
 * assistive technology.
 */
export function WorkspaceSwitcher(
  {
    items,
    label,
    onSelect,
    state = "default",
    variant = "full",
    workspace,
  }: WorkspaceSwitcherProps,
) {
  const [open, setOpen] = useState(state === "open");
  return (
    <div
      className={`bakery-workspace-switcher bakery-workspace-switcher--${variant}`}
      data-state={open ? "open" : "default"}
      data-ui-component="workspaceSwitcher"
      data-variant={variant}
    >
      <Popover
        label={label}
        onOpenChange={setOpen}
        open={open}
        trigger={
          <span className="bakery-workspace-switcher__trigger">
            {variant === "compact" ? <IconGlyph name="building" /> : null}
            <span className="bakery-workspace-switcher__name">
              {workspace}
            </span>
            {variant === "full"
              ? <IconGlyph name="chevron-down" size="small" />
              : null}
          </span>
        }
        variant="interactive"
      >
        <Menu
          aria-label={label}
          items={items}
          onSelect={(id) => {
            setOpen(false);
            onSelect?.(id);
          }}
        />
      </Popover>
    </div>
  );
}
