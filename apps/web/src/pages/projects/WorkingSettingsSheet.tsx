import { useId, useState } from "react";
import * as UI from "@bakery/ui";
import type {
  RepositoryProfileResponse,
  RepositoryResponse,
} from "../../api/client.ts";
import { RouterLink } from "../../app/router-link.tsx";
import { useI18n } from "../../i18n/I18nProvider.tsx";
import {
  branchesOf,
  fixesBranches,
  folderOf,
  isCheckMade,
  newestFirst,
  nextRevision,
  parseBranches,
  rulesInForce,
  sameRules,
  settingsProblem,
} from "./repository-state.ts";
import { useRepositorySettings } from "./use-repository-settings.ts";

/**
 * The working settings of one repository (design-ux, #65): which branches
 * Bakery may work from and, under Advanced, the folder. Saving makes the next
 * version and puts it in use; earlier versions are listed with "Use version".
 * The version number is worked out here and never typed.
 */
export function WorkingSettingsSheet(
  { repository, profiles, active, canManage, offline, onClose }: Readonly<{
    repository: RepositoryResponse;
    profiles: readonly RepositoryProfileResponse[];
    active: RepositoryProfileResponse | null;
    canManage: boolean;
    offline: boolean;
    onClose: () => void;
  }>,
) {
  const { translate, locale, timeZone } = useI18n();
  const id = useId();
  const settings = useRepositorySettings(repository);
  const [branchText, setBranchText] = useState(
    () =>
      (active === null ? [repository.defaultBranch] : branchesOf(active.config))
        .join("\n"),
  );
  const [folder, setFolder] = useState(() =>
    active === null ? "" : folderOf(active.config)
  );
  const [advanced, setAdvanced] = useState(() => folder !== "");
  const [tried, setTried] = useState(false);
  // Using an earlier version asks first: what changes, and what does not.
  const [confirming, setConfirming] = useState<
    RepositoryProfileResponse | null
  >(null);

  const branches = parseBranches(branchText);
  const problem = settingsProblem(branches, folder);
  const next = nextRevision(profiles, repository.nextProfileRevision);
  const archived = repository.archivedAt !== null;
  // A repository with rules of its own is changed the same way as any other
  // (design-ux, #65): the branches are saved and the rules stay exactly as they
  // are, which the server does (`keepRepositoryRules`). The rules pin the
  // working folder, so it is shown as text with where to change it. A fixed
  // policy locks the branches: they are text too, and there is nothing to save.
  const rulesBind = active !== null && rulesInForce(active.config);
  const branchesFixed = active !== null && fixesBranches(active.config);
  const disabled = !canManage || offline || archived || settings.pending;
  // Where the person is sent, for those who may open it: the link follows the
  // sentence on a line of its own (the shared link is a 44px target, which
  // does not sit inside a sentence); the others get the sentence alone.
  const rulesLink = canManage
    ? (
      <RouterLink
        to="/projects/repositories/$repositoryId/rules"
        params={{ repositoryId: repository.id }}
      >
        {translate("projects.repository.rules" as never)}
      </RouterLink>
    )
    : null;
  const organizationRulesLink = canManage
    ? (
      <RouterLink to="/settings/organization/repository-rules">
        {translate("projects.repository.settings.organizationRules" as never)}
      </RouterLink>
    )
    : null;
  const failureText = (kind: string, version: number) => {
    const sentence = translate(
      `projects.repository.failure.${kind}` as never,
      { version },
    );
    return kind === "branchesLocked" && organizationRulesLink !== null
      ? (
        <UI.Stack gap="tight">
          <span>{sentence}</span>
          {organizationRulesLink}
        </UI.Stack>
      )
      : sentence;
  };
  const folderText = active === null ? "" : folderOf(active.config);
  // Putting a version in use that does not carry the rules in force switches
  // them off: said in the confirmation, whose button is then the danger kind.
  const rulesStopWith = (candidate: RepositoryProfileResponse) =>
    !rulesBind || active === null ||
      (rulesInForce(candidate.config) &&
        sameRules(active.config, candidate.config))
      ? null
      : rulesInForce(candidate.config)
      ? "projects.repository.use.otherRules"
      : "projects.repository.use.rulesStop";
  const stopKey = confirming === null ? null : rulesStopWith(confirming);
  const earlier = newestFirst(profiles);
  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(
      new Date(value),
    );

  const branchError = !tried
    ? undefined
    : problem === "branches"
    ? translate("projects.repository.settings.branchesEmpty" as never)
    : problem === "tooMany"
    ? translate("projects.repository.settings.branchesTooMany" as never)
    : problem === "tooLong"
    ? translate("projects.repository.settings.branchesTooLong" as never)
    : problem === "characters"
    ? translate("projects.repository.settings.branchesControl" as never)
    : undefined;
  const folderError = tried && problem === "folder"
    ? translate("projects.repository.settings.folderInvalid" as never)
    : undefined;

  const submit = async () => {
    setTried(true);
    if (problem !== null || disabled) return;
    const saved = await settings.save({
      previous: active,
      revision: next,
      branches,
      folder,
    });
    if (saved) onClose();
  };

  return (
    <>
      <UI.Sheet
        open
        onOpenChange={(open) => !open && !settings.pending && onClose()}
        state={settings.pending ? "submitting" : "open"}
        title={translate("projects.repository.settings.title" as never)}
        variant="side"
      >
        <UI.Stack gap="standard">
          <UI.Text variant="muted">
            {translate("projects.repository.settings.intro" as never)}
          </UI.Text>
          {!canManage
            ? (
              <UI.InlineNotice tone="information">
                {translate("projects.repository.adminOnly" as never)}
              </UI.InlineNotice>
            )
            : null}
          {archived
            ? (
              <UI.InlineNotice tone="information">
                {translate("projects.repository.archivedNotice" as never)}
              </UI.InlineNotice>
            )
            : null}
          {settings.failure === null ? null : (
            <UI.InlineNotice
              role="alert"
              tone={settings.failure.kind === "conflict" ? "warning" : "error"}
            >
              {failureText(
                settings.failure.kind,
                settings.failure.version ?? 0,
              )}
            </UI.InlineNotice>
          )}
          {branchesFixed
            ? (
              <>
                <UI.InlineNotice
                  tone="information"
                  data-testid="branches-fixed"
                >
                  <UI.Stack gap="tight">
                    <span>
                      {translate(
                        "projects.repository.settings.branchesFixed" as never,
                      )}
                    </span>
                    {organizationRulesLink}
                  </UI.Stack>
                </UI.InlineNotice>
                <UI.Stack gap="compact">
                  <UI.Text variant="strong">
                    {translate(
                      "projects.repository.settings.worksFrom" as never,
                    )}
                  </UI.Text>
                  <UI.Stack gap="tight" role="list" data-testid="branches-text">
                    {branchesOf(active?.config).map((branch) => (
                      <div key={branch} role="listitem">
                        <UI.DataText>{branch}</UI.DataText>
                      </div>
                    ))}
                  </UI.Stack>
                </UI.Stack>
              </>
            )
            : (
              <UI.Field
                label={translate(
                  "projects.repository.settings.branches" as never,
                )}
                htmlFor={`${id}-branches`}
                variant="textarea"
                required
                hint={translate(
                  "projects.repository.settings.branchesHelp" as never,
                )}
                error={branchError}
              >
                <textarea
                  id={`${id}-branches`}
                  name="branches"
                  rows={4}
                  cols={40}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={branchError === undefined ? undefined : true}
                  disabled={disabled}
                  value={branchText}
                  onChange={(event) => setBranchText(event.target.value)}
                />
              </UI.Field>
            )}
          {rulesBind || branchesFixed
            ? (
              <UI.Stack gap="compact" data-testid="folder-text">
                <UI.Text variant="strong">
                  {translate("projects.repository.settings.folder" as never)}
                </UI.Text>
                <UI.DataText>
                  {folderText === ""
                    ? translate(
                      "projects.repository.settings.folderWhole" as never,
                    )
                    : folderText}
                </UI.DataText>
                {rulesBind
                  ? (
                    <>
                      <UI.Text variant="muted">
                        {translate(
                          "projects.repository.settings.folderSetByRules" as never,
                        )}
                      </UI.Text>
                      {rulesLink}
                    </>
                  )
                  : null}
              </UI.Stack>
            )
            : (
              <>
                <UI.Button
                  variant="text"
                  aria-expanded={advanced}
                  aria-controls={`${id}-advanced`}
                  onClick={() => setAdvanced(!advanced)}
                >
                  {translate("projects.repository.settings.advanced" as never)}
                </UI.Button>
                <div id={`${id}-advanced`} hidden={!advanced}>
                  <UI.Field
                    label={translate(
                      "projects.repository.settings.folder" as never,
                    )}
                    htmlFor={`${id}-folder`}
                    hint={translate(
                      "projects.repository.settings.folderHelp" as never,
                    )}
                    error={folderError}
                  >
                    <UI.TextInput
                      type="text"
                      id={`${id}-folder`}
                      name="folder"
                      invalid={folderError !== undefined}
                      autoComplete="off"
                      disabled={disabled}
                      value={folder}
                      onChange={setFolder}
                    />
                  </UI.Field>
                </div>
              </>
            )}
          {branchesFixed ? null : (
            <>
              <UI.Text variant="muted">
                {active === null
                  ? translate(
                    "projects.repository.settings.savesFirst" as never,
                    {
                      next,
                    },
                  )
                  : translate(
                    (isCheckMade(active.config)
                      ? "projects.repository.settings.savesAfterCheck"
                      : "projects.repository.settings.saves") as never,
                    { next, current: active.revision },
                  )}
              </UI.Text>
              <UI.Inline gap="compact">
                <UI.Button
                  variant="primary"
                  disabled={disabled}
                  loading={settings.pending}
                  onClick={() => void submit()}
                >
                  {settings.pending
                    ? translate("projects.repository.settings.saving" as never)
                    : translate("projects.repository.settings.save" as never)}
                </UI.Button>
                <UI.Button
                  variant="secondary"
                  disabled={settings.pending}
                  onClick={onClose}
                >
                  {translate("projects.repository.settings.cancel" as never)}
                </UI.Button>
              </UI.Inline>
            </>
          )}
          {earlier.length === 0 ? null : (
            <>
              <UI.Heading level="subsection">
                {translate("projects.repository.versions.title" as never)}
              </UI.Heading>
              <UI.Text variant="muted">
                {translate("projects.repository.versions.note" as never)}
              </UI.Text>
              <UI.Stack gap="compact">
                {earlier.map((profile) => (
                  <UI.StackedRow
                    flush
                    key={profile.id}
                    data-testid={`profile-version-${profile.revision}`}
                    title={translate(
                      "projects.repository.earlier.row" as never,
                      {
                        version: profile.revision,
                        date: date(profile.createdAt),
                      },
                    )}
                    status={profile.id === active?.id
                      ? (
                        <UI.Badge tone="success">
                          {translate(
                            "projects.repository.earlier.inUse" as never,
                          )}
                        </UI.Badge>
                      )
                      : (
                        <UI.Button
                          variant="secondary"
                          disabled={disabled}
                          onClick={() => setConfirming(profile)}
                        >
                          {translate(
                            "projects.repository.earlier.use" as never,
                            { version: profile.revision },
                          )}
                        </UI.Button>
                      )}
                  />
                ))}
              </UI.Stack>
            </>
          )}
        </UI.Stack>
      </UI.Sheet>
      {confirming === null ? null : (
        <UI.AlertDialog
          open
          onOpenChange={(next) =>
            !next && !settings.pending && setConfirming(null)}
          state={settings.pending ? "confirming" : "open"}
          title={translate("projects.repository.use.title" as never, {
            version: confirming.revision,
          })}
          cancelAction={
            <UI.Button
              variant="secondary"
              disabled={settings.pending}
              onClick={() => setConfirming(null)}
            >
              {translate("projects.repository.settings.cancel" as never)}
            </UI.Button>
          }
          confirmAction={
            <UI.Button
              variant={stopKey === null ? "primary" : "destructive"}
              disabled={disabled}
              loading={settings.pending}
              onClick={() =>
                void settings.use(confirming).then((used) => {
                  if (used) setConfirming(null);
                })}
            >
              {translate("projects.repository.earlier.use" as never, {
                version: confirming.revision,
              })}
            </UI.Button>
          }
        >
          <UI.Stack gap="compact">
            <UI.Text>
              {active === null
                ? translate("projects.repository.use.bodyFirst" as never, {
                  version: confirming.revision,
                })
                : translate("projects.repository.use.body" as never, {
                  version: confirming.revision,
                  current: active.revision,
                })}
              {
                /* Leaving a check-made version for a person's drops the check's
                   evidence until the check runs again. */
              }
              {isCheckMade(active?.config) && !isCheckMade(confirming.config)
                ? ` ${translate("projects.repository.use.afterCheck" as never)}`
                : ""}
            </UI.Text>
            {stopKey === null
              ? null
              : (
                <UI.Text variant="strong" data-testid="use-rules-stop">
                  {translate(stopKey as never, {
                    version: confirming.revision,
                  })}
                </UI.Text>
              )}
            {settings.failure === null ? null : (
              <UI.InlineNotice
                role="alert"
                tone={settings.failure.kind === "conflict"
                  ? "warning"
                  : "error"}
              >
                {failureText(
                  settings.failure.kind,
                  settings.failure.version ?? 0,
                )}
              </UI.InlineNotice>
            )}
          </UI.Stack>
        </UI.AlertDialog>
      )}
    </>
  );
}
