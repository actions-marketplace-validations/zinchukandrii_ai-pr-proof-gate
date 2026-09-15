export type Decision = 'PASS' | 'REVIEW_REQUIRED' | 'BLOCKED';
export type CheckStatus = 'pass' | 'fail' | 'skipped';
export type AuthorType = 'human' | 'automation' | 'unknown';

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  binary?: boolean;
}

export interface CheckEvidence {
  id: string;
  status: CheckStatus;
  commandLabel?: string;
  evidenceId?: string;
  required?: boolean;
}

export interface EvidenceItem {
  id: string;
  kind: string;
  summary: string;
  artifactPath?: string;
}

export interface Approval {
  id: string;
  reviewer: string;
  status: 'approved' | 'changes_requested';
}

export interface Manifest {
  version: '1';
  repository: string;
  pullRequestNumber: number;
  title: string;
  declaredScope: string[];
  changedFiles: ChangedFile[];
  checks: CheckEvidence[];
  authorType: AuthorType;
  riskFlags: string[];
  evidence: EvidenceItem[];
  approvals: Approval[];
}

export interface Finding {
  ruleId: `PG00${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
  decision: Decision;
  message: string;
  subject?: string;
}

export interface Evaluation {
  schemaVersion: 'proofgate-evaluation/v1';
  decision: Decision;
  findings: Finding[];
  manifest: Manifest;
}

export interface EvaluationPolicy {
  maxManifestCharacters: number;
  oversizedChangeLines: number;
  riskyPathPatterns: RegExp[];
}

export const DEFAULT_POLICY: EvaluationPolicy = {
  maxManifestCharacters: 200_000,
  oversizedChangeLines: 1_000,
  riskyPathPatterns: [
    /^\.github\/workflows\//i,
    /(^|\/)auth([/.]|$)/i,
    /(^|\/)permissions?([/.]|$)/i,
    /(^|\/)migrations?([/.]|$)/i,
    /(^|\/)security([/.]|$)/i,
    /(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/i,
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}

function requiredArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`Invalid ${key}`);
  return value;
}

function assertUniqueIds(items: { id: string }[], label: string): void {
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label} IDs`);
}

export function isSafeRelativePath(path: string): boolean {
  if (!path || path.includes('\\') || path.includes('\0')) return false;
  if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) return false;
  const segments = path.split('/');
  return !segments.some((segment) => segment === '..' || segment === '');
}

function isSafeScope(scope: string): boolean {
  const withoutGlobs = scope.replaceAll('**', 'x').replaceAll('*', 'x');
  return isSafeRelativePath(withoutGlobs);
}

function parseChangedFile(value: unknown): ChangedFile {
  if (!isRecord(value)) throw new Error('Invalid changedFiles item');
  const path = requiredString(value, 'path');
  const additions = value.additions;
  const deletions = value.deletions;
  if (!isSafeRelativePath(path)) throw new Error(`Unsafe changed file path: ${path}`);
  if (!Number.isInteger(additions) || Number(additions) < 0) throw new Error(`Invalid additions for ${path}`);
  if (!Number.isInteger(deletions) || Number(deletions) < 0) throw new Error(`Invalid deletions for ${path}`);
  if (value.binary !== undefined && typeof value.binary !== 'boolean') throw new Error(`Invalid binary flag for ${path}`);
  return { path, additions: Number(additions), deletions: Number(deletions), binary: value.binary as boolean | undefined };
}

function parseCheck(value: unknown): CheckEvidence {
  if (!isRecord(value)) throw new Error('Invalid checks item');
  const id = requiredString(value, 'id');
  const status = value.status;
  if (status !== 'pass' && status !== 'fail' && status !== 'skipped') throw new Error(`Unknown check status: ${String(status)}`);
  if (value.commandLabel !== undefined && typeof value.commandLabel !== 'string') throw new Error(`Invalid commandLabel for ${id}`);
  if (value.evidenceId !== undefined && typeof value.evidenceId !== 'string') throw new Error(`Invalid evidenceId for ${id}`);
  if (value.required !== undefined && typeof value.required !== 'boolean') throw new Error(`Invalid required flag for ${id}`);
  return {
    id,
    status,
    commandLabel: value.commandLabel as string | undefined,
    evidenceId: value.evidenceId as string | undefined,
    required: value.required as boolean | undefined,
  };
}

function parseEvidence(value: unknown): EvidenceItem {
  if (!isRecord(value)) throw new Error('Invalid evidence item');
  const id = requiredString(value, 'id');
  const kind = requiredString(value, 'kind');
  const summary = requiredString(value, 'summary');
  const artifactPath = value.artifactPath;
  if (artifactPath !== undefined && (typeof artifactPath !== 'string' || !isSafeRelativePath(artifactPath))) {
    throw new Error(`Unsafe artifact path for ${id}`);
  }
  return { id, kind, summary, artifactPath: artifactPath as string | undefined };
}

function parseApproval(value: unknown): Approval {
  if (!isRecord(value)) throw new Error('Invalid approvals item');
  const id = requiredString(value, 'id');
  const reviewer = requiredString(value, 'reviewer');
  const status = value.status;
  if (status !== 'approved' && status !== 'changes_requested') throw new Error(`Invalid approval status for ${id}`);
  return { id, reviewer, status };
}

