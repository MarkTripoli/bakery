import { useState } from "react";
import { Avatar } from "../atoms/Avatar.tsx";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import { Menu, type MenuItem } from "./Menu.tsx";
import { Popover } from "./Popover.tsx";
import "../navigation.css";

export type UserMenuProps = {
  /** Signed-in person's display name; also derives the avatar initials. */
  name: string;
  /** Accessible name of the account menu, e.g. "Account". */
  label: string;
  items: MenuItem[];
  onSelect?: (id: string) => void;
  state?: "default" | "open";
  variant?: "full" | "compact";
};

/**
 * Account footer of the sidebar: avatar, name and a menu of account actions
 * (Paper 5J-0 footer row). `compact` keeps only the avatar for the pane rail.
 */
export function UserMenu(
  {
    items,
    label,
    name,
    onSelect,
    state = "default",
    variant = "full",
  }: UserMenuProps,
) {
  const [open, setOpen] = useState(state === "open");
  return (
    <div
      className={`bakery-user-menu bakery-user-menu--${variant}`}
      data-state={open ? "open" : "default"}
      data-ui-component="userMenu"
      data-variant={variant}
    >
      <Popover
        label={label}
        onOpenChange={setOpen}
        open={open}
        trigger={
          <span className="bakery-user-menu__trigger">
            <Avatar alt={name} aria-hidden="true" size="small" />
            <span className="bakery-user-menu__name">{name}</span>
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
