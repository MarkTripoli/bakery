# CI evidence storage and trust boundaries

Status: active design for artifact-free candidate CI. Connected/native
acceptance and scheduled retention are deferred.

## Active topology

`Bakery CI` runs on the candidate Hetzner runners. Its required lanes emit
bounded, identity-bound evidence archives into their ordinary job logs rather
than GitHub Actions artifacts. Each lane stages its archive under a
run/attempt/job-specific `/tmp` directory. The aggregate checks required GitHub
job conclusions directly and cleans the run's handoffs and dangling volumes.
Green candidate CI is evidence that its jobs ran; it is not independent
authorization against a malicious edit to the CI workflow or policy.

The read-only description-policy job uses the trusted default-branch workflow
and reports its native job conclusion. It does not publish a write-scoped custom
status. No trusted-verifier workflow or backend publisher runs in this
repository. Until a separate controller is provisioned, no
`Bakery / trusted verifier` or `Bakery / connected/native backend` status is
authoritative or required for merge. An owner must manually inspect changes to
workflows, CI policies, credentials, and required jobs, then confirm green
exact-head candidate CI and the description-policy result before merge. This
manual procedure is not an enforceable GitHub branch-protection rule on the
current private plan.

The connected/native dispatch workflow and scheduled
Actions-artifact/Release-evidence pruning workflows are not shipped in this
cutover. Their live execution, isolation, and write-credential boundaries remain
unproven. Do not interpret their unit fixtures or the job-log reader library as
deployed operational acceptance or retention. Any future activation requires its
own runner, credential review, and live acceptance.

## Evidence sink and limits

The selected transport is ordinary job logs, which remain available through
authenticated GitHub API requests without Actions artifact storage. The handoff
format binds run id, attempt, workflow, candidate, base, and lane; bounded
archive and log reconstruction reject missing, mismatched, oversized, or unsafe
entries. `scripts/ci/release-evidence.ts` implements the emitter and the bounded
reader, but no connected/native authority or scheduled retention is active.

Release assets remain a separate possible durable sink, not candidate CI
transport. An orphan evidence branch would add ACL, cleanup, and
concurrent-writer complexity; external object storage would require a new
credential and metering policy. Neither is enabled. No sink is literally
unlimited or unmetered. Implementation limits include a 64 MiB compressed
archive, 64 MiB extracted bytes, 512 entries, 16 MiB per entry, 512 KiB
manifest, 32 MiB reconstructed job-log archive, 64 KiB log chunks, and 64 MiB
streamed job-log input. These are software bounds, not provider quotas.

The relevant APIs are
[workflow-job logs](https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run)
and [Release assets](https://docs.github.com/en/rest/releases/assets);
[Actions billing](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions)
is separate from both software limits and the project's no-payment policy.

## Deferred acceptance

Artifact-free candidate CI and its job-log handoff can be checked on a
current-head PR run. They do **not** prove connected/native end-to-end
acceptance, scheduled pruning, or independent trusted verification. Those remain
separate work if the capabilities are needed. A future controller must be
candidate-inaccessible and prove its status publication and failure behavior
live before anyone treats it as an admission gate.
