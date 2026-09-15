// src/action.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, realpathSync as realpathSync2, statSync as statSync2, writeFileSync } from "node:fs";
import { dirname, isAbsolute as isAbsolute2, relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";

// src/evaluator.ts
var DEFAULT_POLICY = {
  maxManifestCharacters: 2e5,
  oversizedChangeLines: 1e3,
  riskyPathPatterns: [
    /^\.github\/workflows\//i,
    /(^|\/)auth([/.]|$)/i,
    /(^|\/)permissions?([/.]|$)/i,
    /(^|\/)migrations?([/.]|$)/i,
    /(^|\/)security([/.]|$)/i,
    /(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/i
  ]
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredString(record2, key) {
  const value = record2[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}
function requiredArray(record2, key) {
  const value = record2[key];
  if (!Array.isArray(value)) throw new Error(`Invalid ${key}`);
  return value;
}
function assertUniqueIds(items, label) {
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label} IDs`);
}
function isSafeRelativePath(path) {
  if (!path || path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return false;
  const segments = path.split("/");
  return !segments.some((segment) => segment === ".." || segment === "");
}
function isSafeScope(scope) {
  const withoutGlobs = scope.replaceAll("**", "x").replaceAll("*", "x");
  return isSafeRelativePath(withoutGlobs);
}
function parseChangedFile(value) {
  if (!isRecord(value)) throw new Error("Invalid changedFiles item");
  const path = requiredString(value, "path");
  const additions = value.additions;
  const deletions = value.deletions;
  if (!isSafeRelativePath(path)) throw new Error(`Unsafe changed file path: ${path}`);
  if (!Number.isInteger(additions) || Number(additions) < 0) throw new Error(`Invalid additions for ${path}`);
  if (!Number.isInteger(deletions) || Number(deletions) < 0) throw new Error(`Invalid deletions for ${path}`);
  if (value.binary !== void 0 && typeof value.binary !== "boolean") throw new Error(`Invalid binary flag for ${path}`);
  return { path, additions: Number(additions), deletions: Number(deletions), binary: value.binary };
}
function parseCheck(value) {
  if (!isRecord(value)) throw new Error("Invalid checks item");
  const id = requiredString(value, "id");
  const status = value.status;
  if (status !== "pass" && status !== "fail" && status !== "skipped") throw new Error(`Unknown check status: ${String(status)}`);
  if (value.commandLabel !== void 0 && typeof value.commandLabel !== "string") throw new Error(`Invalid commandLabel for ${id}`);
  if (value.evidenceId !== void 0 && typeof value.evidenceId !== "string") throw new Error(`Invalid evidenceId for ${id}`);
  if (value.required !== void 0 && typeof value.required !== "boolean") throw new Error(`Invalid required flag for ${id}`);
  return {
    id,
    status,
    commandLabel: value.commandLabel,
    evidenceId: value.evidenceId,
    required: value.required
  };
}
function parseEvidence(value) {
  if (!isRecord(value)) throw new Error("Invalid evidence item");
  const id = requiredString(value, "id");
  const kind = requiredString(value, "kind");
  const summary = requiredString(value, "summary");
  const artifactPath = value.artifactPath;
  if (artifactPath !== void 0 && (typeof artifactPath !== "string" || !isSafeRelativePath(artifactPath))) {
    throw new Error(`Unsafe artifact path for ${id}`);
  }
  return { id, kind, summary, artifactPath };
}
function parseApproval(value) {
  if (!isRecord(value)) throw new Error("Invalid approvals item");
  const id = requiredString(value, "id");
  const reviewer = requiredString(value, "reviewer");
  const status = value.status;
  if (status !== "approved" && status !== "changes_requested") throw new Error(`Invalid approval status for ${id}`);
  return { id, reviewer, status };
}
function parseManifest(text, policy = DEFAULT_POLICY) {
  if (text.length > policy.maxManifestCharacters) {
    throw new Error(`Manifest exceeds ${policy.maxManifestCharacters} characters`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Malformed JSON");
  }
  if (!isRecord(raw)) throw new Error("Manifest must be an object");
  if (raw.version !== "1") throw new Error("Unsupported manifest version");
  const repository = requiredString(raw, "repository");
  const title = requiredString(raw, "title");
  const pullRequestNumber = raw.pullRequestNumber;
  if (!Number.isInteger(pullRequestNumber) || Number(pullRequestNumber) <= 0) {
    throw new Error("Invalid pullRequestNumber");
  }
  const declaredScope = requiredArray(raw, "declaredScope").map((value) => {
    if (typeof value !== "string" || !isSafeScope(value)) throw new Error(`Unsafe declared scope: ${String(value)}`);
    return value;
  });
  if (declaredScope.length === 0) throw new Error("declaredScope must not be empty");
  const changedFiles = requiredArray(raw, "changedFiles").map(parseChangedFile);
  const checks = requiredArray(raw, "checks").map(parseCheck);
  const evidence = requiredArray(raw, "evidence").map(parseEvidence);
  const approvals = requiredArray(raw, "approvals").map(parseApproval);
  assertUniqueIds(checks, "check");
  assertUniqueIds(evidence, "evidence");
  assertUniqueIds(approvals, "approval");
  const authorType = raw.authorType;
  if (authorType !== "human" && authorType !== "automation" && authorType !== "unknown") {
    throw new Error("Invalid authorType");
  }
  const riskFlags = requiredArray(raw, "riskFlags").map((value) => {
    if (typeof value !== "string") throw new Error("Invalid riskFlags item");
    return value;
  });
  return {
    version: "1",
    repository,
    pullRequestNumber: Number(pullRequestNumber),
    title,
    declaredScope,
    changedFiles,
    checks,
    authorType,
    riskFlags,
    evidence,
    approvals
  };
}
function globToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}
function isInScope(path, scopes) {
  return scopes.some((scope) => globToRegExp(scope).test(path));
}
function approvedHumanReview(manifest) {
  return manifest.approvals.some((approval) => approval.status === "approved");
}
function evaluate(manifest, policy = DEFAULT_POLICY) {
  const findings = [];
  const evidenceIds = new Set(manifest.evidence.map((item) => item.id));
  const humanApproval = approvedHumanReview(manifest);
  for (const file of manifest.changedFiles) {
    if (!isInScope(file.path, manifest.declaredScope)) {
      findings.push({ ruleId: "PG001", decision: "BLOCKED", message: "Changed file is outside every declared scope.", subject: file.path });
    }
  }
  for (const check of manifest.checks.filter((item) => item.required !== false)) {
    if (check.status === "fail") {
      findings.push({ ruleId: "PG002", decision: "BLOCKED", message: "A required check failed.", subject: check.id });
    }
    if (check.status === "skipped") {
      findings.push({ ruleId: "PG003", decision: "REVIEW_REQUIRED", message: "A required check was skipped.", subject: check.id });
    }
    if (!check.evidenceId || !evidenceIds.has(check.evidenceId)) {
      findings.push({ ruleId: "PG005", decision: "BLOCKED", message: "A required check has no valid evidence reference.", subject: check.id });
    }
  }
  for (const file of manifest.changedFiles) {
    if (policy.riskyPathPatterns.some((pattern) => pattern.test(file.path)) && !humanApproval) {
      findings.push({ ruleId: "PG004", decision: "REVIEW_REQUIRED", message: "A risky path changed without approved human review.", subject: file.path });
    }
    if (file.binary || file.additions + file.deletions > policy.oversizedChangeLines) {
      findings.push({ ruleId: "PG006", decision: "REVIEW_REQUIRED", message: "A binary or oversized change requires human review.", subject: file.path });
    }
  }
  if ((manifest.authorType === "automation" || manifest.authorType === "unknown") && !humanApproval) {
    findings.push({ ruleId: "PG007", decision: "REVIEW_REQUIRED", message: "Automation or unknown authorship requires approved human review." });
  }
  let decision = "PASS";
  if (findings.some((finding) => finding.decision === "BLOCKED")) decision = "BLOCKED";
  else if (findings.some((finding) => finding.decision === "REVIEW_REQUIRED")) decision = "REVIEW_REQUIRED";
  if (findings.length === 0) {
    findings.push({ ruleId: "PG008", decision: "PASS", message: "All configured evidence requirements are satisfied." });
  }
  return { schemaVersion: "proofgate-evaluation/v1", decision, findings, manifest };
}
function jsonReceipt(evaluation) {
  return `${JSON.stringify(evaluation, null, 2)}
`;
}
function escapeMarkdown(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("`", "&#96;").replace(/[\r\n]+/g, " ");
}
function markdownReceipt(evaluation) {
  const findings = evaluation.findings.map((finding) => `- **${finding.ruleId} / ${finding.decision}:** ${finding.message}${finding.subject ? ` \`${escapeMarkdown(finding.subject)}\`` : ""}`).join("\n");
  return [
    "# AI PR Proof Gate receipt",
    "",
    `- **Repository:** \`${escapeMarkdown(evaluation.manifest.repository)}\``,
    `- **Pull request:** #${evaluation.manifest.pullRequestNumber}`,
    `- **Decision:** **${evaluation.decision}**`,
    "",
    "## Evidence trace",
    "",
    findings,
    ""
  ].join("\n");
}

// src/github.ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
var SHA = /^[0-9a-f]{40}$/i;
var REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
var MAX_EVENT_BYTES = 2 * 1024 * 1024;
var MAX_CONFIG_BYTES = 1e5;
var MAX_EVIDENCE_BYTES = 64e3;
var DEFAULT_AUTOMANIFEST_CONFIG = {
  declaredScope: ["**"],
  checks: [],
  evidence: [],
  riskFlags: [],
  approvals: []
};
var defaultGitRunner = (file, args, options) => execFileSync(file, [...args], options);
function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
function stringField(value, label, maxLength = 500) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
function safeScope(scope) {
  return isSafeRelativePath(scope.replaceAll("**", "x").replaceAll("*", "x"));
}
function safeWorkspaceFile(workspace, candidate) {
  if (!isSafeRelativePath(candidate)) throw new Error(`Unsafe evidenceFile: ${candidate}`);
  const root = realpathSync(workspace);
  const absolute = resolve(root, candidate);
  const relation = relative(root, absolute);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`Unsafe evidenceFile: ${candidate}`);
  }
  if (existsSync(absolute)) {
    const real = realpathSync(absolute);
    const realRelation = relative(root, real);
    if (realRelation === ".." || realRelation.startsWith(`..${sep}`) || isAbsolute(realRelation)) {
      throw new Error(`Evidence file leaves workspace: ${candidate}`);
    }
  }
  return absolute;
}
function parsePullRequestEvent(text, eventName = "pull_request") {
  if (eventName !== "pull_request") throw new Error(`Auto mode supports only pull_request events, received: ${eventName || "missing"}`);
  if (Buffer.byteLength(text, "utf8") > MAX_EVENT_BYTES) throw new Error("GitHub event exceeds 2 MiB");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Malformed GitHub event JSON");
  }
  const root = record(raw, "GitHub event");
  const pr = record(root.pull_request, "pull_request payload");
  const base = record(pr.base, "pull_request.base");
  const head = record(pr.head, "pull_request.head");
  const baseRepo = record(base.repo, "pull_request.base.repo");
  const headRepo = record(head.repo, "pull_request.head.repo");
  const baseSha = stringField(base.sha, "base SHA", 40);
  const headSha = stringField(head.sha, "head SHA", 40);
  if (!SHA.test(baseSha) || !SHA.test(headSha)) {
    throw new Error("Pull request base/head SHA must be exactly 40 hexadecimal characters");
  }
  const number = root.number;
  if (!Number.isInteger(number) || Number(number) <= 0) throw new Error("Invalid pull request number");
  const repository = stringField(record(root.repository, "repository").full_name, "repository.full_name", 200);
  if (!REPOSITORY.test(repository)) throw new Error("Invalid repository.full_name");
  const baseRepository = stringField(baseRepo.full_name, "base.repo.full_name", 200);
  const headRepository = stringField(headRepo.full_name, "head.repo.full_name", 200);
  const user = record(pr.user, "pull_request.user");
  const login = typeof user.login === "string" ? user.login : "";
  const authorType = user.type === "Bot" || login.endsWith("[bot]") ? "automation" : user.type === "User" ? "human" : "unknown";
  return {
    number: Number(number),
    repository,
    title: stringField(pr.title, "pull_request.title", 2e3),
    baseSha,
    headSha,
    fork: headRepository !== baseRepository,
    authorType
  };
}
function parseCount(value) {
  if (value === "-") return 0;
  if (!/^\d+$/.test(value)) throw new Error(`Invalid git numstat count: ${value}`);
  return Number.parseInt(value, 10);
}
function parseGitDiff(nameStatus, numstat) {
  const result = /* @__PURE__ */ new Map();
  const order = [];
  const nameTokens = nameStatus.split("\0");
  for (let index = 0; index < nameTokens.length; ) {
    const status = nameTokens[index++];
    if (!status) continue;
    const code = status[0];
    let path;
    if (code === "R" || code === "C") {
      index += 1;
      path = nameTokens[index++];
    } else {
      path = nameTokens[index++];
    }
    if (!path || !isSafeRelativePath(path)) throw new Error(`Unsafe git diff path: ${path ?? ""}`);
    if (!result.has(path)) order.push(path);
    result.set(path, { path, additions: 0, deletions: 0 });
  }
  const statTokens = numstat.split("\0");
  for (let index = 0; index < statTokens.length; ) {
    const header = statTokens[index++];
    if (!header) continue;
    const fields = header.split("	");
    if (fields.length !== 3) throw new Error(`Invalid git numstat record: ${header}`);
    const [additionsRaw, deletionsRaw, inlinePath] = fields;
    let path = inlinePath;
    if (path === "") {
      index += 1;
      path = statTokens[index++] ?? "";
    }
    if (!path || !isSafeRelativePath(path)) throw new Error(`Unsafe git numstat path: ${path}`);
    if (!result.has(path)) order.push(path);
    const file = result.get(path) ?? { path, additions: 0, deletions: 0 };
    file.additions = parseCount(additionsRaw);
    file.deletions = parseCount(deletionsRaw);
    if (additionsRaw === "-" || deletionsRaw === "-") file.binary = true;
    result.set(path, file);
  }
  return order.map((path) => result.get(path));
}
function collectGitDiff(event, cwd = process.cwd(), runner = defaultGitRunner) {
  if (!SHA.test(event.baseSha) || !SHA.test(event.headSha)) throw new Error("Refusing unvalidated git revision");
  const range = `${event.baseSha}...${event.headSha}`;
  const options = {
    cwd,
    encoding: "utf8",
    shell: false,
    maxBuffer: 10 * 1024 * 1024
  };
  const names = runner("git", ["diff", "--name-status", "-z", "--find-renames", range, "--"], options);
  const stats = runner("git", ["diff", "--numstat", "-z", "--find-renames", range, "--"], options);
  return parseGitDiff(names, stats);
}
function parseConfiguredChecks(raw) {
  const value = raw.requiredChecks;
  if (value === void 0) return [];
  if (!Array.isArray(value)) throw new Error("Invalid .proofgate.json requiredChecks");
  return value.map((item, index) => {
    const check = record(item, `requiredChecks[${index}]`);
    const id = stringField(check.id, `requiredChecks[${index}].id`, 100);
    const evidenceFile = stringField(check.evidenceFile, `requiredChecks[${index}].evidenceFile`, 500);
    if (!isSafeRelativePath(evidenceFile)) throw new Error(`Invalid evidenceFile for ${id}`);
    if (check.required !== void 0 && typeof check.required !== "boolean") throw new Error(`Invalid required flag for ${id}`);
    return { id, evidenceFile, required: check.required !== false };
  });
}
function evidenceForCheck(workspace, check) {
  const path = safeWorkspaceFile(workspace, check.evidenceFile);
  const evidenceId = `config-${check.id}`;
  if (!existsSync(path)) {
    return { check: { id: check.id, status: "skipped", required: check.required } };
  }
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > MAX_EVIDENCE_BYTES) throw new Error(`Invalid evidence file for ${check.id}`);
  const payload = record(JSON.parse(readFileSync(path, "utf8")), `evidence for ${check.id}`);
  const status = payload.status;
  if (status !== "pass" && status !== "fail" && status !== "skipped") throw new Error(`Invalid evidence status for ${check.id}`);
  const kind = payload.kind === void 0 ? "check-report" : stringField(payload.kind, `evidence kind for ${check.id}`, 100);
  const summary = stringField(payload.summary, `evidence summary for ${check.id}`, 500);
  return {
    check: { id: check.id, status, required: check.required, evidenceId },
    evidence: { id: evidenceId, kind, summary, artifactPath: check.evidenceFile }
  };
}
function loadProofGateConfig(workspace, configFile = ".proofgate.json") {
  const configPath = safeWorkspaceFile(workspace, configFile);
  if (!existsSync(configPath)) return structuredClone(DEFAULT_AUTOMANIFEST_CONFIG);
  const stats = statSync(configPath);
  if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) throw new Error("Invalid .proofgate.json file");
  const raw = record(JSON.parse(readFileSync(configPath, "utf8")), ".proofgate.json");
  if (raw.version !== 1) throw new Error("Unsupported .proofgate.json version");
  if (raw.approvals !== void 0) throw new Error("Static approvals are not permitted in .proofgate.json");
  const scopesValue = raw.declaredScope;
  const declaredScope = scopesValue === void 0 ? ["**"] : scopesValue;
  if (!Array.isArray(declaredScope) || declaredScope.length === 0 || declaredScope.some((item) => typeof item !== "string" || !safeScope(item))) {
    throw new Error("Invalid .proofgate.json declaredScope");
  }
  const riskFlagsValue = raw.riskFlags ?? [];
  if (!Array.isArray(riskFlagsValue) || riskFlagsValue.some((item) => typeof item !== "string")) {
    throw new Error("Invalid .proofgate.json riskFlags");
  }
  const resolved = parseConfiguredChecks(raw).map((check) => evidenceForCheck(workspace, check));
  return {
    declaredScope,
    checks: resolved.map((item) => item.check),
    evidence: resolved.flatMap((item) => item.evidence ? [item.evidence] : []),
    riskFlags: riskFlagsValue,
    approvals: []
  };
}
function autoManifestFromEvent(event, changedFiles, config = DEFAULT_AUTOMANIFEST_CONFIG) {
  return {
    version: "1",
    repository: event.repository,
    pullRequestNumber: event.number,
    title: event.title,
    declaredScope: config.declaredScope,
    changedFiles,
    checks: config.checks,
    authorType: event.authorType,
    riskFlags: [.../* @__PURE__ */ new Set([...config.riskFlags, ...event.fork ? ["fork-pull-request"] : []])],
    evidence: config.evidence,
    approvals: config.approvals
  };
}
function escapeWorkflowCommand(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
function escapeWorkflowProperty(value) {
  return escapeWorkflowCommand(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}
function workflowAnnotation(finding) {
  const level = finding.decision === "BLOCKED" ? "error" : finding.decision === "REVIEW_REQUIRED" ? "warning" : "notice";
  const properties = [finding.subject ? `file=${escapeWorkflowProperty(finding.subject)}` : "", `title=${escapeWorkflowProperty(finding.ruleId)}`].filter(Boolean).join(",");
  return `::${level} ${properties}::${escapeWorkflowCommand(finding.message)}`;
}

// src/action.ts
function assertInsideRoot(root, candidate, label) {
  const relation = relative2(root, candidate);
  if (relation === ".." || relation.startsWith(`..${sep2}`) || isAbsolute2(relation)) {
    throw new Error(`${label} leaves GITHUB_WORKSPACE`);
  }
}
function insideWorkspace(workspace, candidate) {
  const root = realpathSync2(workspace);
  const absolute = resolve2(root, candidate);
  assertInsideRoot(root, absolute, `Path ${candidate}`);
  let existingAncestor = absolute;
  while (!existsSync2(existingAncestor) && dirname(existingAncestor) !== existingAncestor) {
    existingAncestor = dirname(existingAncestor);
  }
  assertInsideRoot(root, realpathSync2(existingAncestor), `Resolved path ${candidate}`);
  if (existsSync2(absolute)) assertInsideRoot(root, realpathSync2(absolute), `Resolved path ${candidate}`);
  return absolute;
}
function ensureOutputDirectory(workspace, candidate) {
  const directory = insideWorkspace(workspace, candidate);
  mkdirSync(directory, { recursive: true });
  return insideWorkspace(workspace, candidate);
}
function appendTrustedFile(path, value) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, value, "utf8");
}
function manualEvaluation(workspace, manifestInput) {
  const manifestPath = insideWorkspace(workspace, manifestInput);
  const stats = statSync2(manifestPath);
  if (!stats.isFile()) throw new Error("Manifest path must be a regular file");
  return evaluate(parseManifest(readFileSync2(manifestPath, "utf8")));
}
function automaticEvaluation(workspace, reportDirectory, environment) {
  const eventPath = environment.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required in auto mode");
  const eventStats = statSync2(eventPath);
  if (!eventStats.isFile() || eventStats.size > 2 * 1024 * 1024) throw new Error("Invalid GITHUB_EVENT_PATH file");
  const event = parsePullRequestEvent(
    readFileSync2(eventPath, "utf8"),
    environment.GITHUB_EVENT_NAME ?? ""
  );
  const configInput = environment.INPUT_CONFIG || ".proofgate.json";
  const config = loadProofGateConfig(workspace, configInput);
  const manifest = autoManifestFromEvent(event, collectGitDiff(event, workspace), config);
  writeFileSync(
    resolve2(reportDirectory, "proofgate-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}
`,
    "utf8"
  );
  return evaluate(manifest);
}
function runAction(environment = process.env) {
  try {
    const workspace = environment.GITHUB_WORKSPACE || process.cwd();
    const reportInput = environment["INPUT_REPORT-DIR"] || ".proofgate";
    const reportDirectory = ensureOutputDirectory(workspace, reportInput);
    const manifestInput = environment.INPUT_MANIFEST || "proofgate-manifest.json";
    const autoMode = environment.INPUT_MODE === "auto" || manifestInput === "auto";
    const evaluation = autoMode ? automaticEvaluation(workspace, reportDirectory, environment) : manualEvaluation(workspace, manifestInput);
    const jsonPath = resolve2(reportDirectory, "proofgate-report.json");
    const markdownPath = resolve2(reportDirectory, "proofgate-report.md");
    const json = jsonReceipt(evaluation);
    const markdown = markdownReceipt(evaluation);
    writeFileSync(jsonPath, json, "utf8");
    writeFileSync(markdownPath, markdown, "utf8");
    for (const finding of evaluation.findings) {
      process.stdout.write(`${workflowAnnotation(finding)}
`);
    }
    appendTrustedFile(
      environment.GITHUB_OUTPUT,
      [
        `decision=${evaluation.decision}`,
        `report-json=${relative2(workspace, jsonPath)}`,
        autoMode ? `manifest-json=${relative2(workspace, resolve2(reportDirectory, "proofgate-manifest.json"))}` : "manifest-json=",
        ""
      ].join("\n")
    );
    appendTrustedFile(environment.GITHUB_STEP_SUMMARY, markdown);
    process.stdout.write(`AI PR Proof Gate: ${evaluation.decision}
`);
    return evaluation.decision === "PASS" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`AI PR Proof Gate failed closed: ${error instanceof Error ? error.message : "unknown error"}
`);
    return 2;
  }
}
process.exitCode = runAction();
export {
  runAction
};
