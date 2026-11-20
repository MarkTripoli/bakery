import { useId, useState } from "react";
import * as UI from "@bakery/ui";
import {
  EVIDENCE_VALUE_LIMIT,
  type EvidenceRow,
  evidenceRows,
  type PluginVersion,
  shortFingerprint,
} from "../../app/plugins.ts";
import { useI18n } from "../../i18n/I18nProvider.tsx";

/** One thing Bakery proved: the check icon, in the success colour, leading the sentence. */
function CheckedLine({ children }: { readonly children: string }) {
  return (
    <UI.DescriptionItem
      data-testid="origin-checked-line"
      icon={
        <UI.Text variant="positive">
          <UI.IconGlyph name="check" />
        </UI.Text>
      }
      title={<UI.Text>{children}</UI.Text>}
    />
  );
}

/** One of the publisher's own entries: its name as written at the start, its value at the end, cut when long. */
function StatedRow({ row }: { readonly row: EvidenceRow }) {
  const { translate } = useI18n();
  const [all, setAll] = useState(false);
  const long = row.value.length > EVIDENCE_VALUE_LIMIT;
  const shown = long && !all
    ? `${row.value.slice(0, EVIDENCE_VALUE_LIMIT)}…`
    : row.value;
  return (
    <UI.Stack gap="compact" data-testid="stated-row">
      <UI.Stack gap="none">
        <UI.Text variant="muted">{row.name}</UI.Text>
        <UI.DataText>{shown}</UI.DataText>
      </UI.Stack>
      {long
        ? (
          <UI.Inline gap="compact">
            <UI.Button
              variant="text"
              onClick={() => setAll((previous) => !previous)}
            >
              {all
                ? translate("settings.plugins.origin.showLess")
                : translate("settings.plugins.origin.showAll")}
            </UI.Button>
          </UI.Inline>
        )
        : null}
    </UI.Stack>
  );
}

/** Source or Build: a label for the group of entries under it, never a heading. */
function StatedPart(
  { title, rows, empty }: {
    readonly title: string;
    readonly rows: readonly EvidenceRow[];
    readonly empty: string;
  },
) {
  return (
    <UI.Stack gap="compact">
      <UI.Text variant="caption">{title}</UI.Text>
      {rows.length === 0
        ? <UI.Text variant="muted">{empty}</UI.Text>
        : rows.map((row) => <StatedRow key={row.name} row={row} />)}
    </UI.Stack>
  );
}

/**
 * "Where version {v} came from": what Bakery proved, then what the publisher
 * only says. The proven group comes first and the stated group never carries a
 * pass mark, so the two cannot be mistaken for each other.
 */
export function OriginDialog(
  { version, installedOn, onClose }: {
    readonly version: PluginVersion;
    /** True for the version the install runs: its compatibility was checked on switching. */
    readonly installedOn: boolean;
    readonly onClose: () => void;
  },
) {
  const { translate } = useI18n();
  const statedHeadingId = useId();
  return (
    <UI.Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={translate("settings.plugins.origin.title", {
        version: version.versionName,
      })}
      variant="information"
      data-testid="plugin-origin"
    >
      <UI.Stack gap="standard">
        <UI.Stack gap="tight" data-testid="origin-checked">
          <UI.Heading level="subsection">
            {translate("settings.plugins.origin.checkedHeading")}
          </UI.Heading>
          <UI.DescriptionList>
            <CheckedLine>
              {translate("settings.plugins.origin.matched", {
                fingerprint: shortFingerprint(version.bundleDigest),
              })}
            </CheckedLine>
            {installedOn
              ? (
                <CheckedLine>
                  {translate("settings.plugins.origin.works")}
                </CheckedLine>
              )
              : null}
          </UI.DescriptionList>
        </UI.Stack>
        <UI.Stack gap="compact" data-testid="origin-stated">
          <UI.Heading level="subsection" id={statedHeadingId}>
            {translate("settings.plugins.origin.statedHeading")}
          </UI.Heading>
          <UI.InlineNotice
            tone="neutral"
            role="group"
            aria-labelledby={statedHeadingId}
          >
            <UI.Stack gap="standard">
              <UI.Text variant="hint">
                {translate("settings.plugins.origin.statedCaption")}
              </UI.Text>
              <StatedPart
                title={translate("settings.plugins.origin.source")}
                rows={evidenceRows(version.sourceEvidence)}
                empty={translate("settings.plugins.origin.noSource")}
              />
              <StatedPart
                title={translate("settings.plugins.origin.build")}
                rows={evidenceRows(version.buildEvidence)}
                empty={translate("settings.plugins.origin.noBuild")}
              />
            </UI.Stack>
          </UI.InlineNotice>
        </UI.Stack>
        <UI.Inline gap="compact">
          <UI.Button variant="secondary" onClick={onClose}>
            {translate("settings.plugins.origin.close")}
          </UI.Button>
        </UI.Inline>
      </UI.Stack>
    </UI.Dialog>
  );
}
