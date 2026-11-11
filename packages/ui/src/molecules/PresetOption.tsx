import { type ReactNode, useId } from "react";
import { Radio, type RadioProps } from "../atoms/Radio.tsx";
import "../collaboration.css";

export type PresetOptionProps =
  & Omit<
    RadioProps,
    "children" | "title" | "aria-labelledby" | "aria-describedby"
  >
  & {
    /** Short preset name; it names the radio. */
    title: ReactNode;
    /** One line describing the preset; it describes the radio. */
    description?: ReactNode;
    /** Short flag for a preset that needs setup; it also describes the radio. */
    unavailable?: ReactNode;
  };

/**
 * One preset as a radio card. It reuses the queue inspector option recipe
 * (Paper 5J-0: the inline `QuestionCard` option over `Radio`) and adds only
 * the title and description lines. A disabled card drops the selected frame.
 */
export function PresetOption(
  { title, description, unavailable, ...radioProps }: PresetOptionProps,
) {
  const id = useId();
  const state = radioProps.disabled
    ? "disabled"
    : unavailable
    ? "unavailable"
    : radioProps.checked
    ? "selected"
    : "default";
  return (
    <div
      className="ui-preset-option"
      data-state={state}
      data-ui-component="presetOption"
      data-variant="card"
    >
      <Radio
        {...radioProps}
        aria-describedby={[
          description ? `${id}-description` : null,
          unavailable ? `${id}-unavailable` : null,
        ].filter(Boolean).join(" ") || undefined}
        aria-labelledby={`${id}-title`}
      >
        <span className="ui-preset-option__text">
          <span className="ui-preset-option__title" id={`${id}-title`}>
            {title}
          </span>
          {description
            ? (
              <span
                className="ui-preset-option__description"
                id={`${id}-description`}
              >
                {description}
              </span>
            )
            : null}
          {unavailable
            ? (
              <span
                className="ui-preset-option__unavailable"
                id={`${id}-unavailable`}
              >
                {unavailable}
              </span>
            )
            : null}
        </span>
      </Radio>
    </div>
  );
}
