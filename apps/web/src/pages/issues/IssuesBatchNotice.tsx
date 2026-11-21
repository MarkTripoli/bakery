import { useNavigate } from "@tanstack/react-router";
import * as UI from "@bakery/ui";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import type { BatchNotice } from "./batch-notice-model.ts";

/**
 * "A batch is running: 2 of 5 merged, working on #409." under the Issues
 * header, with the way to its page. A batch that asks before each next issue
 * says that instead; a person who is needed gets the warning tone. The
 * repository is named only when the list shows more than one.
 */
export function IssuesBatchNotice(
  { notice, repository }: {
    readonly notice: BatchNotice;
    /** The repository's name, or null when the list is already one repository. */
    readonly repository: string | null;
  },
) {
  const { translate } = useI18n();
  const navigate = useNavigate();
  const where = repository === null ? "none" : "named";
  return (
    <UI.InlineNotice
      tone={notice.tone}
      data-batch-notice={notice.batchId}
      data-batch-state={notice.state}
      action={
        <UI.Button
          variant="secondary"
          aria-label={translate("issues.batch.openNamed" as never, {
            repository: repository ?? "",
            named: repository === null ? "no" : "yes",
          })}
          onClick={() =>
            void navigate({
              to: "/issues/batches/$batchId",
              params: { batchId: notice.batchId },
            })}
        >
          {translate("issues.batch.open" as never)}
        </UI.Button>
      }
    >
      {notice.state === "waiting"
        ? translate("issues.batch.noticeWaiting" as never, {
          where,
          repository: repository ?? "",
          done: notice.done,
          max: notice.max,
        })
        : translate("issues.batch.notice" as never, {
          batch: notice.state,
          where,
          repository: repository ?? "",
          done: notice.done,
          max: notice.max,
          tail: notice.tail,
          number: notice.number,
        })}
    </UI.InlineNotice>
  );
}
