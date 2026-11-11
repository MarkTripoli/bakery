import type { HTMLAttributes, ReactNode } from "react";
import type { SemanticNativeProps } from "../foundations/semantic-native-props.ts";
import "../data.css";

export type AppearancePreviewProps =
  & SemanticNativeProps<
    Omit<HTMLAttributes<HTMLDivElement>, "children" | "title">
  >
  & {
    /** Name of the sample surface, e.g. "Work". */
    label: ReactNode;
    /** Quiet tag on the header's far side, e.g. "Preview". */
    caption: ReactNode;
    /** Sample task title. */
    title: ReactNode;
    /** Muted line under the title. */
    meta: ReactNode;
    /** Sample status, e.g. a `StatusBadge`. */
    status: ReactNode;
    /** Sample action text; shown as an action but never focusable. */
    action: ReactNode;
  };

/**
 * The sample Work card on the Appearance page — Paper O-0 `Preview`: a
 * header strip over one task row, so a person sees the chosen theme on real
 * product chrome. It is decoration only: hidden from assistive technology and
 * inert, so nothing in it is announced, focused or activated.
 */
export function AppearancePreview(
  { action, caption, label, meta, status, title, ...props }:
    AppearancePreviewProps,
) {
  return (
    <div
      aria-hidden="true"
      className="ui-appearance-preview"
      {...props}
      data-state="default"
      data-ui-component="appearancePreview"
      data-variant="card"
      inert
    >
      <div className="ui-appearance-preview__header">
        <span className="ui-appearance-preview__label">{label}</span>
        <span className="ui-appearance-preview__caption">{caption}</span>
      </div>
      <div className="ui-appearance-preview__body">
        <span className="ui-appearance-preview__title">{title}</span>
        <span className="ui-appearance-preview__meta">{meta}</span>
        <span className="ui-appearance-preview__row">
          {status}
          <span className="ui-appearance-preview__action">{action}</span>
        </span>
      </div>
    </div>
  );
}
