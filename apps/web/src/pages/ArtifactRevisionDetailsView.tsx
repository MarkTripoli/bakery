import { useId } from "react";
import * as UI from "@bakery/ui";
import { formatDate } from "@bakery/i18n";
import type {
  ArtifactExtractionResponse,
  ArtifactResponse,
  ArtifactVersionResponse,
} from "../api/client.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { isExtractableMediaType } from "./artifact-media.ts";

function displayValue(
  value: string | null | undefined,
  fallback: string,
): string {
  return value === null || value === undefined || value.length === 0
    ? fallback
    : value;
}

function Detail({
  label,
  value,
  variant,
}: {
  readonly label: string;
  readonly value: string;
  readonly variant?: "identifier" | "timestamp";
}) {
  return (
    <UI.DescriptionItem
      description={<UI.DataText variant={variant}>{value}</UI.DataText>}
      title={label}
    />
  );
}

/**
 * A labelled, scrollable source block. The accessible name comes from a
 * visible heading instead of an `aria-label` on the `<pre>`: `<pre>` maps to
 * role `generic`, which prohibits an accessible name (axe
 * `aria-prohibited-attr`). The block therefore takes `role="region"` — a role
 * that legitimately names — and points at that heading, so the keyboard stop
 * `state="overflowing"` creates for `.ui-code-block`'s always-`overflow:auto`
 * box (WCAG 2.1.1 scrollable region) is a named stop rather than an anonymous
 * one.
 */
function LabelledCode({
  code,
  label,
  language,
  testId,
}: {
  readonly code: string;
  readonly label: string;
  readonly language?: string;
  readonly testId: string;
}) {
  const labelId = useId();
  return (
    <UI.Stack gap="compact">
      <UI.Heading id={labelId} level="subsection" rank={3}>
        {label}
      </UI.Heading>
      <UI.CodeBlock
        aria-labelledby={labelId}
        code={code}
        data-testid={testId}
        language={language}
        role="region"
        state="overflowing"
      />
    </UI.Stack>
  );
}

export type ArtifactRevisionDetailsProps = {
  readonly artifact: ArtifactResponse;
  readonly organizationId: string | null;
  readonly artifactCount?: number;
  readonly retrying: boolean;
  readonly selectedVersion: ArtifactVersionResponse | null;
  readonly versionItems: readonly ArtifactVersionResponse[];
  readonly onSelectVersion: (id: string) => void;
  readonly extraction: {
    readonly maxBytes: number;
    readonly startByte: string;
    readonly onStartByteChange: (value: string) => void;
    readonly onExtract: () => void;
    readonly validationError: string | null;
    readonly loading: boolean;
    readonly failed: boolean;
    readonly requested: boolean;
    readonly invalid: boolean;
    readonly result: ArtifactExtractionResponse | null;
  };
};

