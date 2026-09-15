import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Approval, AuthorType, ChangedFile, CheckEvidence, EvidenceItem, Finding, Manifest } from './evaluator';
import { isSafeRelativePath } from './evaluator';

const SHA = /^[0-9a-f]{40}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_CONFIG_BYTES = 100_000;
const MAX_EVIDENCE_BYTES = 64_000;

export interface PullRequestEvent {
  number: number;
  repository: string;
  title: string;
  baseSha: string;
  headSha: string;
  fork: boolean;
  authorType: AuthorType;
}

export interface ResolvedProofGateConfig {
  declaredScope: string[];
  checks: CheckEvidence[];
  evidence: EvidenceItem[];
  riskFlags: string[];
  approvals: Approval[];
}

interface ConfiguredCheck {
  id: string;
  evidenceFile: string;
  required: boolean;
}

export const DEFAULT_AUTOMANIFEST_CONFIG: ResolvedProofGateConfig = {
  declaredScope: ['**'],
  checks: [],
  evidence: [],
  riskFlags: [],
  approvals: [],
};

export type GitRunner = (
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string;

const defaultGitRunner: GitRunner = (file, args, options) => execFileSync(file, [...args], options);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string, maxLength = 500): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function safeScope(scope: string): boolean {
  return isSafeRelativePath(scope.replaceAll('**', 'x').replaceAll('*', 'x'));
}

function safeWorkspaceFile(workspace: string, candidate: string): string {
  if (!isSafeRelativePath(candidate)) throw new Error(`Unsafe evidenceFile: ${candidate}`);
  const root = realpathSync(workspace);
  const absolute = resolve(root, candidate);
  const relation = relative(root, absolute);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`Unsafe evidenceFile: ${candidate}`);
  }
  if (existsSync(absolute)) {
    const real = realpathSync(absolute);
    const realRelation = relative(root, real);
    if (realRelation === '..' || realRelation.startsWith(`..${sep}`) || isAbsolute(realRelation)) {
      throw new Error(`Evidence file leaves workspace: ${candidate}`);
    }
  }
  return absolute;
}

export function parsePullRequestEvent(text: string, eventName = 'pull_request'): PullRequestEvent {
  if (eventName !== 'pull_request') throw new Error(`Auto mode supports only pull_request events, received: ${eventName || 'missing'}`);
  if (Buffer.byteLength(text, 'utf8') > MAX_EVENT_BYTES) throw new Error('GitHub event exceeds 2 MiB');

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Malformed GitHub event JSON');
  }

  const root = record(raw, 'GitHub event');
  const pr = record(root.pull_request, 'pull_request payload');
  const base = record(pr.base, 'pull_request.base');
  const head = record(pr.head, 'pull_request.head');
  const baseRepo = record(base.repo, 'pull_request.base.repo');
  const headRepo = record(head.repo, 'pull_request.head.repo');
  const baseSha = stringField(base.sha, 'base SHA', 40);
  const headSha = stringField(head.sha, 'head SHA', 40);
  if (!SHA.test(baseSha) || !SHA.test(headSha)) {
    throw new Error('Pull request base/head SHA must be exactly 40 hexadecimal characters');
  }

  const number = root.number;
  if (!Number.isInteger(number) || Number(number) <= 0) throw new Error('Invalid pull request number');
  const repository = stringField(record(root.repository, 'repository').full_name, 'repository.full_name', 200);
  if (!REPOSITORY.test(repository)) throw new Error('Invalid repository.full_name');

  const baseRepository = stringField(baseRepo.full_name, 'base.repo.full_name', 200);
  const headRepository = stringField(headRepo.full_name, 'head.repo.full_name', 200);
  const user = record(pr.user, 'pull_request.user');
  const login = typeof user.login === 'string' ? user.login : '';
  const authorType: AuthorType = user.type === 'Bot' || login.endsWith('[bot]')
    ? 'automation'
    : user.type === 'User'
      ? 'human'
      : 'unknown';

  return {
    number: Number(number),
    repository,
    title: stringField(pr.title, 'pull_request.title', 2_000),
    baseSha,
    headSha,
    fork: headRepository !== baseRepository,
    authorType,
  };
}

