import type { WorkflowStart } from "@bakery/contracts/workflow-starts";
import type { MessageArguments, MessageKey } from "@bakery/i18n";
import { automaticStarts } from "./start-list.ts";

export function startCardOf(
  starts: readonly WorkflowStart[],
  translate: (key: MessageKey, values?: MessageArguments) => string,
): { readonly title: string; readonly line: string } | undefined {
  return starts.length === 0 ? undefined : {
    title: translate("library.editor.start.title"),
    line: translate("library.editor.start.card", {
      count: automaticStarts(starts),
    }),
  };
}
