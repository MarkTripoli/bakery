import { Radio, type RadioProps } from "../atoms/Radio.tsx";
import "../data.css";

export type ThemeChoicePreview = "light" | "dark" | "system";

export type ThemeChoiceProps = RadioProps & {
  /** Which miniature the card previews; the label text names the choice. */
  theme: ThemeChoicePreview;
};

function PreviewPane({ tone }: { tone: "light" | "dark" }) {
  return (
    <span
      className={`ui-theme-choice__pane ui-theme-choice__pane--${tone}`}
    >
      <span className="ui-theme-choice__rail" />
      <span className="ui-theme-choice__page">
        <span className="ui-theme-choice__title" />
        <span className="ui-theme-choice__rule" />
        <span className="ui-theme-choice__line" />
        <span className="ui-theme-choice__line" />
      </span>
    </span>
  );
}

/**
 * One Appearance theme option — Paper O-0 `Color theme` cards: a miniature of
 * the shell in that theme beside (phone) or above (desktop) a labelled radio.
 * The whole card selects the radio, so the card is as large a target as the
 * mock draws; the miniature is decorative and the radio label carries the name.
 */
export function ThemeChoice({ theme, ...radioProps }: ThemeChoiceProps) {
  const state = radioProps.disabled
    ? "disabled"
    : radioProps.checked
    ? "selected"
    : "default";
  return (
    <div
      className="ui-theme-choice"
      data-state={state}
      data-ui-component="themeChoice"
      data-variant={theme}
    >
      <span
        aria-hidden="true"
        className={`ui-theme-choice__preview ui-theme-choice__preview--${theme}`}
      >
        {theme === "system"
          ? (
            <>
              <PreviewPane tone="light" />
              <PreviewPane tone="dark" />
            </>
          )
          : <PreviewPane tone={theme} />}
      </span>
      <Radio {...radioProps} />
    </div>
  );
}
