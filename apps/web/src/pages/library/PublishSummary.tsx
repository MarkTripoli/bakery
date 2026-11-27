import * as UI from "@bakery/ui";
import type { MessageKey } from "@bakery/i18n";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { PublishChanges } from "./publish-changes.ts";

type PublishKey = MessageKey extends infer Key
  ? Key extends `library.editor.publish.${infer Suffix}` ? Suffix : never
  : never;

export function PublishSummary(
  {
    changes,
    inUseRevision,
    publishedBefore,
    startsChanged,
    problemCount,
    blocked,
  }: {
    readonly changes: PublishChanges;
    readonly inUseRevision: number | null;
    readonly publishedBefore: boolean;
    readonly startsChanged: boolean;
    readonly problemCount: number;
    readonly blocked: boolean;
  },
) {
  const { translate } = useI18n();
  const copy = (key: PublishKey, values?: Record<string, string | number>) =>
    translate(`library.editor.publish.${key}`, values);
  const lists = [
    ["new", changes.added],
    ["changed", changes.changed],
    ["removed", changes.removed],
  ] as const;
  return (
    <UI.Stack gap="tight" data-testid="publish-changes">
      <UI.Text variant="strong">
        {inUseRevision !== null
          ? copy("changesSince", { version: inUseRevision })
          : publishedBefore
          ? translate("library.editor.version.draft")
          : copy("firstVersion")}
      </UI.Text>
      {lists.map(([kind, names]) =>
        names.length === 0 ? null : (
          <UI.Text key={kind}>
            {copy(kind, { names: names.join(", ") })}
          </UI.Text>
        )
      )}
      {changes.limits.map((limit, index) => (
        <UI.Text key={index}>
          {copy(limit.unit === "tries" ? "limitTries" : "limitItems", {
            name: limit.name,
            max: limit.max,
            was: limit.was,
          })}
        </UI.Text>
      ))}
      {changes.reordered ? <UI.Text>{copy("reordered")}</UI.Text> : null}
      {changes.grouped ? <UI.Text>{copy("grouped")}</UI.Text> : null}
      {changes.other ? <UI.Text>{copy("other")}</UI.Text> : null}
      {changes.settings ? <UI.Text>{copy("settings")}</UI.Text> : null}
      {startsChanged && inUseRevision !== null
        ? <UI.Text>{copy("starts")}</UI.Text>
        : null}
      {blocked || problemCount > 0
        ? null
        : <UI.Text variant="muted">{copy("noProblems")}</UI.Text>}
    </UI.Stack>
  );
}
