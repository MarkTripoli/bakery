import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

const CANDIDATE_RESERVED_LABEL = "trusted-verifier";
const RESERVED_WORKFLOW_REFERENCES = [
  CANDIDATE_RESERVED_LABEL,
  "bakery / trusted verifier",
];
const FORBIDDEN_ARTIFACT_TRANSPORT_REFERENCES = [
  "actions/upload-artifact",
  "actions/download-artifact",
];
const GITHUB_HOSTED_LABELS = new Set([
  "ubuntu-24.04",
  "ubuntu-24.04-arm",
  "ubuntu-latest",
  "windows-2025",
]);
const isSingleGitHubHostedImage = (labels) =>
  labels.size === 1 && GITHUB_HOSTED_LABELS.has([...labels][0]);

const policyError = (workflowPath, message) => {
  throw new Error(`${workflowPath}: ${message}`);
};
const assertSafeNodes = (node, workflowPath, location = "document") => {
  if (node == null) return;
  if (node.anchor) {
    policyError(workflowPath, `unsupported YAML anchor at ${location}`);
  }
  if (isAlias(node)) {
    policyError(workflowPath, `unsupported YAML alias at ${location}`);
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      if (pair.key && isScalar(pair.key) && pair.key.value === "<<") {
        policyError(workflowPath, `unsupported YAML merge key at ${location}`);
      }
      assertSafeNodes(pair.key, workflowPath, `${location} key`);
      assertSafeNodes(pair.value, workflowPath, `${location} value`);
    }
    return;
  }
  if (isSeq(node)) {
    for (const [index, item] of node.items.entries()) {
      assertSafeNodes(item, workflowPath, `${location}[${index}]`);
    }
  }
};

const parseWorkflow = (source, workflowPath) => {
  const document = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (document.errors.length > 0) {
    policyError(
      workflowPath,
      `invalid YAML: ${
        document.errors.map((error) => error.message).join("; ")
      }`,
    );
  }
  const root = document.contents;
  if (!isMap(root)) {
    policyError(workflowPath, "workflow root must be a mapping");
  }
  assertSafeNodes(root, workflowPath);
  return root;
};
const assertDecodedWorkflowReferences = (
  node,
  workflowPath,
  location = "workflow",
  checkReserved = true,
) => {
  if (node == null) return;
  if (isScalar(node)) {
    if (typeof node.value === "string") {
      const value = node.value.toLowerCase();
      if (
        checkReserved &&
        RESERVED_WORKFLOW_REFERENCES.some((reference) =>
          value.includes(reference)
        )
      ) {
        policyError(
          workflowPath,
          "workflow references the removed trusted verifier",
        );
      }
      if (
        FORBIDDEN_ARTIFACT_TRANSPORT_REFERENCES.some((reference) =>
          value.includes(reference)
        )
      ) {
        policyError(
          workflowPath,
          "workflow uses a forbidden Actions artifact transport",
        );
      }
    }
    return;
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      assertDecodedWorkflowReferences(
        pair.key,
        workflowPath,
        `${location} key`,
        checkReserved,
      );
      assertDecodedWorkflowReferences(
        pair.value,
        workflowPath,
        `${location} value`,
        checkReserved,
      );
    }
    return;
  }
  if (isSeq(node)) {
    for (const [index, item] of node.items.entries()) {
      assertDecodedWorkflowReferences(
        item,
        workflowPath,
        `${location}[${index}]`,
        checkReserved,
      );
    }
    return;
  }
  policyError(workflowPath, `unsupported YAML node at ${location}`);
};

const mapEntries = (node, workflowPath, location) => {
  if (!isMap(node)) policyError(workflowPath, `${location} must be a mapping`);
  const keys = new Set();
  const entries = [];
  for (const pair of node.items) {
    if (
      !pair.key || !isScalar(pair.key) || typeof pair.key.value !== "string"
    ) {
      policyError(
        workflowPath,
        `${location} contains an unsupported mapping key`,
      );
    }
    const key = pair.key.value;
    if (keys.has(key)) {
      policyError(workflowPath, `${location} contains duplicate key ${key}`);
    }
    keys.add(key);
    entries.push({ key, value: pair.value });
  }
  return entries;
};

const permissionWriteScopes = (node, workflowPath, location) => {
  if (node == null) return new Set();
  if (isScalar(node)) {
    if (node.value === "write-all") {
      policyError(workflowPath, "workflows must not grant write-all");
    }
    return new Set();
  }
  const writes = new Set();
  for (const { key, value } of mapEntries(node, workflowPath, location)) {
    if (!isScalar(value)) {
      policyError(
        workflowPath,
        `${location} permission ${key} must be a scalar`,
      );
    }
    if (value.value === "write") writes.add(key);
  }
  return writes;
};

