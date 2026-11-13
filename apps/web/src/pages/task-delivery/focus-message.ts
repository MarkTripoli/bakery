import { MESSAGE_FIELD_ID } from "../task-conversation/Composer.tsx";

/** Scrolls to the task's message field and focuses it; false when it is not on the page. */
export function focusMessageField(): boolean {
  const field = document.getElementById(MESSAGE_FIELD_ID);
  if (field === null) return false;
  field.scrollIntoView({ block: "center" });
  field.focus();
  return true;
}
