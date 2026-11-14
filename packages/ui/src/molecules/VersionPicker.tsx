import type { ReactNode } from "react";
import { IconGlyph } from "../atoms/IconGlyph.tsx";
import "../artifacts.css";

export type ArtifactVersionOption = {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
};
export type VersionPickerProps = {
  readonly label: ReactNode;
  readonly value: string;
  readonly versions: readonly ArtifactVersionOption[];
  readonly onChange: (versionId: string) => void;
  readonly disabled?: boolean;
  readonly labelHidden?: boolean;
  /** Names the paged list these versions are, so a page can move focus to the picker after loading more. */
  readonly name?: string;
};

export function VersionPicker(
  {
    label,
    value,
    versions,
    onChange,
    disabled = false,
    labelHidden = false,
    name,
  }: VersionPickerProps,
) {
  return (
    <label
      className="ui-version-picker"
      data-ui-component="versionPicker"
      data-variant="select"
      data-state={disabled ? "disabled" : "ready"}
    >
      <span
        className={labelHidden ? "ui-version-picker__hidden-label" : undefined}
      >
        {label}
      </span>
      <span className="ui-version-picker__control">
        <select
          data-paged-list={name}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          {versions.map((version) => (
            <option
              key={version.id}
              value={version.id}
              disabled={version.disabled}
            >
              {version.label}
            </option>
          ))}
        </select>
        <IconGlyph name="chevron-down" size="small" />
      </span>
    </label>
  );
}