const assertWritePermissions = (root, workflowPath, labelSets) => {
  const rootEntries = mapEntries(root, workflowPath, "workflow root");
  const rootPermissions = rootEntries.find((entry) =>
    entry.key === "permissions"
  );
  const rootWrites = permissionWriteScopes(
    rootPermissions?.value,
    workflowPath,
    "workflow permissions",
  );
  if (rootWrites.has("statuses")) {
    policyError(
      workflowPath,
      "source workflows must not publish statuses",
    );
  }
  const jobsEntry = rootEntries.find((entry) => entry.key === "jobs");
  if (!jobsEntry) return;
  const jobs = mapEntries(jobsEntry.value, workflowPath, "jobs");
  for (
    const [{ key: jobName, value: jobNode }, labels] of jobs.map((
      entry,
      index,
    ) => [entry, labelSets[index]])
  ) {
    const jobEntries = mapEntries(jobNode, workflowPath, `job ${jobName}`);
    const jobPermissions = jobEntries.find((entry) =>
      entry.key === "permissions"
    );
    const effectivePermissions = jobPermissions ?? rootPermissions;
    if (!effectivePermissions || effectivePermissions.value == null) {
      policyError(
        workflowPath,
        `job ${jobName} permissions must be explicitly declared`,
      );
    }
    const writes = permissionWriteScopes(
      effectivePermissions.value,
      workflowPath,
      `job ${jobName} permissions`,
    );
    if (writes.has("statuses")) {
      policyError(workflowPath, "source workflows must not publish statuses");
    }
    if (writes.size > 0 && !isSingleGitHubHostedImage(labels)) {
      policyError(
        workflowPath,
        `job ${jobName} with write permissions must use a single GitHub-hosted image`,
      );
    }
  }
};

const selectorLabels = (node, workflowPath, jobName) => {
  const location = `job ${jobName} runs-on`;
  const values = isSeq(node) ? node.items : [node];
  if (isSeq(node) && values.length === 0) {
    policyError(workflowPath, `${location} must not be empty`);
  }
  if (!isSeq(node) && node == null) {
    policyError(
      workflowPath,
      `${location} must be a string or sequence of strings`,
    );
  }
  const labels = new Set();
  for (const [index, value] of values.entries()) {
    if (!isScalar(value) || typeof value.value !== "string") {
      policyError(
        workflowPath,
        `${location}[${index}] must be a string, not a mapping, alias, or dynamic value`,
      );
    }
    const label = value.value.trim().toLowerCase();
    if (!label || label.includes("${{")) {
      policyError(workflowPath, `${location}[${index}] is unsupported`);
    }
    labels.add(label);
  }
  return labels;
};

export const parseRunnerLabelSets = (source, workflowPath = "workflow.yml") => {
  const root = parseWorkflow(source, workflowPath);
  const rootEntries = mapEntries(root, workflowPath, "workflow root");
  const jobsEntry = rootEntries.find((entry) => entry.key === "jobs");
  if (!jobsEntry) {
    policyError(workflowPath, "workflow must declare a jobs mapping");
  }
  const jobs = mapEntries(jobsEntry.value, workflowPath, "jobs");
  if (jobs.length === 0) policyError(workflowPath, "jobs must not be empty");

  const labelSets = [];
  for (const { key: jobName, value: jobNode } of jobs) {
    const jobEntries = mapEntries(jobNode, workflowPath, `job ${jobName}`);
    const runsOn = jobEntries.filter((entry) => entry.key === "runs-on");
    const uses = jobEntries.filter((entry) => entry.key === "uses");
    if (runsOn.length + uses.length !== 1) {
      policyError(
        workflowPath,
        `job ${jobName} must have exactly one execution selector (runs-on or uses)`,
      );
    }
    if (uses.length === 1) {
      policyError(
        workflowPath,
        "candidate workflows must not call a trusted reusable workflow",
      );
    }
    labelSets.push(selectorLabels(runsOn[0].value, workflowPath, jobName));
  }
  return labelSets;
};

const assertCandidateRunnerLabels = (workflowPath, labelSets) => {
  for (const labels of labelSets) {
    if (labels.has(CANDIDATE_RESERVED_LABEL)) {
      policyError(
        workflowPath,
        "candidate workflow requests trusted-verifier",
      );
    }
    if (
      !isSingleGitHubHostedImage(labels) && !labels.has("ovh") &&
      !labels.has("hetzner")
    ) {
      policyError(
        workflowPath,
        "every non-single-GitHub-hosted runner-label set must include ovh or hetzner",
      );
    }
  }
};

export const assertCandidateWorkflowLabels = (
  workflowPath,
  source,
) => {
  const labelSets = parseRunnerLabelSets(source, workflowPath);
  assertCandidateRunnerLabels(workflowPath, labelSets);
  return labelSets;
};

export const assertWorkflowArtifactTransportPolicy = (workflowPath, source) => {
  assertDecodedWorkflowReferences(
    parseWorkflow(source, workflowPath),
    workflowPath,
    "workflow",
    false,
  );
};
export const assertWorkflowPolicy = (workflowPath, source) => {
  const labelSets = assertCandidateWorkflowLabels(workflowPath, source);
  const normalizedSource = source.toLowerCase();
  if (
    normalizedSource.includes(CANDIDATE_RESERVED_LABEL) ||
    normalizedSource.includes("bakery / trusted verifier")
  ) {
    policyError(
      workflowPath,
      "workflow references the removed trusted verifier",
    );
  }
  const root = parseWorkflow(source, workflowPath);
  assertDecodedWorkflowReferences(root, workflowPath);
  assertWritePermissions(root, workflowPath, labelSets);
  return labelSets;
};