export function ArtifactRevisionDetailsView(
  {
    artifact,
    organizationId,
    artifactCount,
    retrying,
    selectedVersion,
    versionItems,
    onSelectVersion,
    extraction,
  }: ArtifactRevisionDetailsProps,
) {
  const { translate, locale, timeZone: dateTimeZone } = useI18n();
  const taskId = artifact.taskId;
  const metadata = selectedVersion === null
    ? null
    : JSON.stringify(selectedVersion.metadata, null, 2) ?? "null";
  const extractable = selectedVersion !== null &&
    isExtractableMediaType(selectedVersion.mediaType);
  const extractionResult = extraction.result;
  return (
    <UI.Stack gap="spacious">
      <UI.Stack gap="compact">
        <UI.Text>{translate("artifact.retrieval.description")}</UI.Text>
        <UI.Inline gap="compact">
          <UI.Text variant="caption">
            {translate("artifact.retrieval.organization", {
              organization: organizationId ?? "",
            })}
          </UI.Text>
          <UI.Text variant="caption">
            {translate("artifact.retrieval.task", { task: taskId })}
          </UI.Text>
          {
            /* Only a complete first page is a total; a cursor means more
                    rows exist, so no count is asserted at all. */
          }
          {artifactCount !== undefined
            ? (
              <UI.Text variant="caption">
                {translate("artifact.retrieval.taskArtifactCount", {
                  count: artifactCount,
                })}
              </UI.Text>
            )
            : null}
        </UI.Inline>
        {retrying
          ? (
            <UI.InlineNotice
              data-testid="artifact-retrieval-reconnecting"
              tone="information"
            >
              {translate("shell.states.reconnectingDescription")}
            </UI.InlineNotice>
          )
          : null}
      </UI.Stack>

      <UI.DescriptionList data-testid="artifact-retrieval-metadata">
        <Detail
          label={translate("artifact.retrieval.artifactTypeLabel")}
          value={artifact.artifactType}
        />
        <Detail
          label={translate("artifact.retrieval.artifactIdLabel")}
          value={artifact.id}
        />
        <Detail
          label={translate("artifact.retrieval.currentVersionLabel")}
          value={displayValue(
            artifact.currentVersionId,
            translate("artifact.retrieval.noCurrentVersion"),
          )}
        />
        <Detail
          label={translate("artifact.retrieval.updatedLabel")}
          value={formatDate(new Date(artifact.updatedAt), locale, {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: dateTimeZone,
          })}
          variant="timestamp"
        />
      </UI.DescriptionList>

      {artifact.currentVersionId === null
        ? (
          <UI.InlineNotice
            data-testid="artifact-retrieval-empty"
            tone="information"
          >
            {translate("artifact.retrieval.emptyNotice")}
          </UI.InlineNotice>
        )
        : selectedVersion === null
        ? (
          <UI.ErrorState
            data-testid="artifact-retrieval-missing-version"
            description={translate(
              "artifact.retrieval.missingVersionDescription",
            )}
            title={translate("artifact.retrieval.missingVersionTitle")}
            variant="region"
          />
        )
        : (
          <>
            <UI.Stack gap="standard">
              <UI.Heading level="section" rank={2}>
                {translate("artifact.retrieval.versionsTitle")}
              </UI.Heading>
              <UI.DescriptionList data-testid="artifact-retrieval-versions">
                {versionItems.map((version) => (
                  <UI.DescriptionItem
                    action={version.id === selectedVersion.id
                      ? <UI.IconGlyph name="check" size="large" />
                      : undefined}
                    aria-pressed={version.id === selectedVersion.id}
                    data-testid={`artifact-version-${version.revision}`}
                    description={translate(
                      "artifact.retrieval.versionSummary",
                      {
                        mediaType: version.mediaType,
                        size: version.sizeBytes,
                      },
                    )}
                    onSelect={() => onSelectVersion(version.id)}
                    title={translate("artifact.retrieval.versionLabel", {
                      revision: version.revision,
                    })}
                    key={version.id}
                  />
                ))}
              </UI.DescriptionList>
            </UI.Stack>

            <UI.Stack
              data-testid="artifact-retrieval-provenance"
              gap="standard"
            >
              <UI.Heading level="section" rank={2}>
                {translate("artifact.retrieval.provenanceTitle")}
              </UI.Heading>
              <UI.ArtifactDescriptor
                artifactId={artifact.id}
                digest={selectedVersion.sha256}
                labels={{
                  artifactId: translate(
                    "artifact.retrieval.artifactIdLabel",
                  ),
                  version: translate("artifact.retrieval.revisionLabel"),
                  digest: translate("artifact.retrieval.digestLabel"),
                  size: translate("artifact.retrieval.sizeLabel"),
                  mediaType: translate(
                    "artifact.retrieval.mediaTypeLabel",
                  ),
                  provenance: translate(
                    "artifact.retrieval.runStepLabel",
                  ),
                  link: translate("tasks.artifact.open"),
                }}
                mediaType={selectedVersion.mediaType}
                provenance={displayValue(
                  selectedVersion.runStepId,
                  translate("artifact.retrieval.notAvailable"),
                )}
                size={translate("artifact.retrieval.sizeValue", {
                  size: selectedVersion.sizeBytes,
                })}
                version={String(selectedVersion.revision)}
              />
              <UI.DescriptionList>
                <Detail
                  label={translate("artifact.retrieval.authorLabel")}
                  value={selectedVersion.authorId}
                />
                <Detail
                  label={translate("artifact.retrieval.subjectHeadLabel")}
                  value={displayValue(
                    selectedVersion.subjectHeadSha,
                    translate("artifact.retrieval.notAvailable"),
                  )}
                />
                <Detail
                  label={translate("artifact.retrieval.subjectBaseLabel")}
                  value={displayValue(
                    selectedVersion.subjectBaseSha,
                    translate("artifact.retrieval.notAvailable"),
                  )}
                />
                <Detail
                  label={translate("artifact.retrieval.createdLabel")}
                  value={formatDate(
                    new Date(selectedVersion.createdAt),
                    locale,
                    {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: dateTimeZone,
                    },
                  )}
                  variant="timestamp"
                />
              </UI.DescriptionList>
              {metadata !== null
                ? (
                  <LabelledCode
                    code={metadata}
                    label={translate("artifact.retrieval.metadataLabel")}
                    language="json"
                    testId="artifact-retrieval-version-metadata"
                  />
                )
                : null}
            </UI.Stack>

            <UI.Stack gap="standard">
              <UI.Heading level="section" rank={2}>
                {translate("artifact.retrieval.downloadTitle")}
              </UI.Heading>
              <UI.Text>
                {translate("artifact.retrieval.downloadDescription")}
              </UI.Text>
            </UI.Stack>

            <UI.Stack
              data-testid="artifact-retrieval-extraction"
              gap="standard"
            >
              <UI.Heading level="section" rank={2}>
                {translate("artifact.retrieval.extractionTitle")}
              </UI.Heading>
              {extractable
                ? (
                  <>
                    <UI.Field
                      error={extraction.validationError ?? undefined}
                      hint={translate(
                        "artifact.retrieval.extractionHint",
                        {
                          maxBytes: extraction.maxBytes,
                        },
                      )}
                      htmlFor="artifact-extraction-start-byte"
                      label={translate(
                        "artifact.retrieval.startByteLabel",
                      )}
                    >
                      <UI.TextInput
                        autoComplete="off"
                        id="artifact-extraction-start-byte"
                        inputMode="numeric"
                        name="startByte"
                        onChange={extraction.onStartByteChange}
                        type="text"
                        value={extraction.startByte}
                      />
                    </UI.Field>
                    <UI.Button
                      aria-busy={extraction.loading || undefined}
                      data-testid="artifact-retrieval-extract"
                      onClick={extraction.onExtract}
                      state={extraction.loading ? "loading" : "default"}
                    >
                      {translate("artifact.retrieval.extract")}
                    </UI.Button>
                    {extraction.failed
                      ? (
                        <UI.InlineNotice tone="error">
                          {translate(
                            "artifact.retrieval.extractionFailed",
                          )}
                        </UI.InlineNotice>
                      )
                      : extraction.requested && extraction.loading
                      ? (
                        <UI.InlineNotice tone="information">
                          {translate(
                            "artifact.retrieval.extractionLoading",
                          )}
                        </UI.InlineNotice>
                      )
                      : extraction.requested &&
                          extraction.invalid
                      ? (
                        <UI.InlineNotice tone="error">
                          {translate(
                            "artifact.retrieval.extractionFailed",
                          )}
                        </UI.InlineNotice>
                      )
                      : extractionResult !== null
                      ? (
                        <UI.Stack
                          data-testid="artifact-retrieval-extraction-result"
                          gap="compact"
                        >
                          <UI.InlineNotice
                            tone={extractionResult.hasMore
                              ? "warning"
                              : "success"}
                          >
                            {extractionResult.hasMore
                              ? translate(
                                "artifact.retrieval.extractionTruncated",
                                {
                                  start: extractionResult.startByte,
                                  end: extractionResult.endByteExclusive,
                                },
                              )
                              : translate(
                                "artifact.retrieval.extractionComplete",
                                {
                                  start: extractionResult.startByte,
                                  end: extractionResult.endByteExclusive,
                                },
                              )}
                          </UI.InlineNotice>
                          {extractionResult.text.length === 0
                            ? (
                              <UI.InlineNotice tone="information">
                                {translate(
                                  "artifact.retrieval.extractionEmpty",
                                )}
                              </UI.InlineNotice>
                            )
                            : (
                              <LabelledCode
                                code={extractionResult.text}
                                label={translate(
                                  "artifact.retrieval.extractionTextLabel",
                                )}
                                language={extractionResult.mediaType}
                                testId="artifact-retrieval-extraction-text"
                              />
                            )}
                        </UI.Stack>
                      )
                      : null}
                  </>
                )
                : (
                  <UI.InlineNotice
                    data-testid="artifact-retrieval-unsafe-media"
                    tone="warning"
                  >
                    {translate(
                      "artifact.retrieval.unsupportedMediaDescription",
                    )}
                  </UI.InlineNotice>
                )}
            </UI.Stack>
          </>
        )}
    </UI.Stack>
  );
}