export function parseManifest(text: string, policy = DEFAULT_POLICY): Manifest {
  if (text.length > policy.maxManifestCharacters) {
    throw new Error(`Manifest exceeds ${policy.maxManifestCharacters} characters`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Malformed JSON');
  }
  if (!isRecord(raw)) throw new Error('Manifest must be an object');
  if (raw.version !== '1') throw new Error('Unsupported manifest version');

  const repository = requiredString(raw, 'repository');
  const title = requiredString(raw, 'title');
  const pullRequestNumber = raw.pullRequestNumber;
  if (!Number.isInteger(pullRequestNumber) || Number(pullRequestNumber) <= 0) {
    throw new Error('Invalid pullRequestNumber');
  }

  const declaredScope = requiredArray(raw, 'declaredScope').map((value) => {
    if (typeof value !== 'string' || !isSafeScope(value)) throw new Error(`Unsafe declared scope: ${String(value)}`);
    return value;
  });
  if (declaredScope.length === 0) throw new Error('declaredScope must not be empty');

  const changedFiles = requiredArray(raw, 'changedFiles').map(parseChangedFile);
  const checks = requiredArray(raw, 'checks').map(parseCheck);
  const evidence = requiredArray(raw, 'evidence').map(parseEvidence);
  const approvals = requiredArray(raw, 'approvals').map(parseApproval);
  assertUniqueIds(checks, 'check');
  assertUniqueIds(evidence, 'evidence');
  assertUniqueIds(approvals, 'approval');

  const authorType = raw.authorType;
  if (authorType !== 'human' && authorType !== 'automation' && authorType !== 'unknown') {
    throw new Error('Invalid authorType');
  }

  const riskFlags = requiredArray(raw, 'riskFlags').map((value) => {
    if (typeof value !== 'string') throw new Error('Invalid riskFlags item');
    return value;
  });

  return {
    version: '1',
    repository,
    pullRequestNumber: Number(pullRequestNumber),
    title,
    declaredScope,
    changedFiles,
    checks,
    authorType,
    riskFlags,
    evidence,
    approvals,
  };
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function isInScope(path: string, scopes: string[]): boolean {
  return scopes.some((scope) => globToRegExp(scope).test(path));
}

function approvedHumanReview(manifest: Manifest): boolean {
  return manifest.approvals.some((approval) => approval.status === 'approved');
}

export function evaluate(manifest: Manifest, policy = DEFAULT_POLICY): Evaluation {
  const findings: Finding[] = [];
  const evidenceIds = new Set(manifest.evidence.map((item) => item.id));
  const humanApproval = approvedHumanReview(manifest);

  for (const file of manifest.changedFiles) {
    if (!isInScope(file.path, manifest.declaredScope)) {
      findings.push({ ruleId: 'PG001', decision: 'BLOCKED', message: 'Changed file is outside every declared scope.', subject: file.path });
    }
  }

  for (const check of manifest.checks.filter((item) => item.required !== false)) {
    if (check.status === 'fail') {
      findings.push({ ruleId: 'PG002', decision: 'BLOCKED', message: 'A required check failed.', subject: check.id });
    }
    if (check.status === 'skipped') {
      findings.push({ ruleId: 'PG003', decision: 'REVIEW_REQUIRED', message: 'A required check was skipped.', subject: check.id });
    }
    if (!check.evidenceId || !evidenceIds.has(check.evidenceId)) {
      findings.push({ ruleId: 'PG005', decision: 'BLOCKED', message: 'A required check has no valid evidence reference.', subject: check.id });
    }
  }

  for (const file of manifest.changedFiles) {
    if (policy.riskyPathPatterns.some((pattern) => pattern.test(file.path)) && !humanApproval) {
      findings.push({ ruleId: 'PG004', decision: 'REVIEW_REQUIRED', message: 'A risky path changed without approved human review.', subject: file.path });
    }
    if (file.binary || file.additions + file.deletions > policy.oversizedChangeLines) {
      findings.push({ ruleId: 'PG006', decision: 'REVIEW_REQUIRED', message: 'A binary or oversized change requires human review.', subject: file.path });
    }
  }

  if ((manifest.authorType === 'automation' || manifest.authorType === 'unknown') && !humanApproval) {
    findings.push({ ruleId: 'PG007', decision: 'REVIEW_REQUIRED', message: 'Automation or unknown authorship requires approved human review.' });
  }

  let decision: Decision = 'PASS';
  if (findings.some((finding) => finding.decision === 'BLOCKED')) decision = 'BLOCKED';
  else if (findings.some((finding) => finding.decision === 'REVIEW_REQUIRED')) decision = 'REVIEW_REQUIRED';

  if (findings.length === 0) {
    findings.push({ ruleId: 'PG008', decision: 'PASS', message: 'All configured evidence requirements are satisfied.' });
  }

  return { schemaVersion: 'proofgate-evaluation/v1', decision, findings, manifest };
}

export function jsonReceipt(evaluation: Evaluation): string {
  return `${JSON.stringify(evaluation, null, 2)}\n`;
}

function escapeMarkdown(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('`', '&#96;')
    .replace(/[\r\n]+/g, ' ');
}

export function markdownReceipt(evaluation: Evaluation): string {
  const findings = evaluation.findings
    .map((finding) => `- **${finding.ruleId} / ${finding.decision}:** ${finding.message}${finding.subject ? ` \`${escapeMarkdown(finding.subject)}\`` : ''}`)
    .join('\n');
  return [
    '# AI PR Proof Gate receipt',
    '',
    `- **Repository:** \`${escapeMarkdown(evaluation.manifest.repository)}\``,
    `- **Pull request:** #${evaluation.manifest.pullRequestNumber}`,
    `- **Decision:** **${evaluation.decision}**`,
    '',
    '## Evidence trace',
    '',
    findings,
    '',
  ].join('\n');
}
