import type { PgTransactionClient } from "../../platform/database.ts";
import type { LineCount } from "./line-counter.ts";

export async function storeLineCount(
  transaction: PgTransactionClient,
  input: Readonly<{
    organizationId: string;
    pullRequestId: string;
    headSha: string;
    count: LineCount;
  }>,
): Promise<boolean> {
  const stored = await transaction.query(
    `insert into bakery.pull_request_line_counts
       (organization_id, pull_request_id, head_sha, counter_version,
        coverage, added, deleted, counted_files, excluded_files,
        binary_files, categories)
     select pr.organization_id, pr.id, $3, $4, $5, $6, $7, $8, $9, $10,
            $11::jsonb
       from bakery.pull_requests as pr
      where pr.organization_id = $1 and pr.id = $2 and pr.head_sha = $3
     on conflict (pull_request_id, head_sha, counter_version) do nothing`,
    [
      input.organizationId,
      input.pullRequestId,
      input.headSha,
      input.count.counterVersion,
      input.count.coverage,
      input.count.added,
      input.count.deleted,
      input.count.countedFiles,
      input.count.excludedFiles,
      input.count.binaryFiles,
      JSON.stringify(input.count.categories),
    ],
  );
  return (stored.rowCount ?? 0) > 0;
}
