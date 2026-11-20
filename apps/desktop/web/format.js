// Small pure helpers for the window page, kept apart from the DOM code so they can be tested.

/** The deadline in this person's own clock, which only the page can know reliably. */
export function formatTime(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}
