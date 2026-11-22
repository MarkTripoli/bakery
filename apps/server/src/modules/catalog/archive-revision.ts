import type {
  ActionAuthorityRunner,
  ActionContext,
} from "@bakery/contracts/action-registry";
import { StandardError } from "@bakery/contracts/http";
import { CatalogImplementedAction } from "@bakery/contracts/implemented-actions";
import {
  type SkillSourceAdapter,
  SkillSourceAdapterError,
} from "./source-adapters.ts";

/** How long admission waits for a web-address archive it pins by digest. */
const ARCHIVE_REVISION_TIMEOUT_MS = 8_000;

/**
 * skills.import with no revision for a web-address archive: the address is read
 * once, with no transaction open, and the import is pinned by the archive's
 * content digest. The authority below stages it; the handler reads the stage.
 */
export const archiveRevisionStage = Symbol("archiveRevisionStage");

export type ArchiveRevisionStage = {
  /** What the first pass read: where to fetch from. */
  locator?: string;
  path?: string;
  /** What the fetch pinned (`sha256:<hex>`); set for the second pass. */
  revision?: string;
};

export type ArchiveRevisionContext = ActionContext & {
  [archiveRevisionStage]?: ArchiveRevisionStage;
};

/** Thrown by the first pass so its transaction is given up before the fetch. */
export class ArchiveRevisionPreflightRollbackError extends Error {
  constructor() {
    super("SKILL_ARCHIVE_REVISION_PREFLIGHT_ROLLBACK");
    this.name = "ArchiveRevisionPreflightRollbackError";
  }
}

/**
 * Runs skills.import in two passes when it names no revision: the first reads
 * the source and gives its connection up, the archive is fetched with none open
 * and pinned by its digest, and the second admits it. Every other action, and
 * an import that names a revision, runs under `base` untouched.
 */
export function createArchiveRevisionAuthority(
  base: ActionAuthorityRunner,
  adapter: SkillSourceAdapter | undefined,
): ActionAuthorityRunner {
  return {
    async run(action, context, input, next) {
      const wantsDigest =
        action.name === CatalogImplementedAction.SkillsImport &&
        (input as { revision?: unknown } | null)?.revision === undefined;
      if (!wantsDigest) return await base.run(action, context, input, next);
      const stage: ArchiveRevisionStage = {};
      const staged = () =>
        Object.assign({}, context, { [archiveRevisionStage]: stage });
      try {
        return await base.run(action, staged(), input, next);
      } catch (error) {
        if (!(error instanceof ArchiveRevisionPreflightRollbackError)) {
          throw error;
        }
      }
      if (stage.locator === undefined || adapter === undefined) {
        throw new StandardError({ code: "DEPENDENCY_UNAVAILABLE" });
      }
      try {
        const proof = await adapter.fetchPinnedSource({
          sourceType: "url",
          locator: stage.locator,
          requestedRevision: "",
          path: stage.path || undefined,
          signal: AbortSignal.timeout(ARCHIVE_REVISION_TIMEOUT_MS),
        });
        stage.revision = proof.sourceRevision;
      } catch (error) {
        throw new StandardError({
          code: "DEPENDENCY_UNAVAILABLE",
          params: {
            reason: error instanceof SkillSourceAdapterError
              ? error.code
              : "SOURCE_UNAVAILABLE",
          },
        });
      }
      return await base.run(action, staged(), input, next);
    },
  };
}