function parseCount(value: string): number {
  if (value === '-') return 0;
  if (!/^\d+$/.test(value)) throw new Error(`Invalid git numstat count: ${value}`);
  return Number.parseInt(value, 10);
}

export function parseGitDiff(nameStatus: string, numstat: string): ChangedFile[] {
  const result = new Map<string, ChangedFile>();
  const order: string[] = [];
  const nameTokens = nameStatus.split('\0');

  for (let index = 0; index < nameTokens.length;) {
    const status = nameTokens[index++];
    if (!status) continue;
    const code = status[0];
    let path: string | undefined;
    if (code === 'R' || code === 'C') {
      index += 1; // old path
      path = nameTokens[index++];
    } else {
      path = nameTokens[index++];
    }
    if (!path || !isSafeRelativePath(path)) throw new Error(`Unsafe git diff path: ${path ?? ''}`);
    if (!result.has(path)) order.push(path);
    result.set(path, { path, additions: 0, deletions: 0 });
  }

  const statTokens = numstat.split('\0');
  for (let index = 0; index < statTokens.length;) {
    const header = statTokens[index++];
    if (!header) continue;
    const fields = header.split('\t');
    if (fields.length !== 3) throw new Error(`Invalid git numstat record: ${header}`);
    const [additionsRaw, deletionsRaw, inlinePath] = fields;
    let path = inlinePath;
    if (path === '') {
      index += 1; // old path for rename/copy
      path = statTokens[index++] ?? '';
    }
    if (!path || !isSafeRelativePath(path)) throw new Error(`Unsafe git numstat path: ${path}`);
    if (!result.has(path)) order.push(path);
    const file = result.get(path) ?? { path, additions: 0, deletions: 0 };
    file.additions = parseCount(additionsRaw);
    file.deletions = parseCount(deletionsRaw);
    if (additionsRaw === '-' || deletionsRaw === '-') file.binary = true;
    result.set(path, file);
  }

  return order.map((path) => result.get(path) as ChangedFile);
}

export function collectGitDiff(
  event: PullRequestEvent,
  cwd = process.cwd(),
  runner: GitRunner = defaultGitRunner,
): ChangedFile[] {
  if (!SHA.test(event.baseSha) || !SHA.test(event.headSha)) throw new Error('Refusing unvalidated git revision');
  const range = `${event.baseSha}...${event.headSha}`;
  const options: ExecFileSyncOptionsWithStringEncoding = {
    cwd,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 10 * 1024 * 1024,
  };
  const names = runner('git', ['diff', '--name-status', '-z', '--find-renames', range, '--'], options);
  const stats = runner('git', ['diff', '--numstat', '-z', '--find-renames', range, '--'], options);
  return parseGitDiff(names, stats);
}

function parseConfiguredChecks(raw: Record<string, unknown>): ConfiguredCheck[] {
  const value = raw.requiredChecks;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid .proofgate.json requiredChecks');
  return value.map((item, index) => {
    const check = record(item, `requiredChecks[${index}]`);
    const id = stringField(check.id, `requiredChecks[${index}].id`, 100);
    const evidenceFile = stringField(check.evidenceFile, `requiredChecks[${index}].evidenceFile`, 500);
    if (!isSafeRelativePath(evidenceFile)) throw new Error(`Invalid evidenceFile for ${id}`);
    if (check.required !== undefined && typeof check.required !== 'boolean') throw new Error(`Invalid required flag for ${id}`);
    return { id, evidenceFile, required: check.required !== false };
  });
}

