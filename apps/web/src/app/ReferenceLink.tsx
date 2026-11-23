import * as UI from "@bakery/ui";
import { useI18n } from "../i18n/I18nProvider.tsx";

const KIND_WORD = {
  commit: "core.reference.kind.commit",
  release: "core.reference.kind.release",
  pullRequest: "core.reference.kind.pullRequest",
  issue: "core.reference.kind.issue",
  task: "core.reference.kind.task",
  run: "core.reference.kind.run",
  machine: "core.reference.kind.machine",
  person: "core.reference.kind.person",
} as const;

/**
 * The one way a screen shows an id, number or name that points at something
 * (owner rule, #59): a link when it has a page, plain text with Copy when it
 * does not. Never trim an id by hand; pass the whole value.
 */
export function ReferenceLink(
  props: Omit<UI.ReferenceProps, "labels">,
) {
  const { translate } = useI18n();
  return (
    <UI.Reference
      {...props}
      labels={{
        kind: translate(KIND_WORD[props.kind]),
        copy: translate("core.reference.copy"),
        copied: translate("core.reference.copied"),
        copyFailed: translate("core.reference.copyFailed"),
        close: translate("core.reference.close"),
        opensNewTab: translate("core.reference.opensNewTab"),
        ...(props.external === true
          ? { destination: translate("core.reference.opensOutside") }
          : {}),
      }}
    />
  );
}
