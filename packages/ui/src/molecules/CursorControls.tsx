import "../data.css";

export type CursorControlsLabels = {
  controls: string;
  end: string;
  loadMore: string;
  loading: string;
  next: string;
  previous: string;
  retry: string;
};

export type CursorControlsProps = {
  hasNext?: boolean;
  hasPrevious?: boolean;
  labels?: CursorControlsLabels;
  onNext?: () => void;
  onPrevious?: () => void;
  onRetry?: () => void;
  state?: "ready" | "loading" | "end" | "error";
  variant?: "loadMore" | "previousNext";
};

const DEFAULT_LABELS: CursorControlsLabels = {
  controls: "List controls",
  end: "End of results.",
  loadMore: "Load more",
  loading: "Loading…",
  next: "Next",
  previous: "Previous",
  retry: "Retry",
};

export function CursorControls(
  {
    hasNext = false,
    hasPrevious = false,
    labels = DEFAULT_LABELS,
    onNext,
    onPrevious,
    onRetry,
    state = "ready",
    variant = "loadMore",
  }: CursorControlsProps,
) {
  if (state === "end") {
    return (
      <p
        aria-live="polite"
        className="ui-cursor-controls"
        data-ui-component="cursorControls"
        data-state={state}
        data-variant={variant}
      >
        {labels.end}
      </p>
    );
  }
  if (state === "error") {
    return (
      <div
        className="ui-cursor-controls"
        data-ui-component="cursorControls"
        data-state={state}
        data-variant={variant}
        role="alert"
      >
        <button onClick={onRetry} type="button">{labels.retry}</button>
      </div>
    );
  }
  return (
    <nav
      aria-label={`${labels.controls} (${variant} ${state})`}
      className="ui-cursor-controls"
      data-ui-component="cursorControls"
      data-state={state}
      data-variant={variant}
    >
      {variant === "previousNext" && (
        <button
          disabled={!hasPrevious || state === "loading"}
          onClick={onPrevious}
          type="button"
        >
          {labels.previous}
        </button>
      )}
      <button
        disabled={!hasNext || state === "loading"}
        onClick={onNext}
        type="button"
      >
        {state === "loading"
          ? labels.loading
          : variant === "loadMore"
          ? labels.loadMore
          : labels.next}
      </button>
    </nav>
  );
}