function evidenceForCheck(workspace: string, check: ConfiguredCheck): { check: CheckEvidence; evidence?: EvidenceItem } {
  const path = safeWorkspaceFile(workspace, check.evidenceFile);
  const evidenceId = `config-${check.id}`;
  if (!existsSync(path)) {
    return { check: { id: check.id, status: 'skipped', required: check.required } };
  }
  const stats = statSync(path);
  if (!stats.isFile() || stats.size > MAX_EVIDENCE_BYTES) throw new Error(`Invalid evidence file for ${check.id}`);
  const payload = record(JSON.parse(readFileSync(path, 'utf8')), `evidence for ${check.id}`);
  const status = payload.status;
  if (status !== 'pass' && status !== 'fail' && status !== 'skipped') throw new Error(`Invalid evidence status for ${check.id}`);
  const kind = payload.kind === undefined ? 'check-report' : stringField(payload.kind, `evidence kind for ${check.id}`, 100);
  const summary = stringField(payload.summary, `evidence summary for ${check.id}`, 500);
  return {
    check: { id: check.id, status, required: check.required, evidenceId },
    evidence: { id: evidenceId, kind, summary, artifactPath: check.evidenceFile },
  };
}

export function loadProofGateConfig(workspace: string, configFile = '.proofgate.json'): ResolvedProofGateConfig {
  const configPath = safeWorkspaceFile(workspace, configFile);
  if (!existsSync(configPath)) return structuredClone(DEFAULT_AUTOMANIFEST_CONFIG);
  const stats = statSync(configPath);
  if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) throw new Error('Invalid .proofgate.json file');
  const raw = record(JSON.parse(readFileSync(configPath, 'utf8')), '.proofgate.json');
  if (raw.version !== 1) throw new Error('Unsupported .proofgate.json version');
  if (raw.approvals !== undefined) throw new Error('Static approvals are not permitted in .proofgate.json');

  const scopesValue = raw.declaredScope;
  const declaredScope = scopesValue === undefined ? ['**'] : scopesValue;
  if (!Array.isArray(declaredScope) || declaredScope.length === 0 || declaredScope.some((item) => typeof item !== 'string' || !safeScope(item))) {
    throw new Error('Invalid .proofgate.json declaredScope');
  }
  const riskFlagsValue = raw.riskFlags ?? [];
  if (!Array.isArray(riskFlagsValue) || riskFlagsValue.some((item) => typeof item !== 'string')) {
    throw new Error('Invalid .proofgate.json riskFlags');
  }

  const resolved = parseConfiguredChecks(raw).map((check) => evidenceForCheck(workspace, check));
  return {
    declaredScope: declaredScope as string[],
    checks: resolved.map((item) => item.check),
    evidence: resolved.flatMap((item) => item.evidence ? [item.evidence] : []),
    riskFlags: riskFlagsValue as string[],
    approvals: [],
  };
}

export function autoManifestFromEvent(
  event: PullRequestEvent,
  changedFiles: ChangedFile[],
  config: ResolvedProofGateConfig = DEFAULT_AUTOMANIFEST_CONFIG,
): Manifest {
  return {
    version: '1',
    repository: event.repository,
    pullRequestNumber: event.number,
    title: event.title,
    declaredScope: config.declaredScope,
    changedFiles,
    checks: config.checks,
    authorType: event.authorType,
    riskFlags: [...new Set([...config.riskFlags, ...(event.fork ? ['fork-pull-request'] : [])])],
    evidence: config.evidence,
    approvals: config.approvals,
  };
}

export function escapeWorkflowCommand(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeWorkflowProperty(value: string): string {
  return escapeWorkflowCommand(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

export function workflowAnnotation(finding: Finding): string {
  const level = finding.decision === 'BLOCKED' ? 'error' : finding.decision === 'REVIEW_REQUIRED' ? 'warning' : 'notice';
  const properties = [finding.subject ? `file=${escapeWorkflowProperty(finding.subject)}` : '', `title=${escapeWorkflowProperty(finding.ruleId)}`]
    .filter(Boolean)
    .join(',');
  return `::${level} ${properties}::${escapeWorkflowCommand(finding.message)}`;
}
