import type { ReactNode } from "react";
import { Avatar, type AvatarProps } from "../atoms/Avatar.tsx";
import "../data.css";

export type IdentityProps = {
  avatar?: AvatarProps;
  detail?: ReactNode;
  name: ReactNode;
  /** Hide the kind label when the context already says what this is. */
  showType?: boolean;
  state?: "default" | "offline" | "unavailable";
  type: "person" | "agent" | "harness" | "provider" | "machine";
};

export function Identity(
  { avatar, detail, name, showType = true, state = "default", type }:
    IdentityProps,
) {
  return (
    <span
      className={`ui-identity ui-identity--${type}`}
      data-ui-component="identity"
      data-variant={type}
      data-state={state}
    >
      {avatar ? <Avatar {...avatar} /> : null}
      <span>
        <span className="ui-identity__name">{name}</span>
        {showType ? <span className="ui-identity__type">{type}</span> : null}
        {detail ? <span className="ui-identity__detail">{detail}</span> : null}
        {state !== "default"
          ? <span className="ui-identity__state">{state}</span>
          : null}
      </span>
    </span>
  );
}
